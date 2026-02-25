/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ParameterDetector monitors system parameters for rule evaluation.
 * Signals:
 *   - 'parameter-changed': Emitted when any parameter changes (paramName: string, paramValue: string)
 */
'use strict';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import * as Helper from './helper.js';
import * as Constants from './constants.js';

const MONITOR_DEBOUNCE_MS = 500;
const PROXY_INIT_TIMEOUT_MS = 5000;

// Re-export from constants for backward compatibility
export const PARAMETERS = Constants.PARAMETERS;
export const OPERATORS = Constants.OPERATORS;

export const ParameterDetector = GObject.registerClass(
    {
        Signals: {
            'parameter-changed': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        },
    },
    class ParameterDetector extends GObject.Object {
        constructor() {
            super();
            this._monitorManager = null;
            this._upowerProxy = null;
            this._debounceTimeoutId = null;
            this._proxyInitTimeout = null;
            this._initialized = false;

            // Current parameter values
            this._externalDisplayConnected = false;
            this._onBattery = false;
            this._lidClosed = false;
            this._batteryLevel = '-1'; // String; -1 = unknown
            this._destroyed = false;
        }

        async initialize() {
            this._initializeDisplayMonitoring();
            await this._initializePowerSourceMonitoring();
            if (this._destroyed) return false;
            this._initialized = true;
            return true;
        }

        _initializeDisplayMonitoring() {
            try {
                this._monitorManager = global.backend.get_monitor_manager();
                this._updateDisplayState();

                this._monitorManager.connectObject('monitors-changed', () => this._onMonitorsChanged(), this);
            } catch (e) {
                console.error(`Hara Hachi Bu: Failed to initialize display monitoring: ${e}`);
            }
        }

        async _initializePowerSourceMonitoring() {
            const UPowerInterface = `
        <node>
          <interface name="org.freedesktop.UPower">
            <property name="OnBattery" type="b" access="read"/>
            <property name="LidIsClosed" type="b" access="read"/>
            <property name="LidIsPresent" type="b" access="read"/>
          </interface>
        </node>`;

            try {
                // Initialize from sysfs for immediate value
                const acOnline = await Helper.getAcOnlineSysfs(
                    Constants.SYSFS_POWER_SUPPLY_PATH,
                    () => this._destroyed
                );

                if (this._destroyed) return;

                if (acOnline !== null) this._onBattery = !acOnline;

                // Wrap proxy creation in a Promise to properly await completion
                await new Promise((resolve) => {
                    let resolved = false;

                    // Safety timeout to resolve even if D-Bus is unresponsive
                    this._proxyInitTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROXY_INIT_TIMEOUT_MS, () => {
                        this._proxyInitTimeout = null;
                        if (!resolved) {
                            resolved = true;
                            console.warn('Hara Hachi Bu: UPower proxy initialization timed out in ParameterDetector');
                            resolve();
                        }
                        return GLib.SOURCE_REMOVE;
                    });

                    const upowerProxyWrapper = Gio.DBusProxy.makeProxyWrapper(UPowerInterface);
                    this._upowerProxy = new upowerProxyWrapper(
                        Gio.DBus.system,
                        Constants.UPOWER_BUS_NAME,
                        Constants.UPOWER_OBJECT_PATH,
                        (proxy, error) => {
                            if (resolved || this._destroyed) {
                                if (!resolved) {
                                    resolved = true;
                                    resolve();
                                }
                                return;
                            }

                            resolved = true;
                            if (this._proxyInitTimeout) {
                                GLib.Source.remove(this._proxyInitTimeout);
                                this._proxyInitTimeout = null;
                            }

                            if (error) {
                                console.error(`Hara Hachi Bu: Failed to create UPower proxy: ${error}`);
                                this._upowerProxy = null;
                                resolve(); // Resolve even on error (degraded mode)
                                return;
                            }

                            // Update with authoritative values from UPower
                            const oldOnBattery = this._onBattery;
                            this._onBattery = this._upowerProxy.OnBattery;

                            if (this._upowerProxy.LidIsPresent) this._lidClosed = this._upowerProxy.LidIsClosed;

                            if (oldOnBattery !== this._onBattery)
                                this.emit('parameter-changed', 'power_source', this._onBattery ? 'battery' : 'ac');

                            this._upowerProxy.connectObject(
                                'g-properties-changed',
                                (_proxy, changed) => {
                                    if (this._destroyed) return;
                                    const changedProps = changed.deep_unpack();

                                    if ('OnBattery' in changedProps) {
                                        const newValue = changedProps.OnBattery.deep_unpack();
                                        if (this._onBattery !== newValue) {
                                            this._onBattery = newValue;
                                            this.emit(
                                                'parameter-changed',
                                                'power_source',
                                                this._onBattery ? 'battery' : 'ac'
                                            );
                                        }
                                    }

                                    if ('LidIsClosed' in changedProps) {
                                        const newValue = changedProps.LidIsClosed.deep_unpack();
                                        if (this._lidClosed !== newValue) {
                                            this._lidClosed = newValue;
                                            this.emit(
                                                'parameter-changed',
                                                'lid_state',
                                                this._lidClosed ? 'closed' : 'open'
                                            );
                                        }
                                    }
                                },
                                this
                            );

                            resolve(); // Resolve after proxy is ready
                        }
                    );
                });
            } catch (e) {
                console.error(`Hara Hachi Bu: Failed to initialize power source monitoring: ${e}`);
            }
        }

        _onMonitorsChanged() {
            // Debounce monitor changes
            if (this._debounceTimeoutId) {
                GLib.Source.remove(this._debounceTimeoutId);
                this._debounceTimeoutId = null;
            }

            this._debounceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_DEBOUNCE_MS, () => {
                this._debounceTimeoutId = null;
                this._processMonitorChange();
                return GLib.SOURCE_REMOVE;
            });
        }

        _processMonitorChange() {
            if (this._destroyed) return;
            const oldValue = this._externalDisplayConnected;
            this._updateDisplayState();

            if (oldValue !== this._externalDisplayConnected) {
                this.emit(
                    'parameter-changed',
                    'external_display',
                    this._externalDisplayConnected ? 'connected' : 'not_connected'
                );
            }
        }

        _isInternalMonitor(monitor) {
            // Check standard properties
            if ('is_laptop_panel' in monitor) return monitor.is_laptop_panel;
            if ('is_builtin' in monitor) return monitor.is_builtin;

            // Heuristic based on connector name
            let connector = null;
            if (typeof monitor.get_connector === 'function') connector = monitor.get_connector();
            else if (monitor.connector) connector = monitor.connector;

            if (connector && /^(eDP|LVDS|DSI)/i.test(connector)) return true;

            return false;
        }

        _updateDisplayState() {
            try {
                if (this._monitorManager && this._monitorManager.get_monitors) {
                    const monitors = this._monitorManager.get_monitors();
                    if (Array.isArray(monitors)) {
                        let externalCount = 0;
                        for (const monitor of monitors) {
                            if (!this._isInternalMonitor(monitor)) externalCount++;
                        }

                        this._externalDisplayConnected = externalCount > 0;
                        return;
                    }
                }

                // Fallback: count logical monitors
                const numMonitors = global.display.get_n_monitors();
                this._externalDisplayConnected = numMonitors > 1;
            } catch (e) {
                console.error(`Hara Hachi Bu: Error updating display state: ${e}`);
                this._externalDisplayConnected = false;
            }
        }

        /**
         * Get the current value of a parameter
         * @param paramName - Parameter name
         * @returns - Current value or null if unknown
         */
        getValue(paramName) {
            switch (paramName) {
                case 'external_display':
                    return this._externalDisplayConnected ? 'connected' : 'not_connected';
                case 'power_source':
                    return this._onBattery ? 'battery' : 'ac';
                case 'lid_state':
                    return this._lidClosed ? 'closed' : 'open';
                case 'battery_level':
                    return this._batteryLevel;
                default:
                    return null;
            }
        }

        /**
         * Get all current parameter values
         * @returns - Map of parameter name to current value
         */
        getAllValues() {
            return {
                external_display: this.getValue('external_display'),
                power_source: this.getValue('power_source'),
                lid_state: this.getValue('lid_state'),
                battery_level: this.getValue('battery_level'),
            };
        }

        /**
         * Check if lid state detection is supported
         * @returns
         */
        get lidStateSupported() {
            return this._upowerProxy && this._upowerProxy.LidIsPresent;
        }

        /**
         * Get external display count (for backward compatibility)
         * @returns
         */
        get externalDisplayCount() {
            if (!this._monitorManager || !this._monitorManager.get_monitors)
                return this._externalDisplayConnected ? 1 : 0;

            const monitors = this._monitorManager.get_monitors();
            if (Array.isArray(monitors)) {
                let count = 0;
                for (const monitor of monitors) {
                    if (!this._isInternalMonitor(monitor)) count++;
                }

                return count;
            }

            return this._externalDisplayConnected ? 1 : 0;
        }

        /**
         * Update battery level from external source (StateManager).
         * Emits 'parameter-changed' if value changed.
         * @param level - Battery percentage (0-100)
         */
        setBatteryLevel(level) {
            const strLevel = String(Math.round(level));
            if (this._batteryLevel !== strLevel) {
                this._batteryLevel = strLevel;
                this.emit('parameter-changed', 'battery_level', strLevel);
            }
        }

        destroy() {
            this._destroyed = true;

            if (this._proxyInitTimeout) {
                GLib.Source.remove(this._proxyInitTimeout);
                this._proxyInitTimeout = null;
            }

            if (this._debounceTimeoutId) {
                GLib.Source.remove(this._debounceTimeoutId);
                this._debounceTimeoutId = null;
            }

            if (this._monitorManager) this._monitorManager.disconnectObject(this);

            if (this._upowerProxy) {
                this._upowerProxy.disconnectObject(this);
                this._upowerProxy = null;
            }

            this._monitorManager = null;
            this._initialized = false;
        }
    }
);
