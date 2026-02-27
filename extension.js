/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const _ = (s) => Gettext.dgettext('hara-hachi-bu', s);

import {PowerProfileController} from './lib/powerProfileController.js';
import {BatteryThresholdController} from './lib/batteryThresholdController.js';
import {StateManager} from './lib/stateManager.js';
import {PowerManagerIndicator} from './lib/quickSettingsPanel.js';
import * as Helper from './lib/helper.js';
import * as ProfileMatcher from './lib/profileMatcher.js';
import {UIPatcher} from './lib/uiPatcher.js';

export default class HaraHachiBuExtension extends Extension {
    enable() {
        Helper.initExecCheck();
        this._destroyed = false;

        // If async init is still in-flight (rapid disable/enable cycle),
        // clearing _destroyed lets the in-flight init complete normally.
        if (this._initializing)
            return;

        this._settings = this.getSettings();
        this._powerManager = null;
        this._uiPatcher = null;

        ProfileMatcher.runMigrations(this._settings);
        this._initializePowerManager();
    }

    async _initializePowerManager() {
        this._initializing = true;

        try {
            this._powerController = new PowerProfileController();
            await this._powerController.initialize();
            if (this._destroyed) return;

            this._batteryController = new BatteryThresholdController(this._settings);
            await this._batteryController.initialize(this);
            if (this._destroyed) return;

            this._stateManager = new StateManager(this._settings, this._powerController, this._batteryController);
            await this._stateManager.initialize();
            if (this._destroyed) return;

            this._powerManager = new PowerManagerIndicator(this._settings, this, this._stateManager);
            if (this._destroyed) return;

            this._uiPatcher = new UIPatcher();

            if (this._settings.get_boolean('hide-builtin-power-profile'))
                this._uiPatcher.hideBuiltinPowerProfile();

            this._settings.connectObject(
                'changed::hide-builtin-power-profile',
                () => {
                    if (!this._uiPatcher) return;
                    if (this._settings.get_boolean('hide-builtin-power-profile'))
                        this._uiPatcher.hideBuiltinPowerProfile();
                    else this._uiPatcher.showBuiltinPowerProfile();
                },
                this
            );

            if (this._stateManager.batteryNeedsHelper && !this._settings.get_boolean('helper-notification-shown')) {
                this._settings.set_boolean('helper-notification-shown', true);
                Main.notify(
                    _('Hara Hachi Bu'),
                    _('Battery threshold control requires setup. Open Quick Settings \u2192 Power for instructions.')
                );
            }
        } catch (e) {
            this._powerController?.destroy();
            this._powerController = null;
            this._batteryController?.destroy();
            this._batteryController = null;
            this._stateManager?.destroy();
            this._stateManager = null;

            if (!this._destroyed) {
                console.error(`Hara Hachi Bu: Failed to initialize: ${e}`);
                console.error(e.stack);
                Main.notify(_('Hara Hachi Bu'), _('Failed to initialize. Check logs for details.'));
            }
        } finally {
            this._initializing = false;
            if (this._destroyed)
                this._destroyPowerManager();
        }
    }

    _destroyPowerManager() {
        if (this._settings) this._settings.disconnectObject(this);

        this._uiPatcher?.destroy();
        this._uiPatcher = null;

        this._powerManager?.destroy();
        this._powerManager = null;

        this._stateManager?.destroy();
        this._stateManager = null;

        this._batteryController?.destroy();
        this._batteryController = null;

        this._powerController?.destroy();
        this._powerController = null;
    }

    disable() {
        this._destroyed = true;

        if (!this._initializing)
            this._destroyPowerManager();

        Helper.destroyExecCheck();
        ProfileMatcher.resetCache();

        this._settings = null;
    }
}
