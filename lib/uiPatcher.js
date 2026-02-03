/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUILTIN_INDICATOR_RETRY_MS = 500;

export class UIPatcher {
    constructor() {
        this._builtinPowerProfile = null;
        this._builtinPowerProfileIndex = -1;
        this._hiddenMenuItems = null;
        this._hideRetryTimeout = null;
    }

    hideBuiltinPowerProfile() {
        if (this._builtinPowerProfile)
            return; // Already hidden

        const found = this._tryHideBuiltinPowerProfile();

        if (!found && !this._hideRetryTimeout) {
            let retryCount = 0;
            const maxRetries = 10;

            console.log(`Unified Power Manager: Built-in indicator not found, starting retry loop (${maxRetries} attempts)`);
            this._hideRetryTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUILTIN_INDICATOR_RETRY_MS, () => {
                retryCount++;
                const retryFound = this._tryHideBuiltinPowerProfile();
                
                if (retryFound) {
                    this._hideRetryTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }

                if (retryCount >= maxRetries) {
                    console.log('Unified Power Manager: Built-in power profile indicator not found after maximum retries');
                    this._hideRetryTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _tryHideBuiltinPowerProfile() {
        const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
        if (!QuickSettingsMenu || !QuickSettingsMenu._indicators) return false;

        // Search through indicators to find built-in power profile
        for (let i = 0; i < QuickSettingsMenu._indicators.get_n_children(); i++) {
            const indicator = QuickSettingsMenu._indicators.get_child_at_index(i);

            if (indicator.constructor.name === 'Indicator' &&
                indicator.quickSettingsItems &&
                indicator.quickSettingsItems.length > 0) {

                const toggle = indicator.quickSettingsItems[0];
                
                // Detection Strategy 1: Check proxy name (More robust)
                if (toggle._proxy && toggle._proxy.g_name === 'net.hadess.PowerProfiles') {
                    return this._doHide(indicator, i);
                }
                
                // Detection Strategy 2: Check for title (Fallback)
                if (indicator.quickSettingsItems.some(item => item.title === 'Power Mode')) {
                    return this._doHide(indicator, i);
                }
            }
        }

        return false;
    }

    _doHide(indicator, index) {
        console.log(`Unified Power Manager: Found built-in power profile at index ${index}, hiding it`);

        this._builtinPowerProfile = indicator;
        this._builtinPowerProfileIndex = index;

        indicator.visible = false;

        // Remove items from the Quick Settings grid to fully hide them
        // (setting visible=false alone doesn't remove from grid layout)
        this._hiddenMenuItems = [];
        indicator.quickSettingsItems.forEach(item => {
            const parent = item.get_parent();
            if (parent) {
                parent.remove_child(item);
                this._hiddenMenuItems.push({item, parent});
            }
        });

        return true;
    }

    showBuiltinPowerProfile() {
        // Cancel retry timeout if pending
        if (this._hideRetryTimeout) {
            GLib.source_remove(this._hideRetryTimeout);
            this._hideRetryTimeout = null;
        }

        if (this._builtinPowerProfile) {
            this._builtinPowerProfile.visible = true;

            // Re-add items to the Quick Settings grid
            if (this._hiddenMenuItems && this._hiddenMenuItems.length > 0) {
                this._hiddenMenuItems.forEach(({item, parent}) => {
                    if (parent && !item.get_parent()) {
                        parent.add_child(item);
                    }
                });
                this._hiddenMenuItems = null;
            }

            this._builtinPowerProfile = null;
            this._builtinPowerProfileIndex = -1;
        }
    }

    destroy() {
        this.showBuiltinPowerProfile();
    }
}
