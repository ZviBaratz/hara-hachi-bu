/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ParameterDetector monitors system parameters for rule evaluation.
 * Signals:
 *   - 'parameter-changed': Emitted when any parameter changes (param: {name, value})
 */
'use strict';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import * as Helper from './helper.js';
import * as Constants from './constants.js';

const {readFileAsync} = Helper;

// Parameter definitions
export const PARAMETERS = {
    external_display: {
        name: 'external_display',
        label: 'External Display',
        values: ['connected', 'not_connected'],
        valueLabels: {
            connected: 'Connected',
            not_connected: 'Not Connected',
        },
    },
    power_source: {
        name: 'power_source',
        label: 'Power Source',
        values: ['ac', 'battery'],
        valueLabels: {
            ac: 'AC Power',
            battery: 'Battery',
        },
    },
    lid_state: {
        name: 'lid_state',
        label: 'Lid State',
        values: ['open', 'closed'],
        valueLabels: {
            open: 'Open',
            closed: 'Closed',
        },
    },
};

// Rule operators
export const OPERATORS = {
    is: {
        name: 'is',
        label: 'is',
        evaluate: (actual, expected) => actual === expected,
    },
    is_not: {
        name: 'is_not',
        label: 'is not',
        evaluate: (actual, expected) => actual !== expected,
    },
};

