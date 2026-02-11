/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const _ = s => Gettext.dgettext('hara-hachi-bu', s);

import {PowerProfileController} from './lib/powerProfileController.js';
import {BatteryThresholdController} from './lib/batteryThresholdController.js';
import {StateManager} from './lib/stateManager.js';
import {PowerManagerIndicator} from './lib/quickSettingsPanel.js';
import * as Helper from './lib/helper.js';
import * as ProfileMatcher from './lib/profileMatcher.js';
import {UIPatcher} from './lib/uiPatcher.js';

export default class UnifiedPowerManager extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._initializing = false;
        this._pendingDestroy = false;
        this._powerManager = null;
        this._uiPatcher = null;
        this._hideBuiltinId = null;

        // Run pending migrations
        ProfileMatcher.runMigrations(this._settings);

        // Do not create panel if enable is triggered in lockscreen state
        if (!Main.sessionMode.isLocked && this._powerManager === null)
            this._initializePowerManager();
    }

    async _initializePowerManager() {
        if (this._initializing || this._powerManager !== null)
            return;
        this._initializing = true;

        try {
            // Initialize controllers
            this._powerController = new PowerProfileController();
            await this._powerController.initialize();
            if (this._pendingDestroy) return;

            this._batteryController = new BatteryThresholdController(this._settings);
            await this._batteryController.initialize(this);
            if (this._pendingDestroy) return;

            // Initialize state manager
            this._stateManager = new StateManager(
                this._settings,
                this._powerController,
                this._batteryController
            );
            await this._stateManager.initialize();
            if (this._pendingDestroy) return;

            // Create UI
            this._powerManager = new PowerManagerIndicator(
                this._settings,
                this,
                this._stateManager
            );
            if (this._pendingDestroy) return;

            // Initialize UI Patcher
            this._uiPatcher = new UIPatcher();

            // Hide built-in power profile if configured
            if (this._settings.get_boolean('hide-builtin-power-profile'))
                this._uiPatcher.hideBuiltinPowerProfile();

            // Watch for setting changes
            this._hideBuiltinId = this._settings.connect('changed::hide-builtin-power-profile', () => {
                if (!this._uiPatcher) return;
                if (this._settings.get_boolean('hide-builtin-power-profile'))
                    this._uiPatcher.hideBuiltinPowerProfile();
                else
                    this._uiPatcher.showBuiltinPowerProfile();
            });

            // Show one-time notification if helper script is missing
            if (this._stateManager.batteryNeedsHelper &&
                !this._settings.get_boolean('helper-notification-shown')) {
                this._settings.set_boolean('helper-notification-shown', true);
                Main.notify(
                    _('Hara Hachi Bu'),
                    _('Battery threshold control requires setup. Open Quick Settings \u2192 Power for instructions.')
                );
            }

            console.debug('Hara Hachi Bu: Extension initialized successfully');
        } catch (e) {
            // Clean up partially initialized controllers to prevent leaks
            // on next enable() call which would overwrite these fields
            this._powerController?.destroy();
            this._powerController = null;
            this._batteryController?.destroy();
            this._batteryController = null;
            this._stateManager?.destroy();
            this._stateManager = null;

            console.error(`Hara Hachi Bu: Failed to initialize: ${e}`);
            console.error(e.stack);
            Main.notify(_('Hara Hachi Bu'), _('Failed to initialize. Check logs for details.'));
        } finally {
            this._initializing = false;
            // If destroy was requested during initialization, run it now
            if (this._pendingDestroy) {
                this._pendingDestroy = false;
                this._destroyPowerManager();
            }
        }
    }

    _destroyPowerManager() {
        // If initialization is in progress, defer destruction
        if (this._initializing) {
            this._pendingDestroy = true;
            return;
        }

        // Disconnect hide-builtin setting watcher (prevent accumulation on lock/unlock)
        if (this._hideBuiltinId) {
            this._settings.disconnect(this._hideBuiltinId);
            this._hideBuiltinId = null;
        }

        if (this._uiPatcher) {
            this._uiPatcher.destroy();
            this._uiPatcher = null;
        }

        if (this._powerManager) {
            try {
                this._powerManager.destroy();
            } catch (e) {
                console.error(`Hara Hachi Bu: Error destroying PowerManager: ${e}`);
            }
            this._powerManager = null;
        }

        if (this._stateManager) {
            try {
                this._stateManager.destroy();
            } catch (e) {
                console.error(`Hara Hachi Bu: Error destroying StateManager: ${e}`);
            }
            this._stateManager = null;
        }

        if (this._batteryController) {
            try {
                this._batteryController.destroy();
            } catch (e) {
                console.error(`Hara Hachi Bu: Error destroying BatteryThresholdController: ${e}`);
            }
            this._batteryController = null;
        }

        if (this._powerController) {
            try {
                this._powerController.destroy();
            } catch (e) {
                console.error(`Hara Hachi Bu: Error destroying PowerProfileController: ${e}`);
            }
            this._powerController = null;
        }
    }

    disable() {
        console.debug('Hara Hachi Bu: Disabling extension');

        this._destroyPowerManager();
        Helper.destroyExecCheck();
        ProfileMatcher.resetCache();

        this._settings = null;
    }
}
