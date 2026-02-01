/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * DisplayMonitor monitors external display connections for docking detection.
 */
'use strict';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

const MONITOR_CHANGE_DEBOUNCE_MS = 500;

export const DisplayMonitor = GObject.registerClass({
    Signals: {
        'display-connected': {},
        'display-disconnected': {},
    },
}, class DisplayMonitor extends GObject.Object {
    constructor() {
        super();
        this._monitorManager = global.backend.get_monitor_manager();
        this._externalDisplayCount = 0;
        this._initialized = false;
        this._monitorsChangedId = null;
        this._debounceTimeoutId = null;
    }

    initialize() {
        // CRITICAL FIX: Capture initial display count
        this._externalDisplayCount = this._updateDisplayCount();
        console.log(`Unified Power Manager: Display monitoring initialized with ${this._externalDisplayCount} external display(s)`);

        this._monitorsChangedId = this._monitorManager.connect(
            'monitors-changed',
            () => this._onMonitorsChanged()
        );

        this._initialized = true;
        return true;
    }

    _updateDisplayCount() {
        try {
            // Method 1: Physical Monitor Inspection (Preferred)
            // This works even if lid is closed (internal disabled) + external active
            if (this._monitorManager.get_monitors) {
                const monitors = this._monitorManager.get_monitors();
                let externalCount = 0;
                let internalCount = 0;
                let debugInfo = [];

                if (Array.isArray(monitors)) {
                    for (const monitor of monitors) {
                        const isBuiltin = monitor.is_laptop_panel;
                        const connector = monitor.connector || 'unknown';
                        
                        debugInfo.push(`${connector} (builtin: ${isBuiltin})`);
                        
                        if (isBuiltin) {
                            internalCount++;
                        } else {
                            externalCount++;
                        }
                    }

                    console.log(`Unified Power Manager: Monitors detected: ${debugInfo.join(', ')}`);
                    
                    // If we found ANY monitors (internal or external), trust this method
                    if (externalCount + internalCount > 0) {
                        if (externalCount > 0) {
                            console.log(`Unified Power Manager: Detected ${externalCount} physical external display(s)`);
                        } else {
                            console.log('Unified Power Manager: No physical external displays detected');
                        }
                        return externalCount;
                    }
                }
            }

            // Method 2: Fallback (Logical Monitor Counting)
            // Used if get_monitors() is unavailable or returns empty
            const numMonitors = global.display.get_n_monitors();

            if (numMonitors === 0) {
                console.log('Unified Power Manager: No monitors found (fallback)');
                return 0;
            }

            console.log(`Unified Power Manager: Checking ${numMonitors} logical monitor(s) (fallback)`);

            // Simple heuristic: if there's more than one monitor, count extras as external
            // This fails if lid is closed (1 external only), but is a safe fallback
            const externalCount = Math.max(0, numMonitors - 1);

            if (externalCount > 0) {
                console.log(`Unified Power Manager: Detected ${externalCount} external display(s) (fallback)`);
            } else {
                console.log('Unified Power Manager: No external displays detected (laptop display only) (fallback)');
            }

            return externalCount;
        } catch (e) {
            console.error(`Unified Power Manager: Critical error in _updateDisplayCount: ${e}`);
            console.error(e.stack);
            return 0;
        }
    }

    _onMonitorsChanged() {
        // Clear any pending debounce to restart the timer
        if (this._debounceTimeoutId) {
            GLib.source_remove(this._debounceTimeoutId);
            this._debounceTimeoutId = null;
        }

        this._debounceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_CHANGE_DEBOUNCE_MS, () => {
            this._debounceTimeoutId = null;
            this._processMonitorChange();
            return GLib.SOURCE_REMOVE;
        });
    }

    _processMonitorChange() {
        const newCount = this._updateDisplayCount();
        const oldCount = this._externalDisplayCount;

        console.log(`Unified Power Manager: Monitor change detected - old: ${oldCount}, new: ${newCount}`);

        // Update count BEFORE emitting signals so callbacks see the new value
        this._externalDisplayCount = newCount;

        if (newCount > oldCount) {
            console.log('Unified Power Manager: External display connected');
            this.emit('display-connected');
        } else if (newCount < oldCount) {
            console.log('Unified Power Manager: External display disconnected');
            this.emit('display-disconnected');
        } else {
            console.log('Unified Power Manager: Monitor configuration changed but external count unchanged');
        }
    }

    get externalDisplayCount() {
        return this._externalDisplayCount;
    }

    destroy() {
        if (this._debounceTimeoutId) {
            GLib.source_remove(this._debounceTimeoutId);
            this._debounceTimeoutId = null;
        }
        if (this._monitorsChangedId && this._monitorManager) {
            this._monitorManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._monitorManager = null;
        this._initialized = false;
    }
});
