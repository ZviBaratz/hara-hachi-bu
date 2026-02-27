/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUILTIN_INDICATOR_RETRY_MS = 1000;

export class UIPatcher {
    constructor() {
        this._builtinPowerProfile = null;
        this._builtinPowerProfileIndex = -1;
        this._hiddenMenuItems = null;
        this._hideRetryTimeout = null;
    }

    hideBuiltinPowerProfile() {
        if (this._builtinPowerProfile) return; // Already hidden

        const found = this._tryHideBuiltinPowerProfile();

        if (!found && !this._hideRetryTimeout) {
            let retryCount = 0;
            const maxRetries = 10;

            console.debug(`Hara Hachi Bu: Built-in indicator not found, starting retry loop (${maxRetries} attempts)`);
            this._hideRetryTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUILTIN_INDICATOR_RETRY_MS, () => {
                retryCount++;
                const retryFound = this._tryHideBuiltinPowerProfile();

                if (retryFound) {
                    this._hideRetryTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }

                if (retryCount >= maxRetries) {
                    console.warn('Hara Hachi Bu: Built-in power profile indicator not found after maximum retries');
                    this._hideRetryTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _tryHideBuiltinPowerProfile() {
        const QuickSettingsMenu = Main.panel.statusArea.quickSettings;
        // Note: _indicators is a private property of QuickSettingsMenu. There is
        // no public API for indicator enumeration. Tested on GNOME 46–48.
        if (!QuickSettingsMenu || !QuickSettingsMenu._indicators) return false;

        const indicators = QuickSettingsMenu._indicators;
        const nItems = indicators.get_n_children();

        // Search through indicators to find built-in power profile
        for (let i = 0; i < nItems; i++) {
            const indicator = indicators.get_child_at_index(i);

            // Skip if not an indicator or doesn't have items
            if (!indicator.quickSettingsItems || indicator.quickSettingsItems.length === 0) continue;

            const toggle = indicator.quickSettingsItems[0];

            // Skip our own indicator
            if (toggle._isHaraHachiBu) continue;

            const toggleTitle = toggle.title || (toggle.label ? toggle.label.text : '');

            // Detection Strategy 1: Check proxy name (Standard for Power Profiles Daemon integration)
            // Note: _proxy is a private property of GNOME Shell's PowerProfileToggle.
            // No public API exists for identifying the built-in toggle. Tested on GNOME 46–48.
            if (toggle._proxy && toggle._proxy.g_name === 'net.hadess.PowerProfiles') return this._doHide(indicator, i);

            // Detection Strategy 2: Check for Title (Fallback)
            if (toggleTitle === 'Power Mode' || toggleTitle === 'Power Profiles') return this._doHide(indicator, i);

            // Detection Strategy 3: Check for specific icon names
            // Sometimes titles are localized, but icons remain constant
            // Note: Only use this if we haven't already identified the toggle by proxy or title
            if (toggle.gicon) {
                try {
                    const iconName = toggle.gicon.to_string();
                    if (iconName.includes('power-profile-balanced') || iconName.includes('power-profile-performance')) {
                        return this._doHide(indicator, i);
                    }
                } catch (e) {
                    console.debug('Hara Hachi Bu: gicon.to_string() unavailable:', e.message);
                }
            }
        }

        return false;
    }

    _doHide(indicator, index) {
        console.debug(`Hara Hachi Bu: Found built-in power profile at index ${index}, hiding it`);

        this._builtinPowerProfile = indicator;
        this._builtinPowerProfileIndex = index;

        indicator.visible = false;

        // Remove items from the Quick Settings grid to fully hide them
        // (setting visible=false alone doesn't remove from grid layout)
        this._hiddenMenuItems = [];
        indicator.quickSettingsItems.forEach((item) => {
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
            GLib.Source.remove(this._hideRetryTimeout);
            this._hideRetryTimeout = null;
        }

        if (this._builtinPowerProfile) {
            // Restore visibility
            this._builtinPowerProfile.visible = true;

            // Re-add items to the Quick Settings grid
            if (this._hiddenMenuItems && this._hiddenMenuItems.length > 0) {
                this._hiddenMenuItems.forEach(({item, parent}) => {
                    // Only add if not already added (sanity check)
                    if (parent && !item.get_parent()) parent.add_child(item);
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
