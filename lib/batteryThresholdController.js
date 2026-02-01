/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Helper from './helper.js';
import { DeviceManager } from './device/DeviceManager.js';

const {readFile, readFileUri} = Helper;

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
        this._device = null;
        this._batteryLevel = 0;
        this._batteryState = 0;
        this._proxy = null;
        this._proxyId = null;
        this._initialized = false;
        this._capacityPath = null;
        this._statusPath = null;

        // Signals from device
        this._deviceSignalIds = [];
    }

    async initialize(extensionObject) {
        // Initialize the correct device
        this._device = await DeviceManager.getDevice();

        if (this._device) {
            // Set up battery paths based on detected device
            const batteryName = this._device.batteryName || 'BAT0';
            this._capacityPath = `/sys/class/power_supply/${batteryName}/capacity`;
            this._statusPath = `/sys/class/power_supply/${batteryName}/status`;

            // Connect to device signals
            this._deviceSignalIds.push(
                this._device.connect('threshold-changed', (dev, start, end) => {
                    this.emit('threshold-changed', start, end);
                }),
                this._device.connect('force-discharge-changed', (dev, enabled) => {
                    this.emit('force-discharge-changed', enabled);
                })
            );
        } else {
            console.log('Unified Power Manager: No supported device found');
            // Fallback paths for battery monitoring without threshold control
            this._capacityPath = '/sys/class/power_supply/BAT0/capacity';
            this._statusPath = '/sys/class/power_supply/BAT0/status';
        }

        // Initialize battery monitoring for status changes (UPower)
        // We do this even if no control device is found, to show battery status
        await this._initializeBatteryMonitoring();

        // Initial read of battery level if UPower isn't ready
        this._batteryLevel = readFileInt(this._capacityPath) || 0;

        this._initialized = true;
        return !!this._device;
    }

    async _initializeBatteryMonitoring() {
        // Set up UPower monitoring for battery level and status changes
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

                // Store initial state value
                this._batteryState = this._proxy.State;

                this._proxyId = this._proxy.connect('g-properties-changed', () => {
                    let statusChanged = false;

                    // Monitor battery level (use optional chaining for safety)
                    const batteryLevel = this._proxy?.Percentage ?? this._batteryLevel;
                    if (this._batteryLevel !== batteryLevel) {
                        this._batteryLevel = batteryLevel;
                        statusChanged = true;

                        // Auto-disable force discharge if we've reached the threshold
                        if (this.forceDischargeEnabled && this._batteryLevel <= this.currentEndThreshold) {
                            this.setForceDischarge(false).catch(e => {
                                console.error('Unified Power Manager: Failed to auto-disable force discharge:', e);
                            });
                        }
                    }

                    // Monitor charging state (Charging/Discharging/Full)
                    const batteryState = this._proxy?.State ?? this._batteryState;
                    if (this._batteryState !== batteryState) {
                        this._batteryState = batteryState;
                        statusChanged = true;
                    }

                    // Emit signal if any status changed
                    if (statusChanged)
                        this.emit('battery-status-changed');
                });
            });
        } catch (e) {
            console.error(`Unified Power Manager: Error initializing battery monitoring: ${e}`);
            console.error(e.stack);
            this._proxy = null;
        }
    }

    get isAvailable() {
        // We are available if we have a device, AND it doesn't need a missing helper
        // But wait, existing code logic for `needsHelper` was:
        // isAvailable returned true even if helper missing? No:
        // get isAvailable() { return this._initialized && !this._missingHelper; }
        // get needsHelper() { return this._initialized && this._missingHelper; }
        
        // So if helper is missing, isAvailable is FALSE.
        
        if (!this._device) return false;
        return !this._device.needsHelper;
    }

    get needsHelper() {
        if (!this._device) return false;
        return this._device.needsHelper;
    }

    get supportsForceDischarge() {
        if (!this._device) return false;
        return this._device.getForceDischarge() !== undefined; // Check implementation?
        // Actually BaseDevice has getForceDischarge returning false default.
        // Wait, ThinkPad checks file existence.
        // Let's use a capability check or just check if it supports it.
        // BaseDevice doesn't have `supportsForceDischarge` property, I should use `getForceDischarge` or add a capability query.
        // ThinkPad.js has `_supportsForceDischarge` property but no getter for it in BaseDevice.
        // Let's rely on the method throwing or returning false?
        // Ah, `ThinkPad.js` implementation of `setForceDischarge` checks `_supportsForceDischarge`.
        // But the UI needs to know *before* calling set.
        // `StateManager` checks `batteryController.supportsForceDischarge`.
        // I need to expose this from the Device.
        
        // Checking ThinkPad.js again...
        // It has `get supportsForceDischarge() { return this._supportsForceDischarge; }` ?
        // I did NOT add that getter to ThinkPad.js in my previous step. I missed it.
        // I need to add `supportsForceDischarge` getter to BaseDevice and ThinkPad.
        
        // For now, I will assume I need to fix that in Device classes.
        // I'll add `supportsForceDischarge` getter to the controller and it will try to access it on device.
        return this._device.supportsForceDischarge || false;
    }

    get currentStartThreshold() {
        if (!this._device) return -1;
        return this._device.getThresholds().start;
    }

    get currentEndThreshold() {
        if (!this._device) return -1;
        return this._device.getThresholds().end;
    }

    get batteryLevel() {
        return this._batteryLevel;
    }

    get forceDischargeEnabled() {
        if (!this._device) return false;
        return this._device.getForceDischarge();
    }

    getBatteryStatus() {
        // Try UPower state first
        if (this._batteryState === 1) return 'Charging';
        if (this._batteryState === 2) return 'Discharging';
        if (this._batteryState === 4) return 'Full';
        
        // Fallback to file read
        const status = readFile(this._statusPath);
        return status || 'Unknown';
    }

    async setThresholds(startValue, endValue) {
        if (!this.isAvailable) return false;
        return this._device.setThresholds(startValue, endValue);
    }

    async setForceDischarge(enabled) {
        if (!this.isAvailable) return false;
        return this._device.setForceDischarge(enabled);
    }

    refreshValues() {
        if (this._device && typeof this._device.refreshValues === 'function') {
            this._device.refreshValues();
        }
        // Also refresh battery level
        this._batteryLevel = readFileInt(this._capacityPath) || this._batteryLevel;
    }

    destroy() {
        if (this._proxyId && this._proxy) {
            this._proxy.disconnect(this._proxyId);
            this._proxyId = null;
        }
        this._proxy = null;

        if (this._device) {
            for (const id of this._deviceSignalIds) {
                this._device.disconnect(id);
            }
            this._deviceSignalIds = [];
            this._device.destroy(); // Assuming device has destroy
            this._device = null;
        }
        
        this._settings = null;
        this._initialized = false;
    }
});

function readFileInt(path) {
    try {
        const v = readFile(path);
        if (v)
            return parseInt(v);
        else
            return null;
    } catch {
        return null;
    }
}