export const ParameterDetector = GObject.registerClass({
    Signals: {
        'parameter-changed': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
    },
}, class ParameterDetector extends GObject.Object {
    constructor() {
        super();
        this._monitorManager = null;
        this._upowerProxy = null;
        this._upowerProxyId = null;
        this._monitorsChangedId = null;
        this._debounceTimeoutId = null;
        this._initialized = false;

        // Current parameter values
        this._externalDisplayConnected = false;
        this._onBattery = false;
        this._lidClosed = false;
    }

    async initialize() {
        this._initializeDisplayMonitoring();
        await this._initializePowerSourceMonitoring();
        this._initializeLidStateMonitoring();
        this._initialized = true;
        return true;
    }

    _initializeDisplayMonitoring() {
        try {
            this._monitorManager = global.backend.get_monitor_manager();
            this._updateDisplayState();

            this._monitorsChangedId = this._monitorManager.connect(
                'monitors-changed',
                () => this._onMonitorsChanged()
            );
        } catch (e) {
            console.error(`Unified Power Manager: Failed to initialize display monitoring: ${e}`);
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
            const acOnlinePath = `${Constants.SYSFS_POWER_SUPPLY_PATH}/AC/online`;
            const acOnline = await readFileAsync(acOnlinePath);
            if (acOnline !== null) {
                this._onBattery = acOnline.trim() === '0';
            }

            const upowerProxyWrapper = Gio.DBusProxy.makeProxyWrapper(UPowerInterface);
            this._upowerProxy = new upowerProxyWrapper(
                Gio.DBus.system,
                Constants.UPOWER_BUS_NAME,
                Constants.UPOWER_OBJECT_PATH,
                (proxy, error) => {
                    if (error) {
                        console.error(`Unified Power Manager: Failed to create UPower proxy: ${error}`);
                        this._upowerProxy = null;
                        return;
                    }

                    // Update with authoritative values from UPower
                    const oldOnBattery = this._onBattery;
                    this._onBattery = this._upowerProxy.OnBattery;

                    if (this._upowerProxy.LidIsPresent) {
                        this._lidClosed = this._upowerProxy.LidIsClosed;
                    }

                    if (oldOnBattery !== this._onBattery) {
                        this.emit('parameter-changed', 'power_source', this._onBattery ? 'battery' : 'ac');
                    }

                    this._upowerProxyId = this._upowerProxy.connect('g-properties-changed', (proxy, changed) => {
                        const changedProps = changed.deep_unpack();

                        if ('OnBattery' in changedProps) {
                            const newValue = changedProps.OnBattery.deep_unpack();
                            if (this._onBattery !== newValue) {
                                this._onBattery = newValue;
                                this.emit('parameter-changed', 'power_source', this._onBattery ? 'battery' : 'ac');
                            }
                        }

                        if ('LidIsClosed' in changedProps) {
                            const newValue = changedProps.LidIsClosed.deep_unpack();
                            if (this._lidClosed !== newValue) {
                                this._lidClosed = newValue;
                                this.emit('parameter-changed', 'lid_state', this._lidClosed ? 'closed' : 'open');
                            }
                        }
                    });
                }
            );
        } catch (e) {
            console.error(`Unified Power Manager: Failed to initialize power source monitoring: ${e}`);
        }
    }

    _initializeLidStateMonitoring() {
        // Lid state is monitored via UPower proxy (initialized above)
        // Nothing additional needed here
    }

    _onMonitorsChanged() {
        // Debounce monitor changes
        if (this._debounceTimeoutId) {
            GLib.Source.remove(this._debounceTimeoutId);
            this._debounceTimeoutId = null;
        }

        this._debounceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._debounceTimeoutId = null;
            this._processMonitorChange();
            return GLib.SOURCE_REMOVE;
        });
    }

    _processMonitorChange() {
        const oldValue = this._externalDisplayConnected;
        this._updateDisplayState();

        if (oldValue !== this._externalDisplayConnected) {
            this.emit('parameter-changed', 'external_display',
                this._externalDisplayConnected ? 'connected' : 'not_connected');
        }
    }

    _updateDisplayState() {
        try {
            if (this._monitorManager && this._monitorManager.get_monitors) {
                const monitors = this._monitorManager.get_monitors();
                if (Array.isArray(monitors)) {
                    let externalCount = 0;
                    for (const monitor of monitors) {
                        if (!monitor.is_laptop_panel) {
                            externalCount++;
                        }
                    }
                    this._externalDisplayConnected = externalCount > 0;
                    return;
                }
            }

            // Fallback: count logical monitors
            const numMonitors = global.display.get_n_monitors();
            this._externalDisplayConnected = numMonitors > 1;
        } catch (e) {
            console.error(`Unified Power Manager: Error updating display state: ${e}`);
        }
    }

    /**
     * Get the current value of a parameter
     * @param {string} paramName - Parameter name
     * @returns {string|null} - Current value or null if unknown
     */
    getValue(paramName) {
        switch (paramName) {
        case 'external_display':
            return this._externalDisplayConnected ? 'connected' : 'not_connected';
        case 'power_source':
            return this._onBattery ? 'battery' : 'ac';
        case 'lid_state':
            return this._lidClosed ? 'closed' : 'open';
        default:
            return null;
        }
    }

    /**
     * Get all current parameter values
     * @returns {Object} - Map of parameter name to current value
     */
    getAllValues() {
        return {
            external_display: this.getValue('external_display'),
            power_source: this.getValue('power_source'),
            lid_state: this.getValue('lid_state'),
        };
    }

    /**
     * Check if lid state detection is supported
     * @returns {boolean}
     */
    get lidStateSupported() {
        return this._upowerProxy && this._upowerProxy.LidIsPresent;
    }

    /**
     * Get external display count (for backward compatibility)
     * @returns {number}
     */
    get externalDisplayCount() {
        if (!this._monitorManager || !this._monitorManager.get_monitors) {
            return this._externalDisplayConnected ? 1 : 0;
        }

        const monitors = this._monitorManager.get_monitors();
        if (Array.isArray(monitors)) {
            let count = 0;
            for (const monitor of monitors) {
                if (!monitor.is_laptop_panel) {
                    count++;
                }
            }
            return count;
        }

        return this._externalDisplayConnected ? 1 : 0;
    }

    destroy() {
        if (this._debounceTimeoutId) {
            GLib.Source.remove(this._debounceTimeoutId);
            this._debounceTimeoutId = null;
        }

        if (this._monitorsChangedId && this._monitorManager) {
            this._monitorManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._upowerProxyId && this._upowerProxy) {
            this._upowerProxy.disconnect(this._upowerProxyId);
            this._upowerProxyId = null;
        }

        this._monitorManager = null;
        this._upowerProxy = null;
        this._initialized = false;
    }
});
