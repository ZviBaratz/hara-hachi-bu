/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * BatteryThresholdController manages ThinkPad battery charging thresholds.
 * Threshold ordering: When changing thresholds, the order matters to avoid
 * kernel errors. If increasing (new start >= current end), write END first.
 * If decreasing, write START first.
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Helper from './helper.js';

const {exitCode, fileExists, readFile, readFileInt, readFileUri, runCommandCtl, findValidProgramInPath} = Helper;

const BAT0_END_PATH = '/sys/class/power_supply/BAT0/charge_control_end_threshold';
const BAT0_START_PATH = '/sys/class/power_supply/BAT0/charge_control_start_threshold';
const BAT0_CAPACITY_PATH = '/sys/class/power_supply/BAT0/capacity';
const BAT0_FORCE_DISCHARGE_PATH = '/sys/class/power_supply/BAT0/charge_behaviour';
const BAT0_STATUS_PATH = '/sys/class/power_supply/BAT0/status';
const VENDOR_THINKPAD = '/sys/devices/platform/thinkpad_acpi';
const SYS_VENDOR_PATH = '/sys/devices/virtual/dmi/id/sys_vendor';

const BUS_NAME = 'org.freedesktop.UPower';
const OBJECT_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

export const BatteryThresholdController = GObject.registerClass({
    Signals: {
        'threshold-changed': {param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
        'battery-status-changed': {},
        'force-discharge-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class BatteryThresholdController extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;
        this.ctlPath = null;
        this.endLimitValue = -1;
        this.startLimitValue = -1;
        this._batteryLevel = 0;
        this._forceDischargeEnabled = false;
        this._monitorLevel = null;
        this._monitorLevelId = null;
        this._proxy = null;
        this._proxyId = null;
        this._initialized = false;
        this._supportsForceDischarge = false;
    }

    async initialize(extensionObject) {
        // Check hardware vendor for compatibility warning
        const vendor = readFile(SYS_VENDOR_PATH);
        if (vendor && !vendor.includes('LENOVO')) {
            console.log(`Unified Power Manager: Non-Lenovo device detected (${vendor}), battery threshold features may not work`);
        }

        // Check if ThinkPad battery threshold control is available
        if (!fileExists(VENDOR_THINKPAD)) {
            console.log('Unified Power Manager: Not a ThinkPad, battery threshold control not available');
            return false;
        }

        if (!fileExists(BAT0_START_PATH) || !fileExists(BAT0_END_PATH)) {
            console.log('Unified Power Manager: Battery threshold files not found');
            return false;
        }

        // Find the helper script
        this.ctlPath = findValidProgramInPath('unified-power-ctl');
        if (!this.ctlPath) {
            // Check extension resources directory
            const resourcePath = extensionObject.dir.get_child('resources').get_child('unified-power-ctl').get_path();
            if (fileExists(resourcePath))
                this.ctlPath = resourcePath;
        }

        if (!this.ctlPath) {
            console.log('Unified Power Manager: unified-power-ctl helper not found');
            return false;
        }

        // Check force discharge support
        this._supportsForceDischarge = fileExists(BAT0_FORCE_DISCHARGE_PATH);

        // Read current values
        this.endLimitValue = readFileInt(BAT0_END_PATH) || 100;
        this.startLimitValue = readFileInt(BAT0_START_PATH) || 95;
        this._batteryLevel = readFileInt(BAT0_CAPACITY_PATH) || 0;

        if (this._supportsForceDischarge) {
            const behaviour = readFile(BAT0_FORCE_DISCHARGE_PATH);
            this._forceDischargeEnabled = behaviour && behaviour.includes('[force-discharge]');
        }

        // Set up file monitoring for external changes
        this._initializeMonitoring();

        this._initialized = true;
        return true;
    }

    _initializeMonitoring() {
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

    async _initializeBatteryMonitoring() {
        // Set up UPower monitoring for battery level changes (used for force discharge)
        const xmlFile = 'resource:///org/gnome/shell/dbus-interfaces/org.freedesktop.UPower.Device.xml';

        try {
            const xmlContent = readFileUri(xmlFile);
            if (!xmlContent) {
                console.error('Unified Power Manager: Failed to read UPower DBus interface XML');
                return;
            }

            const powerManagerProxy = Gio.DBusProxy.makeProxyWrapper(xmlContent);
            this._proxy = new powerManagerProxy(Gio.DBus.system, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                if (error) {
                    console.error(`Unified Power Manager: Failed to create UPower proxy: ${error}`);
                    this._proxy = null;
                    return;
                }

                this._proxyId = this._proxy.connect('g-properties-changed', () => {
                    const batteryLevel = this._proxy.Percentage;
                    if (this._batteryLevel !== batteryLevel) {
                        this._batteryLevel = batteryLevel;
                        this.emit('battery-status-changed');

                        // Auto-disable force discharge if we've reached the threshold
                        if (this._forceDischargeEnabled && this._batteryLevel <= this.endLimitValue) {
                            this.setForceDischarge(false);
                        }
                    }
                });
            });
        } catch (e) {
            console.error(`Unified Power Manager: Error initializing battery monitoring: ${e}`);
            console.error(e.stack);
            this._proxy = null;
        }
    }

    get isAvailable() {
        return this._initialized;
    }

    get supportsForceDischarge() {
        return this._supportsForceDischarge;
    }

    get currentStartThreshold() {
        return this.startLimitValue;
    }

    get currentEndThreshold() {
        return this.endLimitValue;
    }

    get batteryLevel() {
        return this._batteryLevel;
    }

    get forceDischargeEnabled() {
        return this._forceDischargeEnabled;
    }

    getBatteryStatus() {
        const status = readFile(BAT0_STATUS_PATH);
        return status || 'Unknown';
    }

    async setThresholds(startValue, endValue) {
        if (!this._initialized)
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

    async setForceDischarge(enabled) {
        if (!this._supportsForceDischarge || !this._initialized)
            return false;

        const mode = enabled ? 'force-discharge' : 'auto';
        const [status] = await runCommandCtl(this.ctlPath, 'FORCE_DISCHARGE_BAT0', mode);

        if (status === exitCode.SUCCESS) {
            this._forceDischargeEnabled = enabled;
            this.emit('force-discharge-changed', enabled);

            // Start battery monitoring if enabling force discharge
            if (enabled && !this._proxy) {
                try {
                    await this._initializeBatteryMonitoring();
                } catch (e) {
                    console.error(`Unified Power Manager: Failed to initialize battery monitoring: ${e}`);
                    // Continue - monitoring is optional for force discharge
                }
            }

            return true;
        }

        return false;
    }

    refreshValues() {
        this.endLimitValue = readFileInt(BAT0_END_PATH) || this.endLimitValue;
        this.startLimitValue = readFileInt(BAT0_START_PATH) || this.startLimitValue;
        this._batteryLevel = readFileInt(BAT0_CAPACITY_PATH) || this._batteryLevel;

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
        if (this._proxyId && this._proxy) {
            this._proxy.disconnect(this._proxyId);
            this._proxyId = null;
        }
        this._proxy = null;
        this._settings = null;
        this._initialized = false;
    }
});
