/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { BaseDevice } from './BaseDevice.js';
import * as Helper from '../helper.js';

const {exitCode, fileExists, readFile, readFileInt, runCommandCtl, findValidProgramInPath} = Helper;

export const GenericSysfsDevice = GObject.registerClass({
    GTypeName: 'UPMGenericSysfsDevice',
}, class GenericSysfsDevice extends BaseDevice {
    /**
     * @param {string} batteryName - The battery identifier (e.g., 'BAT0', 'BAT1')
     */
    constructor(batteryName = 'BAT0') {
        super();
        this.name = `Generic Sysfs Device (${batteryName})`;
        this.batteryName = batteryName;
        
        // Initialize paths based on battery name
        this.endPath = `/sys/class/power_supply/${batteryName}/charge_control_end_threshold`;
        this.startPath = `/sys/class/power_supply/${batteryName}/charge_control_start_threshold`;
        this.capacityPath = `/sys/class/power_supply/${batteryName}/capacity`;
        this.forceDischargePath = `/sys/class/power_supply/${batteryName}/charge_behaviour`;
        
        this.ctlPath = null;
        this.endLimitValue = -1;
        this.startLimitValue = -1;
        this._monitorLevel = null;
        this._monitorLevelId = null;
        this._supportsForceDischarge = false;
        this._forceDischargeEnabled = false;
        this._missingHelper = false;
        this._writeInProgress = false;
        this._writeInProgressTimeout = null;
    }

    async initialize() {
        // Check if battery threshold control files exist
        // We require at least the end threshold for support
        if (!fileExists(this.endPath)) {
            return false;
        }

        this._hasStartThreshold = fileExists(this.startPath);

        // Find the helper script
        this.ctlPath = findValidProgramInPath('unified-power-ctl');
        
        if (!this.ctlPath) {
            console.log('Unified Power Manager: unified-power-ctl helper not found, battery control will be read-only');
            this._missingHelper = true;
        } else {
            this._missingHelper = false;
        }

        // Check force discharge support
        this._supportsForceDischarge = fileExists(this.forceDischargePath);

        // Read current values
        this.refreshValues();

        // Set up file monitoring for external changes
        this._initializeMonitoring();

        return true;
    }

    /**
     * Check if a specific battery is supported
     * @param {string} batteryName - e.g. 'BAT0', 'BAT1'
     */
    static isSupported(batteryName = 'BAT0') {
        // Check if standard Linux battery threshold files exist
        // We require at least end thresholds for minimal support
        const endPath = `/sys/class/power_supply/${batteryName}/charge_control_end_threshold`;
        return fileExists(endPath);
    }

    _initializeMonitoring() {
        if (this._monitorLevel) return;

        // Monitor end threshold for external changes
        const endThresholdFile = Gio.File.new_for_path(this.endPath);
        this._monitorLevel = endThresholdFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorLevelId = this._monitorLevel.connect('changed', (obj, theFile, otherFile, eventType) => {
            // Skip monitor events during our own writes to avoid duplicate signals
            if (this._writeInProgress)
                return;

            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                const newEnd = readFileInt(this.endPath);
                let newStart = this.startLimitValue;

                if (this._hasStartThreshold) {
                    newStart = readFileInt(this.startPath);
                }

                if (newEnd !== null && (newEnd !== this.endLimitValue || (this._hasStartThreshold && newStart !== this.startLimitValue))) {
                    this.endLimitValue = newEnd;
                    if (this._hasStartThreshold && newStart !== null) {
                        this.startLimitValue = newStart;
                    }
                    this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
                }
            }
        });
    }

    getThresholds() {
        return {
            start: this.startLimitValue,
            end: this.endLimitValue
        };
    }

    async setThresholds(startValue, endValue) {
        if (this._missingHelper)
            return false;

        // Validate thresholds
        if (startValue < 0 || startValue > 100 || endValue < 0 || endValue > 100)
            return false;

        if (this._hasStartThreshold && startValue >= endValue)
            return false;

        // Suppress file monitor events during write
        this._writeInProgress = true;
        if (this._writeInProgressTimeout) {
            GLib.Source.remove(this._writeInProgressTimeout);
            this._writeInProgressTimeout = null;
        }

        let status;

        try {
            if (this._hasStartThreshold) {
                // Determine the correct order for writing thresholds
                // If increasing, write END first; if decreasing, write START first
                const cmd = startValue >= this.endLimitValue ? `${this.batteryName}_END_START` : `${this.batteryName}_START_END`;
                [status] = await runCommandCtl(this.ctlPath, cmd, `${endValue}`, `${startValue}`);
            } else {
                // Only set end threshold
                [status] = await runCommandCtl(this.ctlPath, `${this.batteryName}_END`, `${endValue}`);
            }

            if (status === exitCode.SUCCESS) {
                this.endLimitValue = readFileInt(this.endPath) || endValue;
                if (this._hasStartThreshold) {
                    this.startLimitValue = readFileInt(this.startPath) || startValue;
                }
                this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
                return true;
            } else if (status === exitCode.PRIVILEGE_REQUIRED) {
                console.error('Unified Power Manager: Privilege required - polkit rules may not be configured. Run install-helper.sh');
            }

            return false;
        } finally {
            // Clear write-in-progress flag after a short delay to ensure
            // file monitor events triggered by our write are ignored
            this._writeInProgressTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._writeInProgress = false;
                this._writeInProgressTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    getForceDischarge() {
        return this._forceDischargeEnabled;
    }

    async setForceDischarge(enabled) {
        if (!this._supportsForceDischarge || this._missingHelper)
            return false;

        const mode = enabled ? 'force-discharge' : 'auto';
        const [status] = await runCommandCtl(this.ctlPath, `FORCE_DISCHARGE_${this.batteryName}`, mode);

        if (status === exitCode.SUCCESS) {
            this._forceDischargeEnabled = enabled;
            this.emit('force-discharge-changed', enabled);
            return true;
        }

        return false;
    }

    get needsHelper() {
        return this._missingHelper;
    }

    get supportsForceDischarge() {
        return this._supportsForceDischarge;
    }

    get hasStartThreshold() {
        return this._hasStartThreshold;
    }

    getBatteryLevel() {
        return readFileInt(this.capacityPath) || 0;
    }

    refreshValues() {
        this.endLimitValue = readFileInt(this.endPath) || 100;
        
        if (this._hasStartThreshold) {
            this.startLimitValue = readFileInt(this.startPath) || 95;
        } else {
            this.startLimitValue = 0;
        }

        if (this._supportsForceDischarge) {
            const behaviour = readFile(this.forceDischargePath);
            this._forceDischargeEnabled = behaviour && behaviour.includes('[force-discharge]');
        }
    }

    destroy() {
        if (this._writeInProgressTimeout) {
            GLib.Source.remove(this._writeInProgressTimeout);
            this._writeInProgressTimeout = null;
        }
        if (this._monitorLevelId && this._monitorLevel) {
            this._monitorLevel.disconnect(this._monitorLevelId);
            this._monitorLevelId = null;
        }
        if (this._monitorLevel) {
            this._monitorLevel.cancel();
            this._monitorLevel = null;
        }
    }
});