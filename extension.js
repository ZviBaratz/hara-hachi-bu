'use strict';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

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
        this._this._powerManager = null;
        this._builtinPowerProfile = null;
        this._builtinPowerProfileIndex = -1;
        this._hideBuiltinId = null;

        // Run migration on first load
        ProfileMatcher.migrateProfilesToCustomFormat(this._settings);

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
            console.log(`Unified Power Manager: Failed to initialize: ${e}`);
            console.log(e.stack);
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

        const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

        // Search through indicators to find built-in power profile
        for (let i = 0; i < QuickSettingsMenu._indicators.get_n_children(); i++) {
            const indicator = QuickSettingsMenu._indicators.get_child_at_index(i);

            // Identify by class name or by examining menu items
            if (indicator.constructor.name === 'Indicator' &&
                indicator.quickSettingsItems &&
                indicator.quickSettingsItems.some(item =>
                    item.title === 'Power Mode' ||
                    item.title === 'Power Profile')) {

                // Store reference and position for restoration
                this._builtinPowerProfile = indicator;
                this._builtinPowerProfileIndex = i;

                // Hide by setting visible to false
                indicator.visible = false;
                return;
            }
        }
    }

    _showBuiltinPowerProfile() {
        if (this._builtinPowerProfile) {
            this._builtinPowerProfile.visible = true;
            this._builtinPowerProfile = null;
            this._builtinPowerProfileIndex = -1;
        }
    }

    disable() {
        console.log('Unified Power Manager: Disabling extension');

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

        this._settings = null;
    }
}
