/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { BaseDevice } from './BaseDevice.js';
import * as Helper from '../helper.js';

const {exitCode, fileExists, readFile, readFileInt, runCommandCtl, findValidProgramInPath} = Helper;

const BAT0_END_PATH = '/sys/class/power_supply/BAT0/charge_control_end_threshold';
const BAT0_START_PATH = '/sys/class/power_supply/BAT0/charge_control_start_threshold';
const BAT0_CAPACITY_PATH = '/sys/class/power_supply/BAT0/capacity';
const BAT0_FORCE_DISCHARGE_PATH = '/sys/class/power_supply/BAT0/charge_behaviour';
const BAT0_STATUS_PATH = '/sys/class/power_supply/BAT0/status';
const VENDOR_THINKPAD = '/sys/devices/platform/thinkpad_acpi';
const SYS_VENDOR_PATH = '/sys/devices/virtual/dmi/id/sys_vendor';

export const ThinkPad = GObject.registerClass({
    GTypeName: 'UPMThinkPadDevice',
}, class ThinkPad extends BaseDevice {
    constructor() {
        super();
        this.name = 'ThinkPad';
        this.ctlPath = null;
        this.endLimitValue = -1;
        this.startLimitValue = -1;
        this._monitorLevel = null;
        this._monitorLevelId = null;
        this._supportsForceDischarge = false;
        this._forceDischargeEnabled = false;
        this._missingHelper = false;
    }

    async initialize() {
        // Check hardware vendor
        const vendor = readFile(SYS_VENDOR_PATH);
        if (vendor && !vendor.includes('LENOVO')) {
            return false;
        }

        // Check if ThinkPad battery threshold control is available
        if (!fileExists(VENDOR_THINKPAD)) {
            return false;
        }

        if (!fileExists(BAT0_START_PATH) || !fileExists(BAT0_END_PATH)) {
            return false;
        }

        // Find the helper script
        this.ctlPath = findValidProgramInPath('unified-power-ctl');
        
        if (!this.ctlPath) {
            console.log('Unified Power Manager: unified-power-ctl helper not found, battery control will be read-only');
            this._missingHelper = true;
        } else {
            this._missingHelper = false;
        }

        // Check force discharge support
        this._supportsForceDischarge = fileExists(BAT0_FORCE_DISCHARGE_PATH);

        // Read current values
        this.refreshValues();

        // Set up file monitoring for external changes
        this._initializeMonitoring();

        return true;
    }

    static isSupported() {
        const vendor = readFile(SYS_VENDOR_PATH);
        if (vendor && vendor.includes('LENOVO') && fileExists(VENDOR_THINKPAD)) {
            return true;
        }
        return false;
    }

    _initializeMonitoring() {
        if (this._monitorLevel) return;

        // Monitor end threshold for external changes
        const endThresholdFile = Gio.File.new_for_path(BAT0_END_PATH);
        this._monitorLevel = endThresholdFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorLevelId = this._monitorLevel.connect('changed', (obj, theFile, otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                const newEnd = readFileInt(BAT0_END_PATH);
                const newStart = readFileInt(BAT0_START_PATH);
                if (newEnd !== null && newStart !== null &&
                    (newEnd !== this.endLimitValue || newStart !== this.startLimitValue)) {
                    this.endLimitValue = newEnd;
                    this.startLimitValue = newStart;
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

        if (startValue >= endValue)
            return false;

        // Determine the correct order for writing thresholds
        // If increasing, write END first; if decreasing, write START first
        const cmd = startValue >= this.endLimitValue ? 'BAT0_END_START' : 'BAT0_START_END';
        const [status] = await runCommandCtl(this.ctlPath, cmd, `${endValue}`, `${startValue}`);

        if (status === exitCode.SUCCESS) {
            this.endLimitValue = readFileInt(BAT0_END_PATH) || endValue;
            this.startLimitValue = readFileInt(BAT0_START_PATH) || startValue;
            this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
            return true;
        }

        return false;
    }

    getForceDischarge() {
        return this._forceDischargeEnabled;
    }

    async setForceDischarge(enabled) {
        if (!this._supportsForceDischarge || this._missingHelper)
            return false;

        const mode = enabled ? 'force-discharge' : 'auto';
        const [status] = await runCommandCtl(this.ctlPath, 'FORCE_DISCHARGE_BAT0', mode);

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

    getBatteryLevel() {
        return readFileInt(BAT0_CAPACITY_PATH) || 0;
    }

    refreshValues() {
        this.endLimitValue = readFileInt(BAT0_END_PATH) || 100;
        this.startLimitValue = readFileInt(BAT0_START_PATH) || 95;

        if (this._supportsForceDischarge) {
            const behaviour = readFile(BAT0_FORCE_DISCHARGE_PATH);
            this._forceDischargeEnabled = behaviour && behaviour.includes('[force-discharge]');
        }
    }

    destroy() {
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
