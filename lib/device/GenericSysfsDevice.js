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
import * as Constants from '../constants.js';

const {exitCode, fileExists, readFile, readFileInt, readFileAsync, readFileIntAsync, runCommandCtl, findValidProgramInPath} = Helper;

export const GenericSysfsDevice = GObject.registerClass({
    GTypeName: 'UPMGenericSysfsDevice',
}, class GenericSysfsDevice extends BaseDevice {
    /**
     * @param {string} batteryPath - The full path to the battery sysfs directory (e.g., '/sys/class/power_supply/BAT0')
     */
    constructor(batteryPath) {
        super();
        this._sysfsPath = batteryPath;
        const batteryName = batteryPath.split('/').pop();
        this.name = `Generic Sysfs Device (${batteryName})`;
        this.batteryName = batteryName;
        
        // Initialize paths based on provided path
        this.endPath = `${batteryPath}/${Constants.THRESHOLD_END_FILE}`;
        this.startPath = `${batteryPath}/${Constants.THRESHOLD_START_FILE}`;
        this.capacityPath = `${batteryPath}/${Constants.CAPACITY_FILE}`;
        this.forceDischargePath = `${batteryPath}/${Constants.BEHAVIOUR_FILE}`;
        
        // Health related paths
        this.energyFullDesignPath = `${batteryPath}/${Constants.ENERGY_FULL_DESIGN_FILE}`;
        this.energyFullPath = `${batteryPath}/${Constants.ENERGY_FULL_FILE}`;
        this.chargeFullDesignPath = `${batteryPath}/${Constants.CHARGE_FULL_DESIGN_FILE}`;
        this.chargeFullPath = `${batteryPath}/${Constants.CHARGE_FULL_FILE}`;
        
        this.ctlPath = null;
        this.endLimitValue = -1;
        this.startLimitValue = -1;
        this._monitorLevel = null;
        this._supportsForceDischarge = false;
        this._forceDischargeEnabled = false;
        this._missingHelper = false;
    }

    async initialize() {
        // Check if battery threshold control files exist
        // We require at least the end threshold for support
        if (!fileExists(this.endPath)) {
            return false;
        }

        this._hasStartThreshold = fileExists(this.startPath);

        // Find the helper script
        this.ctlPath = findValidProgramInPath(Constants.HELPER_BIN_NAME);
        
        if (!this.ctlPath) {
            console.log(`Unified Power Manager: ${Constants.HELPER_BIN_NAME} helper not found, battery control will be read-only`);
            this._missingHelper = true;
        } else {
            this._missingHelper = false;
        }

        // Check force discharge support
        this._supportsForceDischarge = fileExists(this.forceDischargePath);

        // Read current values
        await this.refreshValues();

        // Set up file monitoring for external changes
        this._initializeMonitoring();

        return true;
    }

    /**
     * Check if a specific battery is supported
     * @param {string} batteryPath - e.g. '/sys/class/power_supply/BAT0'
     */
    static isSupported(batteryPath) {
        // Check if standard Linux battery threshold files exist
        // We require at least end thresholds for minimal support
        const endPath = `${batteryPath}/${Constants.THRESHOLD_END_FILE}`;
        return fileExists(endPath);
    }

    _initializeMonitoring() {
        if (this._monitorLevel) return;

        try {
            // Monitor end threshold for external changes
            const endThresholdFile = Gio.File.new_for_path(this.endPath);
            this._monitorLevel = endThresholdFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            
            this._connectMonitorSignal();
        } catch (e) {
            console.error(`Unified Power Manager: Failed to initialize file monitor: ${e.message}`);
        }
    }

    _connectMonitorSignal() {
        if (!this._monitorLevel) return;

        // Use connectObject to bind the signal to this instance's lifecycle
        this._monitorLevel.connectObject('changed', (obj, theFile, otherFile, eventType) => {
            try {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                    // Sync reads here are acceptable as this is an event callback
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
            } catch (e) {
                console.error(`Unified Power Manager: File monitor error: ${e.message}`);
            }
        }, this);
    }

    _disconnectMonitorSignal() {
        if (this._monitorLevel) {
            this._monitorLevel.disconnectObject(this);
        }
    }

    getThresholds() {
        return {
            start: this.startLimitValue,
            end: this.endLimitValue
        };
    }

    /**
     * Set battery charging thresholds with correct write ordering.
     * @param {number} startValue - Start threshold (0-100), ignored if device has no start threshold
     * @param {number} endValue - End threshold (0-100)
     * @returns {Promise<boolean>} - Success status
     * @private
     */
    async setThresholds(startValue, endValue) {
        if (this._missingHelper)
            return false;

        // Validate thresholds
        if (startValue < 0 || startValue > 100 || endValue < 0 || endValue > 100)
            return false;

        if (this._hasStartThreshold && startValue >= endValue)
            return false;

        // Temporarily disconnect monitor to avoid self-triggering
        this._disconnectMonitorSignal();

        let status, stdout, stderr;

        try {
            if (this._hasStartThreshold) {
                // Determine the correct order for writing thresholds
                // If increasing, write END first; if decreasing, write START first
                const cmd = startValue >= this.endLimitValue ? `${this.batteryName}_END_START` : `${this.batteryName}_START_END`;
                [status, stdout, stderr] = await runCommandCtl(this.ctlPath, cmd, `${endValue}`, `${startValue}`);
            } else {
                // Only set end threshold
                [status, stdout, stderr] = await runCommandCtl(this.ctlPath, `${this.batteryName}_END`, `${endValue}`);
            }

            if (status === exitCode.SUCCESS) {
                // Re-read values to confirm
                this.endLimitValue = (await readFileIntAsync(this.endPath)) || endValue;
                if (this._hasStartThreshold) {
                    this.startLimitValue = (await readFileIntAsync(this.startPath)) || startValue;
                }
                this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
                return true;
            } else if (status === exitCode.PRIVILEGE_REQUIRED) {
                console.error('Unified Power Manager: Privilege required - polkit rules may not be configured. Run install-helper.sh');
            } else if (stderr) {
                console.error(`Unified Power Manager: Failed to set thresholds: ${stderr.trim()}`);
            }

            return false;
        } finally {
            // Reconnect monitor
            this._connectMonitorSignal();
        }
    }

    getForceDischarge() {
        return this._forceDischargeEnabled;
    }

    async setForceDischarge(enabled) {
        if (!this._supportsForceDischarge || this._missingHelper)
            return false;

        const mode = enabled ? 'force-discharge' : 'auto';
        const [status, stdout, stderr] = await runCommandCtl(this.ctlPath, `FORCE_DISCHARGE_${this.batteryName}`, mode);

        if (status === exitCode.SUCCESS) {
            // Verify state change with polling to account for kernel latency
            // Poll for up to 2 seconds (20 * 100ms)
            for (let i = 0; i < 20; i++) {
                // First attempt immediate, subsequent attempts with delay
                if (i > 0) {
                    await new Promise(resolve => {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                }

                const behaviour = await readFileAsync(this.forceDischargePath);
                if (!behaviour) continue;

                let verified = false;
                if (enabled) {
                    // Check if force-discharge is active (bracketed or sole value)
                    if (behaviour.includes('[force-discharge]') || 
                       (behaviour.trim() === 'force-discharge' && !behaviour.includes('['))) {
                        verified = true;
                    }
                } else {
                    // Check if force-discharge is NOT active
                    // (i.e., we are in auto or inhibit-charge)
                    const isForceActive = behaviour.includes('[force-discharge]') || 
                                        (behaviour.trim() === 'force-discharge' && !behaviour.includes('['));
                    if (!isForceActive) {
                        verified = true;
                    }
                }

                if (verified) {
                    this._forceDischargeEnabled = enabled;
                    this.emit('force-discharge-changed', enabled);
                    return true;
                }
            }

            console.warn(`Unified Power Manager: Force discharge write succeeded but verification failed. Reverting state.`);
            await this.refreshValues(); // Re-read actual state from disk
            this.emit('force-discharge-changed', this._forceDischargeEnabled);
            return false;
        } else if (stderr) {
            console.error(`Unified Power Manager: Failed to set force discharge: ${stderr.trim()}`);
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

    /**
     * Get battery health percentage (0-100)
     * @returns {number|null}
     */
    getHealth() {
        // Try energy_* first (Wh) - both values must be from same family
        const energyFull = readFileInt(this.energyFullPath);
        const energyFullDesign = readFileInt(this.energyFullDesignPath);

        if (energyFull !== null && energyFullDesign !== null && energyFullDesign > 0) {
            let health = Math.round((energyFull / energyFullDesign) * 100);
            return Math.min(100, Math.max(0, health)); // Clamp to 0-100
        }

        // Fallback to charge_* (Ah) - both values must be from same family
        const chargeFull = readFileInt(this.chargeFullPath);
        const chargeFullDesign = readFileInt(this.chargeFullDesignPath);

        if (chargeFull !== null && chargeFullDesign !== null && chargeFullDesign > 0) {
            let health = Math.round((chargeFull / chargeFullDesign) * 100);
            return Math.min(100, Math.max(0, health)); // Clamp to 0-100
        }

        return null;
    }

    async refreshValues() {
        this.endLimitValue = (await readFileIntAsync(this.endPath)) || 100;
        
        if (this._hasStartThreshold) {
            this.startLimitValue = (await readFileIntAsync(this.startPath)) || 95;
        } else {
            this.startLimitValue = 0;
        }

        if (this._supportsForceDischarge) {
            const behaviour = await readFileAsync(this.forceDischargePath);
            // Parse charge_behaviour: format is typically "auto [force-discharge] inhibit-charge"
            // with brackets around the active mode, but handle variations
            if (behaviour) {
                // Check for bracketed format (most common)
                if (behaviour.includes('[force-discharge]')) {
                    this._forceDischargeEnabled = true;
                } else if (/\bforce-discharge\b/.test(behaviour) && !behaviour.includes('[')) {
                    // Fallback: if no brackets in output, check if force-discharge is the only word
                    // (some systems may output just the current mode)
                    this._forceDischargeEnabled = behaviour.trim() === 'force-discharge';
                } else {
                    this._forceDischargeEnabled = false;
                }
            } else {
                this._forceDischargeEnabled = false;
            }
        }
    }

    destroy() {
        if (this._monitorLevel) {
            this._monitorLevel.disconnectObject(this);
            this._monitorLevel.cancel();
            this._monitorLevel = null;
        }
    }
});