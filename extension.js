/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import GLib from 'gi://GLib';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

const BUILTIN_INDICATOR_RETRY_MS = 500;

import {PowerProfileController} from './lib/powerProfileController.js';
import {BatteryThresholdController} from './lib/batteryThresholdController.js';
import {StateManager} from './lib/stateManager.js';
import {PowerManagerIndicator} from './lib/quickSettingsPanel.js';
import * as Helper from './lib/helper.js';
import * as ProfileMatcher from './lib/profileMatcher.js';

export default class UnifiedPowerManager extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._initializing = false;
        this._powerManager = null;
        this._builtinPowerProfile = null;
        this._builtinPowerProfileIndex = -1;
        this._hiddenMenuItems = null;
        this._hideBuiltinId = null;
        this._hideRetryTimeout = null;

        // Run pending migrations
        ProfileMatcher.runMigrations(this._settings);

        // Do not create panel if enable is triggered in lockscreen state
        if (!Main.sessionMode.isLocked && this._powerManager === null)
            this._initializePowerManager();

        // Handle session mode changes
        this._sessionId = Main.sessionMode.connect('updated', session => {
            if (session.currentMode === 'user' || session.parentMode === 'user') {
                if (this._powerManager === null)
                    this._initializePowerManager();
            } else if (session.currentMode === 'unlock-dialog') {
                this._destroyPowerManager();
            }
        });
    }

    async _initializePowerManager() {
        if (this._initializing || this._powerManager !== null)
            return;
        this._initializing = true;

        try {
            // Initialize controllers
            this._powerController = new PowerProfileController();
            await this._powerController.initialize();

            this._batteryController = new BatteryThresholdController(this._settings);
            await this._batteryController.initialize(this);

            // Initialize state manager
            this._stateManager = new StateManager(
                this._settings,
                this._powerController,
                this._batteryController
            );
            this._stateManager.initialize();

            // Create UI
            this._powerManager = new PowerManagerIndicator(
                this._settings,
                this,
                this._stateManager
            );

            // Hide built-in power profile if configured
            if (this._settings.get_boolean('hide-builtin-power-profile'))
                this._hideBuiltinPowerProfile();

            // Watch for setting changes
            this._hideBuiltinId = this._settings.connect('changed::hide-builtin-power-profile', () => {
                if (this._settings.get_boolean('hide-builtin-power-profile'))
                    this._hideBuiltinPowerProfile();
                else
                    this._showBuiltinPowerProfile();
            });

            console.log('Unified Power Manager: Extension initialized successfully');
        } catch (e) {
            console.error(`Unified Power Manager: Failed to initialize: ${e}`);
            console.error(e.stack);
            Main.notify(_('Unified Power Manager'), _('Failed to initialize. Check logs for details.'));
        } finally {
            this._initializing = false;
        }
    }

    _destroyPowerManager() {
        if (this._powerManager) {
            this._powerManager.destroy();
            this._powerManager = null;
        }

        if (this._stateManager) {
            this._stateManager.destroy();
            this._stateManager = null;
        }

        if (this._batteryController) {
            this._batteryController.destroy();
            this._batteryController = null;
        }

        if (this._powerController) {
            this._powerController.destroy();
            this._powerController = null;
        }
    }

    _hideBuiltinPowerProfile() {
        if (this._builtinPowerProfile)
            return; // Already hidden

        const found = this._tryHideBuiltinPowerProfile();

        if (!found && !this._hideRetryTimeout) {
            let retryCount = 0;
            const maxRetries = 10;

            // Retry in case indicator loads after extension
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

        // Search through indicators to find built-in power profile
        for (let i = 0; i < QuickSettingsMenu._indicators.get_n_children(); i++) {
            const indicator = QuickSettingsMenu._indicators.get_child_at_index(i);

            // Primary detection: exact title match for 'Power Mode'
            if (indicator.constructor.name === 'Indicator' &&
                indicator.quickSettingsItems &&
                indicator.quickSettingsItems.some(item => item.title === 'Power Mode')) {

                console.log(`Unified Power Manager: Found built-in power profile at index ${i}, hiding it`);

                // Store reference and position for restoration
                this._builtinPowerProfile = indicator;
                this._builtinPowerProfileIndex = i;

                // Hide the indicator container
                indicator.visible = false;

                // Remove each menu item from the Quick Settings menu grid
                // Store them so we can re-add them later if needed
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

            // Fallback detection: check for D-Bus proxy connection
            if (indicator.constructor.name === 'Indicator' &&
                indicator.quickSettingsItems &&
                indicator.quickSettingsItems.length > 0) {

                const toggle = indicator.quickSettingsItems[0];

                // Check if it has a _proxy connected to PowerProfiles service
                if (toggle._proxy && toggle._proxy.g_name === 'net.hadess.PowerProfiles') {
                    console.log(`Unified Power Manager: Found built-in power profile via D-Bus proxy at index ${i}, hiding it`);

                    this._builtinPowerProfile = indicator;
                    this._builtinPowerProfileIndex = i;

                    // Hide the indicator container
                    indicator.visible = false;

                    // Remove each menu item from the Quick Settings menu grid
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
            }
        }

        return false;
    }

    _showBuiltinPowerProfile() {
        if (this._builtinPowerProfile) {
            // Restore the indicator container
            this._builtinPowerProfile.visible = true;

            // Re-add menu items to Quick Settings
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

    disable() {
        console.log('Unified Power Manager: Disabling extension');

        // Cancel retry timeout if pending
        if (this._hideRetryTimeout) {
            GLib.source_remove(this._hideRetryTimeout);
            this._hideRetryTimeout = null;
        }

        // Disconnect hide-builtin setting watcher
        if (this._hideBuiltinId) {
            this._settings.disconnect(this._hideBuiltinId);
            this._hideBuiltinId = null;
        }

        // Always restore built-in indicator when extension disables
        this._showBuiltinPowerProfile();

        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = null;
        }

        this._destroyPowerManager();
        Helper.destroyExecCheck();

        this._hiddenMenuItems = null;
        this._settings = null;
    }
}
