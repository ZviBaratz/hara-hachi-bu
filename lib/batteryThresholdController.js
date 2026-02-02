/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Helper from './helper.js';
import { DeviceManager } from './device/DeviceManager.js';

const {readFile} = Helper;

const BUS_NAME = 'org.freedesktop.UPower';
const OBJECT_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';

export const BatteryThresholdController = GObject.registerClass({
    Signals: {
        'threshold-changed': {param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
        'battery-status-changed': {},
        'force-discharge-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'power-source-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class BatteryThresholdController extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;
        this._device = null;
        this._batteryLevel = 0;
        this._batteryState = 0;
        this._onBattery = false;
        this._proxy = null;
        this._proxyId = null;
        this._upowerProxy = null;
        this._upowerProxyId = null;
        this._initialized = false;
        this._capacityPath = null;
        this._statusPath = null;

        // Signals from device
        this._deviceSignalIds = [];

        // Force discharge auto-disable debouncing
        this._forceDischargeDisableTimeout = null;
        this._forceDischargeDisableInProgress = false;
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
            // Try to detect which battery exists for basic monitoring
            const bat1Exists = Helper.fileExists('/sys/class/power_supply/BAT1/capacity');
            const batteryName = bat1Exists && !Helper.fileExists('/sys/class/power_supply/BAT0/capacity') ? 'BAT1' : 'BAT0';
            
            this._capacityPath = `/sys/class/power_supply/${batteryName}/capacity`;
            this._statusPath = `/sys/class/power_supply/${batteryName}/status`;
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
        // We use embedded XML to avoid dependencies on system files
        const UPowerDeviceInterface = `
        <node>
          <interface name="org.freedesktop.UPower.Device">
            <property name="Percentage" type="d" access="read"/>
            <property name="State" type="u" access="read"/>
            <property name="TimeToEmpty" type="x" access="read"/>
            <property name="TimeToFull" type="x" access="read"/>
          </interface>
        </node>`;

        const UPowerInterface = `
        <node>
          <interface name="org.freedesktop.UPower">
            <property name="OnBattery" type="b" access="read"/>
          </interface>
        </node>`;

        try {
            // Initialize _onBattery synchronously from sysfs before proxy is ready
            // This avoids race condition where _onBattery is accessed before callback
            const acOnlinePath = '/sys/class/power_supply/AC/online';
            const acOnline = readFile(acOnlinePath);
            if (acOnline !== null) {
                this._onBattery = acOnline.trim() === '0';
            }

            // Main UPower proxy for OnBattery
            const upowerProxyWrapper = Gio.DBusProxy.makeProxyWrapper(UPowerInterface);
            this._upowerProxy = new upowerProxyWrapper(Gio.DBus.system, BUS_NAME, UPOWER_OBJECT_PATH, (proxy, error) => {
                if (error) {
                    console.error(`Unified Power Manager: Failed to create main UPower proxy: ${error}`);
                    this._upowerProxy = null;
                    return;
                }

                // Update with authoritative value from UPower once proxy is ready
                const upowerOnBattery = this._upowerProxy.OnBattery;
                if (this._onBattery !== upowerOnBattery) {
                    this._onBattery = upowerOnBattery;
                    this.emit('power-source-changed', this._onBattery);
                }

                this._upowerProxyId = this._upowerProxy.connect('g-properties-changed', () => {
                    if (this._onBattery !== this._upowerProxy.OnBattery) {
                        this._onBattery = this._upowerProxy.OnBattery;
                        this.emit('power-source-changed', this._onBattery);
                    }
                });
            });

            // DisplayDevice proxy for levels and state
            const powerManagerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceInterface);
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
                            this._scheduleForceDischargeDisable();
                        }
                    }

                    // Monitor charging state (Charging/Discharging/Full)
                    const batteryState = this._proxy?.State ?? this._batteryState;
                    if (this._batteryState !== batteryState) {
                        this._batteryState = batteryState;
                        statusChanged = true;
                    }

                    // Monitor time changes (optional, but good for real-time updates)
                    // We just emit 'battery-status-changed' for any relevant change

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
        if (!this._device) return false;
        return !this._device.needsHelper;
    }

    get needsHelper() {
        if (!this._device) return false;
        return this._device.needsHelper;
    }

    get supportsForceDischarge() {
        if (!this._device) return false;
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

    get batteryHealth() {
        if (this._device && typeof this._device.getHealth === 'function') {
            return this._device.getHealth();
        }
        return null;
    }

    get timeToEmpty() {
        return this._proxy?.TimeToEmpty ?? 0;
    }

    get timeToFull() {
        return this._proxy?.TimeToFull ?? 0;
    }

    get onBattery() {
        return this._onBattery;
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

    /**
     * Schedule force discharge disable with debouncing to prevent
     * race conditions from rapid battery level changes
     */
    _scheduleForceDischargeDisable() {
        // Skip if already in progress or scheduled
        if (this._forceDischargeDisableInProgress)
            return;

        // Cancel any existing timeout
        if (this._forceDischargeDisableTimeout) {
            GLib.Source.remove(this._forceDischargeDisableTimeout);
            this._forceDischargeDisableTimeout = null;
        }

        // Schedule with 500ms debounce delay
        this._forceDischargeDisableTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._forceDischargeDisableTimeout = null;

            // Double-check conditions still apply
            if (!this.forceDischargeEnabled || this._batteryLevel > this.currentEndThreshold) {
                return GLib.SOURCE_REMOVE;
            }

            this._forceDischargeDisableInProgress = true;
            this.setForceDischarge(false)
                .catch(e => {
                    console.error('Unified Power Manager: Failed to auto-disable force discharge:', e);
                })
                .finally(() => {
                    this._forceDischargeDisableInProgress = false;
                });

            return GLib.SOURCE_REMOVE;
        });
    }

    refreshValues() {
        if (this._device && typeof this._device.refreshValues === 'function') {
            this._device.refreshValues();
        }
        // Also refresh battery level
        this._batteryLevel = readFileInt(this._capacityPath) || this._batteryLevel;
    }

    destroy() {
        // Cancel any pending force discharge disable
        if (this._forceDischargeDisableTimeout) {
            GLib.Source.remove(this._forceDischargeDisableTimeout);
            this._forceDischargeDisableTimeout = null;
        }

        if (this._proxyId && this._proxy) {
            this._proxy.disconnect(this._proxyId);
            this._proxyId = null;
        }
        this._proxy = null;

        if (this._upowerProxyId && this._upowerProxy) {
            this._upowerProxy.disconnect(this._upowerProxyId);
            this._upowerProxyId = null;
        }
        this._upowerProxy = null;

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