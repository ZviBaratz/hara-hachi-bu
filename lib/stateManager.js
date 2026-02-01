/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * StateManager coordinates power and battery state across controllers.
 * Signals:
 *   - 'state-changed': Emitted when any state changes
 *   - 'power-mode-changed': Emitted when power mode changes (param: mode string)
 *   - 'battery-mode-changed': Emitted when battery mode changes (param: mode string)
 *   - 'profile-changed': Emitted when detected profile changes (param: profile string)
 */
'use strict';
import GObject from 'gi://GObject';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ProfileMatcher from './profileMatcher.js';
import {DisplayMonitor} from './displayMonitor.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

const {
    detectProfile,
    detectBatteryModeFromThresholds,
    getThresholdsForMode,
    getProfilesFromSettings,
    getProfileConfig,
    BATTERY_MODES,
    POWER_MODES,
} = ProfileMatcher;

export const StateManager = GObject.registerClass({
    Signals: {
        'state-changed': {},
        'power-mode-changed': {param_types: [GObject.TYPE_STRING]},
        'battery-mode-changed': {param_types: [GObject.TYPE_STRING]},
        'profile-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class StateManager extends GObject.Object {
    constructor(settings, powerController, batteryController) {
        super();
        this._settings = settings;
        this._powerController = powerController;
        this._batteryController = batteryController;

        this._currentPowerMode = 'balanced';
        this._currentBatteryMode = 'balanced';
        this._currentProfile = null;

        this._powerControllerId = null;
        this._batteryControllerIds = [];
        this._settingsIds = [];
        this._displayMonitor = null;
    }

    initialize() {
        // Get initial power mode from controller
        if (this._powerController && this._powerController.isAvailable)
            this._currentPowerMode = this._powerController.currentProfile;

        // Get initial battery mode from thresholds
        if (this._batteryController && this._batteryController.isAvailable) {
            const startThreshold = this._batteryController.currentStartThreshold;
            const endThreshold = this._batteryController.currentEndThreshold;
            const detectedMode = detectBatteryModeFromThresholds(startThreshold, endThreshold, this._settings);
            if (detectedMode)
                this._currentBatteryMode = detectedMode;
        }

        // Detect current profile
        this._updateProfile();

        // Connect to controller signals
        if (this._powerController) {
            this._powerControllerId = this._powerController.connect('power-profile-changed', (controller, profile) => {
                if (profile !== this._currentPowerMode) {
                    this._currentPowerMode = profile;
                    this._settings.set_string('current-power-mode', profile);
                    this._updateProfile();
                    this.emit('power-mode-changed', profile);
                    this.emit('state-changed');
                }
            });
        }

        if (this._batteryController) {
            this._batteryControllerIds = [];

            this._batteryControllerIds.push(
                this._batteryController.connect('threshold-changed', (controller, start, end) => {
                    const detectedMode = detectBatteryModeFromThresholds(start, end, this._settings);
                    if (detectedMode && detectedMode !== this._currentBatteryMode) {
                        this._currentBatteryMode = detectedMode;
                        this._settings.set_string('current-battery-mode', detectedMode);
                        this._updateProfile();
                        this.emit('battery-mode-changed', detectedMode);
                        this.emit('state-changed');
                    }
                })
            );

            // Listen for battery status changes (charging/discharging/full)
            this._batteryControllerIds.push(
                this._batteryController.connect('battery-status-changed', () => {
                    this.emit('state-changed');
                })
            );
        }

        // Connect to settings changes
        this._settingsIds.push(
            this._settings.connect('changed::custom-profiles', () => this._updateProfile()),
            // Keep old profile keys for backward compatibility during migration
            this._settings.connect('changed::profile-docked', () => this._updateProfile()),
            this._settings.connect('changed::profile-travel', () => this._updateProfile())
        );

        // Initialize display monitoring if enabled
        if (this._settings.get_boolean('docking-detection-enabled')) {
            this._initializeDisplayMonitoring();
        }

        // Watch for docking detection setting changes
        this._settingsIds.push(
            this._settings.connect('changed::docking-detection-enabled', () => {
                if (this._settings.get_boolean('docking-detection-enabled'))
                    this._initializeDisplayMonitoring();
                else
                    this._destroyDisplayMonitoring();
            })
        );
    }

    _initializeDisplayMonitoring() {
        if (this._displayMonitor)
            return;

        this._displayMonitor = new DisplayMonitor();
        this._displayMonitor.initialize();

        this._displayMonitor.connectObject(
            'display-connected', () => this._onDisplayConnected(),
            'display-disconnected', () => this._onDisplayDisconnected(),
            this
        );
    }

    async _onDisplayConnected() {
        const profileId = this._settings.get_string('docked-profile-id');
        if (!profileId || profileId.trim() === '') {
            console.warn('Unified Power Manager: Docked profile not configured, skipping automatic switch');
            return;
        }

        // Skip if already in the target profile
        if (this._currentProfile === profileId) {
            console.log(`Unified Power Manager: External display connected, already in '${profileId}' profile, skipping switch`);
            return;
        }

        console.log(`Unified Power Manager: External display connected, switching to '${profileId}' profile`);

        try {
            const success = await this.setProfile(profileId);
            if (!success) {
                console.warn(`Unified Power Manager: Failed to switch to docked profile '${profileId}'`);
            } else {
                console.log(`Unified Power Manager: Successfully switched to docked profile '${profileId}'`);
                // Show success notification
                const profileConfig = ProfileMatcher.getProfileById(this._settings, profileId);
                const profileName = profileConfig ? profileConfig.name : profileId;
                Main.notify(
                    _('Unified Power Manager'),
                    _('Switched to %s profile').format(profileName)
                );
            }
        } catch (e) {
            console.error(`Unified Power Manager: Error during automatic docked profile switch: ${e}`);
            console.error(e.stack);
            this._notifyError(
                _('Automatic Profile Switch'),
                _('Failed to switch to docked profile. See logs for details.')
            );
        }
    }

    async _onDisplayDisconnected() {
        // Only switch if all external displays are gone
        if (this._displayMonitor.externalDisplayCount > 0) {
            console.log(`Unified Power Manager: External display disconnected, but ${this._displayMonitor.externalDisplayCount} display(s) still connected`);
            return;
        }

        const profileId = this._settings.get_string('undocked-profile-id');
        if (!profileId || profileId.trim() === '') {
            console.warn('Unified Power Manager: Undocked profile not configured, skipping automatic switch');
            return;
        }

        // Skip if already in the target profile
        if (this._currentProfile === profileId) {
            console.log(`Unified Power Manager: All external displays disconnected, already in '${profileId}' profile, skipping switch`);
            return;
        }

        console.log(`Unified Power Manager: All external displays disconnected, switching to '${profileId}' profile`);

        try {
            const success = await this.setProfile(profileId);
            if (!success) {
                console.warn(`Unified Power Manager: Failed to switch to undocked profile '${profileId}'`);
            } else {
                console.log(`Unified Power Manager: Successfully switched to undocked profile '${profileId}'`);
                // Show success notification
                const profileConfig = ProfileMatcher.getProfileById(this._settings, profileId);
                const profileName = profileConfig ? profileConfig.name : profileId;
                Main.notify(
                    _('Unified Power Manager'),
                    _('Switched to %s profile').format(profileName)
                );
            }
        } catch (e) {
            console.error(`Unified Power Manager: Error during automatic undocked profile switch: ${e}`);
            console.error(e.stack);
            this._notifyError(
                _('Automatic Profile Switch'),
                _('Failed to switch to undocked profile. See logs for details.')
            );
        }
    }

    _destroyDisplayMonitoring() {
        if (this._displayMonitor) {
            this._displayMonitor.disconnectObject(this);
            this._displayMonitor.destroy();
            this._displayMonitor = null;
        }
    }

    _updateProfile() {
        const newProfile = detectProfile(this._currentPowerMode, this._currentBatteryMode, this._settings);

        if (newProfile !== this._currentProfile) {
            this._currentProfile = newProfile;
            this.emit('profile-changed', newProfile || 'custom');
        }
    }

    _notifyError(title, message) {
        Main.notify(_('Unified Power Manager'), `${title}: ${message}`);
    }

    get currentPowerMode() {
        return this._currentPowerMode;
    }

    get currentBatteryMode() {
        return this._currentBatteryMode;
    }

    get currentProfile() {
        return this._currentProfile;
    }

    get availablePowerModes() {
        if (this._powerController && this._powerController.isAvailable)
            return this._powerController.availableProfiles;
        return ['balanced'];
    }

    get availableBatteryModes() {
        if (this._batteryController && this._batteryController.isAvailable)
            return Object.keys(BATTERY_MODES);
        return [];
    }

    get batteryControlAvailable() {
        return this._batteryController && this._batteryController.isAvailable;
    }

    get batteryNeedsHelper() {
        return this._batteryController && this._batteryController.needsHelper;
    }

    get availableProfiles() {
        return ProfileMatcher.getAvailableProfiles(this._settings);
    }

    async setPowerMode(mode) {
        if (!this._powerController || !this._powerController.isAvailable) {
            this._notifyError('Power Mode', 'Power profile control is not available');
            return false;
        }

        const success = await this._powerController.setProfile(mode);
        if (success) {
            this._currentPowerMode = mode;
            this._settings.set_string('current-power-mode', mode);
            this._updateProfile();
            this.emit('power-mode-changed', mode);
            this.emit('state-changed');
        } else {
            this._notifyError('Power Mode', `Failed to set power mode to ${mode}`);
        }
        return success;
    }

    async setBatteryMode(mode) {
        if (!this._batteryController || !this._batteryController.isAvailable) {
            this._notifyError('Battery Mode', 'Battery threshold control is not available');
            return false;
        }

        const thresholds = getThresholdsForMode(mode, this._settings);
        if (!thresholds) {
            this._notifyError('Battery Mode', `Invalid battery mode: ${mode}`);
            return false;
        }

        const success = await this._batteryController.setThresholds(thresholds.start, thresholds.end);
        if (success) {
            this._currentBatteryMode = mode;
            this._settings.set_string('current-battery-mode', mode);
            this._updateProfile();
            this.emit('battery-mode-changed', mode);
            this.emit('state-changed');
        } else {
            this._notifyError('Battery Mode', `Failed to set battery thresholds. Make sure helper script is installed and you have proper permissions.`);
        }
        return success;
    }

    async setProfile(profileName) {
        const config = ProfileMatcher.getProfileById(this._settings, profileName);
        if (!config) {
            console.warn(`Unified Power Manager: Profile '${profileName}' not found in settings`);
            this._notifyError(
                _('Profile Switch Failed'),
                _('Profile "%s" does not exist.').format(profileName)
            );
            return false;
        }

        console.log(`Unified Power Manager: Switching to profile '${profileName}' (power: ${config.powerMode}, battery: ${config.batteryMode})`);

        // Set both power mode and battery mode
        let success = true;

        if (this._powerController && this._powerController.isAvailable) {
            const powerSuccess = await this.setPowerMode(config.powerMode);
            success = powerSuccess && success;
            if (!powerSuccess) {
                console.warn(`Unified Power Manager: Failed to set power mode to '${config.powerMode}' for profile '${profileName}'`);
            }
        } else {
            console.log(`Unified Power Manager: Power profile controller not available, skipping power mode for profile '${profileName}'`);
        }

        if (this._batteryController && this._batteryController.isAvailable) {
            const batterySuccess = await this.setBatteryMode(config.batteryMode);
            success = batterySuccess && success;
            if (!batterySuccess) {
                console.warn(`Unified Power Manager: Failed to set battery mode to '${config.batteryMode}' for profile '${profileName}'`);
            }
        } else {
            console.log(`Unified Power Manager: Battery threshold controller not available, skipping battery mode for profile '${profileName}'`);
        }

        if (success) {
            console.log(`Unified Power Manager: Successfully applied profile '${profileName}'`);
        } else {
            console.warn(`Unified Power Manager: Profile '${profileName}' applied with errors (partial success)`);
        }

        return success;
    }

    async setForceDischarge(enabled) {
        if (!this._batteryController || !this._batteryController.supportsForceDischarge) {
            this._notifyError('Force Discharge', 'Force discharge is not supported on this device');
            return false;
        }

        const success = await this._batteryController.setForceDischarge(enabled);
        if (success) {
            this._settings.set_boolean('force-discharge-enabled', enabled);
        } else {
            this._notifyError('Force Discharge', 'Failed to change force discharge mode');
        }
        return success;
    }

    get forceDischargeEnabled() {
        if (this._batteryController)
            return this._batteryController.forceDischargeEnabled;
        return false;
    }

    get supportsForceDischarge() {
        if (this._batteryController)
            return this._batteryController.supportsForceDischarge;
        return false;
    }

    get batteryLevel() {
        if (this._batteryController)
            return this._batteryController.batteryLevel;
        return 0;
    }

    getBatteryStatus() {
        if (this._batteryController)
            return this._batteryController.getBatteryStatus();
        return 'Unknown';
    }

    refreshState() {
        if (this._batteryController)
            this._batteryController.refreshValues();

        // Re-detect modes
        if (this._batteryController && this._batteryController.isAvailable) {
            const startThreshold = this._batteryController.currentStartThreshold;
            const endThreshold = this._batteryController.currentEndThreshold;
            const detectedMode = detectBatteryModeFromThresholds(startThreshold, endThreshold, this._settings);
            if (detectedMode)
                this._currentBatteryMode = detectedMode;
        }

        this._updateProfile();
        this.emit('state-changed');
    }

    destroy() {
        this._destroyDisplayMonitoring();

        if (this._powerControllerId && this._powerController) {
            this._powerController.disconnect(this._powerControllerId);
            this._powerControllerId = null;
        }

        if (this._batteryControllerIds.length > 0 && this._batteryController) {
            for (const id of this._batteryControllerIds)
                this._batteryController.disconnect(id);
            this._batteryControllerIds = [];
        }

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

        this._settings = null;
        this._powerController = null;
        this._batteryController = null;
    }
});
