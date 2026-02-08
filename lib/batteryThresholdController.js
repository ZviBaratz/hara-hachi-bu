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

const {readFileAsync, readFileIntAsync} = Helper;

const AUTO_DISCHARGE_HYSTERESIS = 1; // % buffer to prevent rapid toggling
const UPOWER_PROXY_TIMEOUT_MS = 5000;

export const BatteryThresholdController = GObject.registerClass({
    Signals: {
        'threshold-changed': {param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
        'battery-status-changed': {},
        'force-discharge-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'power-source-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'partial-failure': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
    },
}, class BatteryThresholdController extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;
        this._device = null;
        this._batteryLevel = 0;
        this._batteryState = 0;
        this._sysfsStatus = null; // Cached sysfs status
        this._onBattery = false;
        this._proxy = null;
        this._upowerProxy = null;
        this._initialized = false;
        this._capacityPath = null;
        this._statusPath = null;
        this._monitorStatus = null;

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

        // Expose device capability to prefs via settings
        this._settings.set_boolean('device-has-start-threshold', this._device?.hasStartThreshold ?? true);

        if (this._device) {
            // Set up fallback battery paths based on detected device
            // (Used for status reading when UPower is not ready)
            const batteryName = this._device.batteryName || 'BAT0';
            this._capacityPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.CAPACITY_FILE}`;
            this._statusPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.STATUS_FILE}`;

            // Connect to device signals using connectObject for auto-cleanup
            const signalHandlers = [
                'threshold-changed', (dev, start, end) => {
                    this.emit('threshold-changed', start, end);
                    this._updateAutoDischarge().catch(e => {
                        if (!this._destroyed)
                            console.error(`Unified Power Manager: Auto-discharge error: ${e.message}`);
                    });
                },
                'force-discharge-changed', (dev, enabled) => {
                    // Refresh sysfs status since file monitor may not fire on sysfs
                    this._updateSysfsStatus();
                    this.emit('force-discharge-changed', enabled);
                    // Update state if external change happened
                    if (!enabled && this._autoManagementActive) {
                        this._autoManagementActive = false;
                    }
                },
            ];

            // Forward partial-failure signal from CompositeDevice
            if (GObject.signal_lookup('partial-failure', this._device.constructor.$gtype)) {
                signalHandlers.push(
                    'partial-failure', (dev, succeededBat, failedBats) => {
                        this.emit('partial-failure', succeededBat, failedBats);
                    }
                );
            }

            this._device.connectObject(...signalHandlers, this);
        } else {
            console.debug('Unified Power Manager: No supported device found');
            // Fallback paths for basic monitoring without threshold control
            const bat1Exists = Helper.fileExists(`${Constants.SYSFS_POWER_SUPPLY_PATH}/BAT1/${Constants.CAPACITY_FILE}`);
            const batteryName = bat1Exists && !Helper.fileExists(`${Constants.SYSFS_POWER_SUPPLY_PATH}/BAT0/${Constants.CAPACITY_FILE}`) ? 'BAT1' : 'BAT0';
            
            this._capacityPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.CAPACITY_FILE}`;
            this._statusPath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${batteryName}/${Constants.STATUS_FILE}`;
        }

        // Initialize battery monitoring for status changes (UPower + Sysfs)
        await this._initializeBatteryMonitoring();

        // Initial read of battery level if UPower isn't ready
        if (this._batteryLevel === 0) {
            if (this._device && typeof this._device.getBatteryLevel === 'function') {
                this._batteryLevel = this._device.getBatteryLevel();
            } else {
                this._batteryLevel = (await readFileIntAsync(this._capacityPath)) || 0;
            }
        }
        
        // Initial read of sysfs status
        this._sysfsStatus = await readFileAsync(this._statusPath);

        // Initial auto-discharge check
        await this._updateAutoDischarge();

        this._initialized = true;
        return !!this._device;
    }

    async _initializeBatteryMonitoring() {
        // Initialize sysfs status monitoring first (fallback/supplement)
        this._initializeStatusMonitoring();
        
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

        // Initial sysfs check for onBattery state
        const acOnline = await Helper.getAcOnlineSysfs(
            Constants.SYSFS_POWER_SUPPLY_PATH,
            () => this._destroyed
        );
        if (acOnline !== null) {
            this._onBattery = !acOnline;
        }

        return new Promise((resolve) => {
            let upowerReady = false;
            let displayDeviceReady = false;

            const checkReady = () => {
                if (upowerReady && displayDeviceReady) {
                    if (this._proxyInitTimeout) {
                        GLib.Source.remove(this._proxyInitTimeout);
                        this._proxyInitTimeout = null;
                    }
                    resolve();
                }
            };

            const upowerProxyWrapper = Gio.DBusProxy.makeProxyWrapper(UPowerInterface);
            this._upowerProxy = new upowerProxyWrapper(Gio.DBus.system, Constants.UPOWER_BUS_NAME, Constants.UPOWER_OBJECT_PATH, (proxy, error) => {
                if (this._destroyed) {
                    upowerReady = true;
                    checkReady();
                    return;
                }
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
                            this._updateAutoDischarge().catch(e => {
                                if (!this._destroyed)
                                    console.error(`Unified Power Manager: Auto-discharge error: ${e.message}`);
                            });
                        }
                    }, this);
                }
                upowerReady = true;
                checkReady();
            });

            const powerManagerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceInterface);
            this._proxy = new powerManagerProxy(Gio.DBus.system, Constants.UPOWER_BUS_NAME, Constants.UPOWER_DEVICE_PATH, (proxy, error) => {
                if (this._destroyed) {
                    displayDeviceReady = true;
                    checkReady();
                    return;
                }
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
                                this._updateAutoDischarge().catch(e => {
                                    if (!this._destroyed)
                                        console.error(`Unified Power Manager: Auto-discharge error: ${e.message}`);
                                });
                            }
                        }

                        if ('State' in changedProps) {
                            const batteryState = changedProps.State.deep_unpack();
                            if (this._batteryState !== batteryState) {
                                this._batteryState = batteryState;
                                statusChanged = true;
                                // Sync sysfs cache since file monitor may not fire on sysfs
                                this._updateSysfsStatus();
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
            this._proxyInitTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPOWER_PROXY_TIMEOUT_MS, () => {
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

    _initializeStatusMonitoring() {
        if (this._monitorStatus) return;
        
        try {
            const statusFile = Gio.File.new_for_path(this._statusPath);
            if (!statusFile.query_exists(null)) return;
            
            this._monitorStatus = statusFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            
            this._monitorStatus.connectObject('changed', (obj, file, other, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                    this._updateSysfsStatus();
                }
            }, this);
        } catch (e) {
            console.error(`Unified Power Manager: Failed to initialize status monitor: ${e.message}`);
        }
    }

    async _updateSysfsStatus() {
        try {
            const status = await readFileAsync(this._statusPath);
            if (this._destroyed) return;
            if (status && status !== this._sysfsStatus) {
                this._sysfsStatus = status;
                this.emit('battery-status-changed');
            }
        } catch (e) {
            if (!this._destroyed)
                console.error(`Unified Power Manager: Error reading status: ${e.message}`);
        }
    }

    get canControlThresholds() {
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

    get hasStartThreshold() {
        if (!this._device) return false;
        return this._device.hasStartThreshold;
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

    /**
     * Get the current battery status (e.g. "Charging", "Discharging")
     * Returns a cached value to avoid blocking I/O.
     * @returns {string}
     */
    getBatteryStatus() {
        const sysfsStatus = this._sysfsStatus;
        
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
        if (!this.canControlThresholds) return false;
        return this._device.setThresholds(startValue, endValue);
    }

    async setForceDischarge(enabled, isManual = true) {
        if (!this.canControlThresholds) return false;

        let success;
        try {
            success = await this._device.setForceDischarge(enabled);
        } catch (e) {
            console.error(`Unified Power Manager: Error setting force discharge: ${e.message}`);
            return false;
        }

        if (isManual) {
            console.debug('Unified Power Manager: User manually toggled force discharge, stopping auto-management');
            this._autoManagementActive = false;

            if (this._settings.get_boolean('auto-manage-battery-levels')) {
                console.debug('Unified Power Manager: Disabling auto-management due to manual override');
                this._settings.set_boolean('auto-manage-battery-levels', false);
            }
        }

        return success;
    }

    /**
     * Centralized logic to manage auto-discharge behavior.
     * Checks all conditions and enables/disables force discharge as needed.
     */
    async _updateAutoDischarge() {
        if (!this.canControlThresholds || !this.supportsForceDischarge || this._destroyed)
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
            if (this.forceDischargeEnabled) {
                console.debug('Unified Power Manager: Auto-discharge: On battery, disabling force discharge');
                const success = await this.setForceDischarge(false, false);
                if (!success && !this._destroyed) {
                    console.debug(`Unified Power Manager: Auto-discharge disable failed (emergency stop on battery)`);
                }
                this._autoManagementActive = false;
            }
            return;
        }

        const batteryLevel = this._batteryLevel;
        const startThreshold = this.currentStartThreshold;
        const endThreshold = this.currentEndThreshold;

        // 2. Start Condition: Above End Threshold + Hysteresis (on AC)
        if (batteryLevel > (endThreshold + AUTO_DISCHARGE_HYSTERESIS) && !this.forceDischargeEnabled) {
            console.debug(`Unified Power Manager: Auto-discharge: Level ${batteryLevel}% > End ${endThreshold}% + ${AUTO_DISCHARGE_HYSTERESIS}%, enabling`);
            const success = await this.setForceDischarge(true, false);
            if (success) {
                this._autoManagementActive = true;
            } else if (!this._destroyed) {
                console.debug(`Unified Power Manager: Auto-discharge enable failed (battery: ${batteryLevel}%, threshold: ${endThreshold}%)`);
            }
        }
        // 3. Stop Condition: At or Below Start Threshold
        else if (batteryLevel <= startThreshold && this.forceDischargeEnabled) {
            console.debug(`Unified Power Manager: Auto-discharge: Level ${batteryLevel}% <= Start ${startThreshold}%, disabling`);
            const success = await this.setForceDischarge(false, false);
            if (success) {
                this._autoManagementActive = false;
            } else if (!this._destroyed) {
                console.debug(`Unified Power Manager: Auto-discharge disable failed (battery: ${batteryLevel}%, threshold: ${startThreshold}%)`);
            }
        }
    }

    async checkAutoManagement() {
        await this._updateAutoDischarge();
    }
    
    // Public method for StateManager to cancel auto-management
    cancelAutoManagement() {
        this._autoManagementActive = false;
    }

    async refreshValues() {
        if (this._device && typeof this._device.refreshValues === 'function') {
            await this._device.refreshValues();
        }
        
        // Update battery level from device if available, otherwise read from path
        if (this._device && typeof this._device.getBatteryLevel === 'function') {
            const level = this._device.getBatteryLevel();
            if (level != null) {
                this._batteryLevel = level;
            }
        } else {
            this._batteryLevel = (await readFileIntAsync(this._capacityPath)) ?? this._batteryLevel;
        }

        await this._updateSysfsStatus();
        await this._updateAutoDischarge();
    }

    destroy() {
        this._destroyed = true;

        if (this._proxyInitTimeout) {
            GLib.Source.remove(this._proxyInitTimeout);
            this._proxyInitTimeout = null;
        }
        
        if (this._monitorStatus) {
            this._monitorStatus.disconnectObject(this);
            this._monitorStatus.cancel();
            this._monitorStatus = null;
        }

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
