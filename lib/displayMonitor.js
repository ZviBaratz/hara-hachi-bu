/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * DisplayMonitor monitors external display connections for docking detection.
 */
'use strict';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

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
            const numMonitors = global.display.get_n_monitors();

            if (numMonitors === 0) {
                console.log('Unified Power Manager: No monitors found');
                return 0;
            }

            console.log(`Unified Power Manager: Checking ${numMonitors} monitor(s)`);

            // Simple heuristic: if there's more than one monitor, count extras as external
            // On a laptop, the first monitor is typically the built-in display
            // This is a pragmatic approach that works for most docking scenarios
            const externalCount = Math.max(0, numMonitors - 1);

            // Enhanced logging for debugging
            if (externalCount > 0) {
                console.log(`Unified Power Manager: Detected ${externalCount} external display(s)`);
            } else {
                console.log('Unified Power Manager: No external displays detected (laptop display only)');
            }

            return externalCount;
        } catch (e) {
            console.error(`Unified Power Manager: Critical error in _updateDisplayCount: ${e}`);
            console.error(e.stack);
            return 0;
        }
    }

    _onMonitorsChanged() {
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
        if (this._monitorsChangedId && this._monitorManager) {
            this._monitorManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._monitorManager = null;
        this._initialized = false;
    }
});
