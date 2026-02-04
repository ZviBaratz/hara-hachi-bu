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
import * as Constants from './constants.js';
import { DeviceManager } from './device/DeviceManager.js';

const {readFile, readFileInt, readFileAsync, readFileIntAsync} = Helper;

const AUTO_DISCHARGE_HYSTERESIS = 1; // % buffer to prevent rapid toggling

// Promisify Gio.File methods for async/await usage
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

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

        // Initialization timeouts (stored for cleanup)
        this._proxyInitTimeout = null;

        // Auto-management state tracking (transient - not persisted)
        this._autoManagementActive = false;  // Is auto-management controlling force-discharge?

        // Destroyed flag for async safety - prevents promise callbacks from executing on destroyed object
        this._destroyed = false;
    }

    async initialize(extensionObject) {
        // Initialize the correct device (may be a CompositeDevice)
        this._device = await DeviceManager.getDevice();

        if (this._device) {
            // Set up fallback battery paths based on detected device
            // (Used for status reading when UPower is not ready)
            const batteryName = this._device.batteryName || 'BAT0';
            this._capacityPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.CAPACITY_FILE}`;
            this._statusPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.STATUS_FILE}`;

            // Connect to device signals using connectObject for auto-cleanup
            this._device.connectObject(
                'threshold-changed', (dev, start, end) => {
                    this.emit('threshold-changed', start, end);
                    this._updateAutoDischarge();
                },
                'force-discharge-changed', (dev, enabled) => {
                    this.emit('force-discharge-changed', enabled);
                    // Update state if external change happened
                    if (!enabled && this._autoManagementActive) {
                        this._autoManagementActive = false;
                    }
                },
                this
            );
        } else {
            console.log('Unified Power Manager: No supported device found');
            // Fallback paths for basic monitoring without threshold control
            const bat1Exists = Helper.fileExists(`${Constants.SYSFS_POWER_SUPPLY_PATH}/BAT1/${Constants.CAPACITY_FILE}`);
            const batteryName = bat1Exists && !Helper.fileExists(`${Constants.SYSFS_POWER_SUPPLY_PATH}/BAT0/${Constants.CAPACITY_FILE}`) ? 'BAT1' : 'BAT0';
            
            this._capacityPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.CAPACITY_FILE}`;
            this._statusPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.STATUS_FILE}`;
        }

        // Initialize battery monitoring for status changes (UPower)
        await this._initializeBatteryMonitoring();

        // Initial read of battery level if UPower isn't ready
        if (this._batteryLevel === 0) {
            this._batteryLevel = (await readFileIntAsync(this._capacityPath)) || 0;
        }

        // Initial auto-discharge check
        this._updateAutoDischarge();

        this._initialized = true;
        return !!this._device;
    }

    async _initializeBatteryMonitoring() {
        // Set up UPower monitoring for battery level and status changes
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

        // Helper to detect AC online state from sysfs
        const getAcOnlineSysfs = async () => {
            try {
                const psDir = Gio.File.new_for_path(Constants.SYSFS_POWER_SUPPLY_PATH);
                const enumerator = await psDir.enumerate_children_async(
                    'standard::name',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null
                );
                
                while (true) {
                    const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
                    if (!fileInfos || fileInfos.length === 0) break;
                        
                    for (const info of fileInfos) {
                        const name = info.get_name();
                        const type = await readFileAsync(`${Constants.SYSFS_POWER_SUPPLY_PATH}/${name}/type`) || '';
                        if (type === 'Mains') {
                            const online = await readFileAsync(`${Constants.SYSFS_POWER_SUPPLY_PATH}/${name}/online`);
                            if (online !== null) return online === '1';
                        }
                    }
                }
            } catch {
                // sysfs enumeration may fail on some systems; fall through to UPower
            }
            return null;
        };

        // Initial sysfs check for onBattery state
        const acOnline = await getAcOnlineSysfs();
        if (acOnline !== null) {
            this._onBattery = !acOnline;
        }

        return new Promise((resolve) => {
            let upowerReady = false;
            let displayDeviceReady = false;

            const checkReady = () => {
                if (upowerReady && displayDeviceReady) resolve();
            };

            const upowerProxyWrapper = Gio.DBusProxy.makeProxyWrapper(UPowerInterface);
            this._upowerProxy = new upowerProxyWrapper(Gio.DBus.system, Constants.UPOWER_BUS_NAME, Constants.UPOWER_OBJECT_PATH, (proxy, error) => {
                if (error) {
                    console.error(`Unified Power Manager: Failed to create main UPower proxy: ${error}`);
                } else {
                    const upowerOnBattery = this._upowerProxy.OnBattery;
                    if (this._onBattery !== upowerOnBattery) {
                        this._onBattery = upowerOnBattery;
                        this.emit('power-source-changed', this._onBattery);
                    }

                    this._upowerProxy.connectObject('g-properties-changed', () => {
                        if (this._onBattery !== this._upowerProxy.OnBattery) {
                            this._onBattery = this._upowerProxy.OnBattery;
                            this.emit('power-source-changed', this._onBattery);
                            this._updateAutoDischarge();
                        }
                    }, this);
                }
                upowerReady = true;
                checkReady();
            });

            const powerManagerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceInterface);
            this._proxy = new powerManagerProxy(Gio.DBus.system, Constants.UPOWER_BUS_NAME, Constants.UPOWER_DEVICE_PATH, (proxy, error) => {
                if (error) {
                    console.error(`Unified Power Manager: Failed to create UPower proxy: ${error}`);
                } else {
                    this._batteryState = this._proxy.State;
                    this._batteryLevel = this._proxy.Percentage;

                    this._proxy.connectObject('g-properties-changed', (p, changed) => {
                        let statusChanged = false;
                        const changedProps = changed.deep_unpack();

                        if ('Percentage' in changedProps) {
                            const batteryLevel = changedProps.Percentage.deep_unpack();
                            if (this._batteryLevel !== batteryLevel) {
                                this._batteryLevel = batteryLevel;
                                statusChanged = true;
                                this._updateAutoDischarge();
                            }
                        }

                        if ('State' in changedProps) {
                            const batteryState = changedProps.State.deep_unpack();
                            if (this._batteryState !== batteryState) {
                                this._batteryState = batteryState;
                                statusChanged = true;
                            }
                        }

                        if (statusChanged)
                            this.emit('battery-status-changed');
                    }, this);
                }
                displayDeviceReady = true;
                checkReady();
            });

            // Safety timeout to resolve even if proxies fail
            this._proxyInitTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                this._proxyInitTimeout = null;
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                if (!upowerReady || !displayDeviceReady) {
                    console.warn('Unified Power Manager: UPower proxy initialization timed out');
                    upowerReady = true;
                    displayDeviceReady = true;
                    checkReady();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    get isAvailable() {
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
        const sysfsStatus = readFile(this._statusPath);
        
        if (sysfsStatus === 'Not charging') return 'Not charging';
        if (sysfsStatus === 'Charging') return 'Charging';
        if (sysfsStatus === 'Discharging') return 'Discharging';
        if (sysfsStatus === 'Full') return 'Full';

        if (this._batteryState === 1) return 'Charging';
        if (this._batteryState === 2) return 'Discharging';
        if (this._batteryState === 4) return 'Full';

        return sysfsStatus || 'Unknown';
    }

    async setThresholds(startValue, endValue) {
        if (!this.isAvailable) return false;
        return this._device.setThresholds(startValue, endValue);
    }

    async setForceDischarge(enabled, isManual = true) {
        if (!this.isAvailable) return false;

        const success = await this._device.setForceDischarge(enabled);

        if (isManual) {
            console.log('Unified Power Manager: User manually toggled force discharge, stopping auto-management');
            this._autoManagementActive = false;

            if (this._settings.get_boolean('auto-manage-battery-levels')) {
                console.log('Unified Power Manager: Disabling auto-management due to manual override');
                this._settings.set_boolean('auto-manage-battery-levels', false);
            }
        }

        return success;
    }

    /**
     * Centralized logic to manage auto-discharge behavior.
     * Checks all conditions and enables/disables force discharge as needed.
     */
    _updateAutoDischarge() {
        if (!this.isAvailable || !this.supportsForceDischarge || this._destroyed)
            return;

        const autoManageEnabled = this._settings.get_boolean('auto-manage-battery-levels');

        // If auto-manage is disabled, ensure we are not holding the state active
        if (!autoManageEnabled) {
            this._autoManagementActive = false;
            return;
        }

        // Logic:
        // 1. If on battery, we should generally not force discharge (redundant/unsafe),
        //    unless we were already doing it and just unplugged (emergency stop).
        if (this._onBattery) {
            if (this.forceDischargeEnabled && this._autoManagementActive) {
                console.log('Unified Power Manager: Auto-discharge: On battery, disabling force discharge');
                this.setForceDischarge(false, false);
                this._autoManagementActive = false;
            }
            return;
        }

        const batteryLevel = this._batteryLevel;
        const startThreshold = this.currentStartThreshold;
        const endThreshold = this.currentEndThreshold;

        // 2. Start Condition: Above End Threshold + Hysteresis (on AC)
        if (batteryLevel > (endThreshold + AUTO_DISCHARGE_HYSTERESIS) && !this.forceDischargeEnabled) {
            console.log(`Unified Power Manager: Auto-discharge: Level ${batteryLevel}% > End ${endThreshold}% + ${AUTO_DISCHARGE_HYSTERESIS}%, enabling`);
            this.setForceDischarge(true, false);
            this._autoManagementActive = true;
        }
        // 3. Stop Condition: At or Below Start Threshold
        else if (batteryLevel <= startThreshold && this.forceDischargeEnabled && this._autoManagementActive) {
            console.log(`Unified Power Manager: Auto-discharge: Level ${batteryLevel}% <= Start ${startThreshold}%, disabling`);
            this.setForceDischarge(false, false);
            this._autoManagementActive = false;
        }
    }

    checkAutoManagement() {
        this._updateAutoDischarge();
    }
    
    // Kept for compatibility if StateManager calls it, but internally it's simpler now
    _cancelAutoManagement() {
        this._autoManagementActive = false;
    }

    async refreshValues() {
        if (this._device && typeof this._device.refreshValues === 'function') {
            await this._device.refreshValues();
        }
        this._batteryLevel = (await readFileIntAsync(this._capacityPath)) || this._batteryLevel;
        this._updateAutoDischarge();
    }

    destroy() {
        this._destroyed = true;

        if (this._initialAutoManageTimeout) {
            GLib.Source.remove(this._initialAutoManageTimeout);
            this._initialAutoManageTimeout = null;
        }

        if (this._proxyInitTimeout) {
            GLib.Source.remove(this._proxyInitTimeout);
            this._proxyInitTimeout = null;
        }

        this.disconnectObject(this);
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
