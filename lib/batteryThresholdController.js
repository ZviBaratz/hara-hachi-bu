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

const {readFile, readFileInt, readFileAsync, readFileIntAsync} = Helper;

// Promisify Gio.File methods for async/await usage
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

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
        this._upowerProxy = null;
        this._initialized = false;
        this._capacityPath = null;
        this._statusPath = null;

        // Force discharge auto-disable debouncing
        this._forceDischargeDisableTimeout = null;
        this._forceDischargeDisableInProgress = false;

        // Auto-management state tracking (transient - not persisted)
        this._autoManagementActive = false;  // Is auto-management controlling force-discharge?
        this._autoEnableTimeout = null;       // Debounce timer for auto-enable
        this._autoEnableInProgress = false;   // Operation lock for auto-enable

        // Destroyed flag for async safety - prevents promise callbacks from executing on destroyed object
        this._destroyed = false;
    }

    async initialize(extensionObject) {
        // Initialize the correct device
        this._device = await DeviceManager.getDevice();

        if (this._device) {
            // Set up battery paths based on detected device
            const batteryName = this._device.batteryName || 'BAT0';
            this._capacityPath = `/sys/class/power_supply/${batteryName}/capacity`;
            this._statusPath = `/sys/class/power_supply/${batteryName}/status`;

            // Connect to device signals using connectObject for auto-cleanup
            this._device.connectObject(
                'threshold-changed', (dev, start, end) => {
                    this.emit('threshold-changed', start, end);
                },
                'force-discharge-changed', (dev, enabled) => {
                    this.emit('force-discharge-changed', enabled);
                },
                this
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
        this._batteryLevel = (await readFileIntAsync(this._capacityPath)) || 0;

        // Perform initial auto-management check
        // This ensures we catch cases where we start up in a state that requires action
        // (e.g., plugged in with high battery) without waiting for a level change event.
        if (this._isAutoManageEnabled()) {
            // Use a slight delay to ensure everything is fully settled
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this.checkAutoManagement();
                return GLib.SOURCE_REMOVE;
            });
        }

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
            // Initialize _onBattery asynchronously from sysfs before proxy is ready
            // This avoids race condition where _onBattery is accessed before callback
            // Scan for any power supply of type 'Mains' to detect AC adapter
            let acOnline = null;
            try {
                const psDir = Gio.File.new_for_path('/sys/class/power_supply');
                const enumerator = await psDir.enumerate_children_async(
                    'standard::name',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
                
                while (true) {
                    const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
                    if (!fileInfos || fileInfos.length === 0)
                        break;
                        
                    for (const info of fileInfos) {
                        const name = info.get_name();
                        const type = await readFileAsync(`/sys/class/power_supply/${name}/type`);
                        if (type === 'Mains') {
                            const online = await readFileAsync(`/sys/class/power_supply/${name}/online`);
                            if (online !== null) {
                                acOnline = online;
                                break;
                            }
                        }
                    }
                    if (acOnline !== null) break;
                }
            } catch (e) {
                // Fallback to most common names if enumeration fails
                const fallbacks = ['AC', 'ACAD', 'ADP0', 'ADP1'];
                for (const name of fallbacks) {
                    const online = await readFileAsync(`/sys/class/power_supply/${name}/online`);
                    if (online !== null) {
                        acOnline = online;
                        break;
                    }
                }
            }

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

                this._upowerProxy.connectObject('g-properties-changed', () => {
                    if (this._onBattery !== this._upowerProxy.OnBattery) {
                        this._onBattery = this._upowerProxy.OnBattery;
                        this.emit('power-source-changed', this._onBattery);

                        // Emergency disable if AC unplugged during auto-management
                        if (this._onBattery && this._autoManagementActive && this.forceDischargeEnabled) {
                            this._emergencyDisableForceDischarge();
                        }
                    }
                }, this);
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

                this._proxy.connectObject('g-properties-changed', () => {
                    let statusChanged = false;

                    // Monitor battery level (use optional chaining for safety)
                    const batteryLevel = this._proxy?.Percentage ?? this._batteryLevel;
                    if (this._batteryLevel !== batteryLevel) {
                        this._batteryLevel = batteryLevel;
                        statusChanged = true;

                        // Auto-disable force discharge if we've reached the threshold
                        if (this.forceDischargeEnabled && this._batteryLevel <= this.currentStartThreshold) {
                            this._scheduleForceDischargeDisable();
                        }

                        // Auto-enable above end threshold
                        if (this._shouldAutoEnableForceDischarge()) {
                            this._scheduleForceDischargeEnable();
                        }

                        // Check for auto-management cycle completion
                        if (this._isAutoManagementComplete()) {
                            this._resetAutoManagement();
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
                }, this);
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
        // Check sysfs first for authoritative status (avoids UPower lag)
        const sysfsStatus = readFile(this._statusPath);
        
        if (sysfsStatus === 'Not charging') return 'Not charging';
        if (sysfsStatus === 'Charging') return 'Charging';
        if (sysfsStatus === 'Discharging') return 'Discharging';
        if (sysfsStatus === 'Full') return 'Full';

        // Fall back to UPower states if sysfs is ambiguous/unknown
        if (this._batteryState === 1) return 'Charging';
        if (this._batteryState === 2) return 'Discharging';
        if (this._batteryState === 4) return 'Full';

        // Final fallback
        return sysfsStatus || 'Unknown';
    }

    async setThresholds(startValue, endValue) {
        if (!this.isAvailable) return false;
        return this._device.setThresholds(startValue, endValue);
    }

    async setForceDischarge(enabled, isManual = true) {
        if (!this.isAvailable) return false;

        // If manual, we override any auto operations
        const isUserInitiated = isManual;

        const success = await this._device.setForceDischarge(enabled);

        // User toggle breaks auto-management
        // We do this even if device set failed, to stop the loop
        if (isUserInitiated) {
            console.log('Unified Power Manager: User manually toggled force discharge, stopping auto-management');
            this._autoManagementActive = false;

            // If auto-management is enabled, disable it to respect user's manual override
            if (this._isAutoManageEnabled()) {
                console.log('Unified Power Manager: Disabling auto-management due to manual override');
                this._settings.set_boolean('auto-manage-battery-levels', false);
            }
        }

        return success;
    }

    /**
     * Schedule force discharge disable with debouncing to prevent
     * race conditions from rapid battery level changes.
     *
     * Protection against races:
     * 1. Only one timeout can be pending at a time (previous is cancelled)
     * 2. Timeout is skipped if operation already in progress
     * 3. Operation flag is checked again inside timeout before executing
     */
    _scheduleForceDischargeDisable() {
        // Skip if operation already in progress or timeout already pending
        if (this._forceDischargeDisableInProgress || this._forceDischargeDisableTimeout)
            return;

        // Schedule with 500ms debounce delay
        this._forceDischargeDisableTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._forceDischargeDisableTimeout = null;

            // Double-check conditions still apply and no operation in progress
            if (!this.forceDischargeEnabled ||
                this._batteryLevel > this.currentEndThreshold ||
                this._forceDischargeDisableInProgress) {
                return GLib.SOURCE_REMOVE;
            }

            this._forceDischargeDisableInProgress = true;
            this.setForceDischarge(false, false)
                .catch(e => {
                    if (!this._destroyed)
                        console.error('Unified Power Manager: Failed to auto-disable force discharge:', e);
                })
                .finally(() => {
                    if (!this._destroyed)
                        this._forceDischargeDisableInProgress = false;
                });

            return GLib.SOURCE_REMOVE;
        });
    }

    // Check if auto-management setting is enabled
    _isAutoManageEnabled() {
        return this._settings.get_boolean('auto-manage-battery-levels');
    }

    // Check if conditions are right to auto-enable force discharge
    _shouldAutoEnableForceDischarge() {
        // robustness: if status is 'Not charging', we are definitely plugged in (inhibited),
        // even if UPower says otherwise (e.g. during transitions)
        const isInhibited = this.getBatteryStatus() === 'Not charging';
        const isPluggedIn = !this._onBattery || isInhibited;

        return (
            this._isAutoManageEnabled() &&
            !this.forceDischargeEnabled &&
            !this._autoManagementActive &&
            isPluggedIn &&
            this._batteryLevel > this.currentEndThreshold &&
            this.supportsForceDischarge
        );
    }

    // Check if auto-management cycle is complete
    _isAutoManagementComplete() {
        return (
            this._autoManagementActive &&
            !this.forceDischargeEnabled &&
            !this._onBattery &&
            this._batteryLevel >= this.currentEndThreshold
        );
    }

    // Reset auto-management state (cycle complete)
    _resetAutoManagement() {
        console.log('Unified Power Manager: Auto-management cycle complete, resetting to user control');
        this._autoManagementActive = false;
    }

    /**
     * Schedule force discharge enable with debouncing to prevent
     * race conditions from rapid battery level changes.
     *
     * Protection against races:
     * 1. Only one timeout can be pending at a time (previous is cancelled)
     * 2. Timeout is skipped if operation already in progress
     * 3. Operation flag is checked again inside timeout before executing
     */
    _scheduleForceDischargeEnable() {
        // Skip if operation already in progress or timeout already pending
        if (this._autoEnableInProgress || this._autoEnableTimeout)
            return;

        console.log('Unified Power Manager: Scheduling auto-enable force discharge');

        // Schedule with 500ms debounce delay
        this._autoEnableTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._autoEnableTimeout = null;

            // Double-check conditions still apply
            if (!this._shouldAutoEnableForceDischarge()) {
                console.log('Unified Power Manager: Auto-enable conditions no longer met, skipping');
                return GLib.SOURCE_REMOVE;
            }

            console.log('Unified Power Manager: Auto-enabling force discharge');
            this._autoEnableInProgress = true;
            this._autoManagementActive = true;

            this.setForceDischarge(true, false)
                .catch(e => {
                    if (!this._destroyed) {
                        console.error('Unified Power Manager: Failed to auto-enable force discharge:', e);
                        this._autoManagementActive = false;
                    }
                })
                .finally(() => {
                    if (!this._destroyed)
                        this._autoEnableInProgress = false;
                });

            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Emergency disable force discharge when AC unplugged during auto-management
     */
    _emergencyDisableForceDischarge() {
        console.log('Unified Power Manager: Emergency disable - AC unplugged during auto-management');

        // Cancel any pending operations
        if (this._autoEnableTimeout) {
            GLib.Source.remove(this._autoEnableTimeout);
            this._autoEnableTimeout = null;
        }
        if (this._forceDischargeDisableTimeout) {
            GLib.Source.remove(this._forceDischargeDisableTimeout);
            this._forceDischargeDisableTimeout = null;
        }

        // Reset flags
        this._autoManagementActive = false;
        this._autoEnableInProgress = false;
        this._forceDischargeDisableInProgress = false;

        // Immediate disable if currently force-discharging
        if (this.forceDischargeEnabled) {
            this.setForceDischarge(false, false).catch(e => {
                console.error('Unified Power Manager: Emergency disable failed:', e);
            });
        }
    }

    /**
     * Cancel auto-management (called when setting disabled)
     */
    _cancelAutoManagement() {
        console.log('Unified Power Manager: Canceling auto-management');

        if (this._autoEnableTimeout) {
            GLib.Source.remove(this._autoEnableTimeout);
            this._autoEnableTimeout = null;
        }
        if (this._forceDischargeDisableTimeout) {
            GLib.Source.remove(this._forceDischargeDisableTimeout);
            this._forceDischargeDisableTimeout = null;
        }

        this._autoManagementActive = false;
        this._autoEnableInProgress = false;
        this._forceDischargeDisableInProgress = false;
    }

    /**
     * Check auto-management conditions and enable force discharge if appropriate.
     * Called when the setting is toggled on.
     */
    async checkAutoManagement() {
        // Ensure we have latest values
        await this.refreshValues();

        if (this._shouldAutoEnableForceDischarge()) {
            this._scheduleForceDischargeEnable();
        }
    }

    async refreshValues() {
        if (this._device && typeof this._device.refreshValues === 'function') {
            await this._device.refreshValues();
        }
        // Also refresh battery level
        this._batteryLevel = (await readFileIntAsync(this._capacityPath)) || this._batteryLevel;
    }

    destroy() {
        // Mark as destroyed to prevent async callbacks from executing
        this._destroyed = true;

        // Cancel auto-enable timeout
        if (this._autoEnableTimeout) {
            GLib.Source.remove(this._autoEnableTimeout);
            this._autoEnableTimeout = null;
        }

        // Cancel any pending force discharge disable
        if (this._forceDischargeDisableTimeout) {
            GLib.Source.remove(this._forceDischargeDisableTimeout);
            this._forceDischargeDisableTimeout = null;
        }

        // Signal cleanup handled by disconnectObject
        if (this._proxy) this._proxy.disconnectObject(this);
        if (this._upowerProxy) this._upowerProxy.disconnectObject(this);
        if (this._device) {
             this._device.disconnectObject(this);
             this._device.destroy();
        }

        this._proxy = null;
        this._upowerProxy = null;
        this._device = null;
        this._settings = null;
        this._initialized = false;
    }
});