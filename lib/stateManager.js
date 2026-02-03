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
import GLib from 'gi://GLib';
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

        this._displayMonitor = null;

        this._lastDockedState = null;

        // Debounce for display events to prevent race conditions
        this._displayEventTimeout = null;
        this._displayEventDebounceMs = 500;
    }

    async initialize() {
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

        // Restore force-discharge state from settings
        if (this._batteryController && this._batteryController.supportsForceDischarge) {
            const desiredState = this._settings.get_boolean('force-discharge-enabled');
            const currentState = this._batteryController.forceDischargeEnabled;

            // Only apply if states don't match
            if (desiredState !== currentState) {
                const success = await this._batteryController.setForceDischarge(desiredState, false);
                if (!success) {
                    console.error(`Unified Power Manager: Failed to restore force-discharge state to ${desiredState}`);
                    if (this._batteryController.needsHelper) {
                        this._notifyError(
                            _('Setup Required'),
                            _('Helper script not installed. Open Settings → About to copy installation command.')
                        );
                    } else {
                        this._notifyError(
                            _('State Restoration'),
                            _('Failed to restore force-discharge mode. Check extension logs.')
                        );
                    }
                }
            }
        }

        // Detect current profile
        this._updateProfile();

        // Connect to controller signals
        if (this._powerController) {
            this._powerController.connectObject(
                'power-profile-changed', (controller, profile) => {
                    if (profile !== this._currentPowerMode) {
                        this._currentPowerMode = profile;
                        this._settings.set_string('current-power-mode', profile);
                        this._updateProfile();
                        this.emit('power-mode-changed', profile);
                        this.emit('state-changed');
                    }
                },
                this
            );
        }

        if (this._batteryController) {
            this._batteryController.connectObject(
                'threshold-changed', (controller, start, end) => {
                    const detectedMode = detectBatteryModeFromThresholds(start, end, this._settings);
                    if (detectedMode && detectedMode !== this._currentBatteryMode) {
                        this._currentBatteryMode = detectedMode;
                        this._settings.set_string('current-battery-mode', detectedMode);
                        this._updateProfile();
                        this.emit('battery-mode-changed', detectedMode);
                        this.emit('state-changed');
                    }
                },
                'battery-status-changed', () => {
                    this.emit('state-changed');
                },
                'power-source-changed', (controller, onBattery) => {
                    this._onPowerSourceChanged(onBattery);
                },
                'force-discharge-changed', (controller, enabled) => {
                    this.emit('state-changed');
                },
                this
            );
        }

        // Connect to settings changes
        this._settings.connectObject(
            'changed::custom-profiles', () => this._updateProfile(),
            // Keep old profile keys for backward compatibility during migration
            'changed::profile-docked', () => this._updateProfile(),
            'changed::profile-travel', () => this._updateProfile(),
            'changed::auto-manage-battery-levels', () => {
                const enabled = this._settings.get_boolean('auto-manage-battery-levels');
                if (this._batteryController) {
                    if (enabled) {
                        this._batteryController.checkAutoManagement();
                    } else {
                        this._batteryController._cancelAutoManagement();
                    }
                }
            },
            'changed::docking-detection-enabled', () => {
                if (this._settings.get_boolean('docking-detection-enabled'))
                    this._initializeDisplayMonitoring();
                else
                    this._destroyDisplayMonitoring();
            },
            'changed::power-source-detection-enabled', () => {
                // If enabled, trigger a check
                if (this._settings.get_boolean('power-source-detection-enabled'))
                    this._onPowerSourceChanged(this._batteryController.onBattery);
            },
            this
        );

        // Initialize display monitoring if enabled
        if (this._settings.get_boolean('docking-detection-enabled')) {
            this._initializeDisplayMonitoring();
        }

        // Trigger initial power source check if enabled
        if (this._settings.get_boolean('power-source-detection-enabled')) {
            this._onPowerSourceChanged(this._batteryController.onBattery);
        }
    }

    _initializeDisplayMonitoring() {
        if (this._displayMonitor)
            return;

        this._displayMonitor = new DisplayMonitor();
        this._displayMonitor.initialize();

        // Initialize state
        this._lastDockedState = this._displayMonitor.externalDisplayCount > 0;

        this._displayMonitor.connectObject(
            'display-connected', () => this._scheduleDisplayEvent(true),
            'display-disconnected', () => this._scheduleDisplayEvent(false),
            this
        );
    }

    /**
     * Schedule a display event with debouncing to prevent race conditions
     * from rapid monitor connect/disconnect events
     */
    _scheduleDisplayEvent(isConnect) {
        // Cancel any pending event
        if (this._displayEventTimeout) {
            GLib.Source.remove(this._displayEventTimeout);
            this._displayEventTimeout = null;
        }

        // Schedule the actual handler with debounce delay
        this._displayEventTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._displayEventDebounceMs, () => {
            this._displayEventTimeout = null;

            // Re-evaluate current docked state after debounce
            const isDocked = this._displayMonitor && this._displayMonitor.externalDisplayCount > 0;

            if (isDocked) {
                this._onDisplayConnected();
            } else {
                this._onDisplayDisconnected();
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    async _onDisplayConnected() {
        // Check if auto-switch is enabled
        if (!this._settings.get_boolean('auto-switch-enabled')) {
            console.log('Unified Power Manager: External display connected, but auto-switch is disabled. Skipping.');
            return;
        }

        // We are definitely docked if a display just connected
        const isDocked = true;
        const stateChanged = (this._lastDockedState !== isDocked);
        this._lastDockedState = isDocked;

        const profileId = this._settings.get_string('docked-profile-id');
        if (!profileId || profileId.trim() === '') {
            console.warn('Unified Power Manager: Docked profile not configured, skipping automatic switch');
            Main.notify(
                _('Unified Power Manager'),
                _('External display detected, but no docked profile is configured. Configure in extension settings.')
            );
            return;
        }

        console.log(`Unified Power Manager: External display connected, switching to '${profileId}' profile`);

        try {
            // Pass true for isAuto to indicate system-initiated switch
            const success = await this.setProfile(profileId, true);
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
        // Check if auto-switch is enabled
        if (!this._settings.get_boolean('auto-switch-enabled')) {
            console.log('Unified Power Manager: Display disconnected, but auto-switch is disabled. Skipping.');
            return;
        }

        const isDocked = this._displayMonitor.externalDisplayCount > 0;
        const stateChanged = (this._lastDockedState !== isDocked);
        this._lastDockedState = isDocked;

        // If we are still docked, we enforce the docked profile (unless overridden above)
        // If we are undocked, we switch to undocked profile
        const targetProfileKey = isDocked ? 'docked-profile-id' : 'undocked-profile-id';
        const profileId = this._settings.get_string(targetProfileKey);

        if (!profileId || profileId.trim() === '') {
            console.warn(`Unified Power Manager: ${isDocked ? 'Docked' : 'Undocked'} profile not configured, skipping automatic switch`);
            Main.notify(
                _('Unified Power Manager'),
                _('%s profile not configured. Configure in extension settings.').format(isDocked ? _('Docked') : _('Undocked'))
            );
            return;
        }

        console.log(`Unified Power Manager: Display disconnected (count: ${this._displayMonitor.externalDisplayCount}), switching to '${profileId}' profile`);

        try {
            const success = await this.setProfile(profileId, true);
            if (!success) {
                console.warn(`Unified Power Manager: Failed to switch to profile '${profileId}'`);
            } else {
                console.log(`Unified Power Manager: Successfully switched to profile '${profileId}'`);
                // Show success notification
                const profileConfig = ProfileMatcher.getProfileById(this._settings, profileId);
                const profileName = profileConfig ? profileConfig.name : profileId;
                Main.notify(
                    _('Unified Power Manager'),
                    _('Switched to %s profile').format(profileName)
                );
            }
        } catch (e) {
            console.error(`Unified Power Manager: Error during automatic profile switch: ${e}`);
            console.error(e.stack);
            this._notifyError(
                _('Automatic Profile Switch'),
                _('Failed to switch profile. See logs for details.')
            );
        }
    }

    async _onPowerSourceChanged(onBattery) {
        if (!this._settings.get_boolean('power-source-detection-enabled'))
            return;

        // Check if auto-switch is enabled
        if (!this._settings.get_boolean('auto-switch-enabled')) {
            console.log('Unified Power Manager: Power source changed, but auto-switch is disabled. Skipping.');
            return;
        }

        // If we have docking detection enabled and we are docked, docking detection has priority
        if (this._settings.get_boolean('docking-detection-enabled') && 
            this._displayMonitor && this._displayMonitor.externalDisplayCount > 0) {
            console.log('Unified Power Manager: Power source changed but system is docked. Docked profile has priority.');
            return;
        }

        const profileId = onBattery 
            ? this._settings.get_string('battery-profile-id')
            : this._settings.get_string('ac-profile-id');

        if (!profileId || profileId.trim() === '') {
            console.warn(`Unified Power Manager: ${onBattery ? 'Battery' : 'AC'} profile not configured, skipping automatic switch`);
            Main.notify(
                _('Unified Power Manager'),
                _('%s profile not configured. Configure in extension settings.').format(onBattery ? _('Battery') : _('AC'))
            );
            return;
        }

        console.log(`Unified Power Manager: Power source changed to ${onBattery ? 'Battery' : 'AC'}, switching to '${profileId}' profile`);

        try {
            const success = await this.setProfile(profileId, true);
            if (success) {
                const profileConfig = ProfileMatcher.getProfileById(this._settings, profileId);
                const profileName = profileConfig ? profileConfig.name : profileId;
                Main.notify(
                    _('Unified Power Manager'),
                    _('Power source: %s. Switched to %s profile').format(onBattery ? _('Battery') : _('AC'), profileName)
                );
            }
        } catch (e) {
            console.error(`Unified Power Manager: Error during automatic power source profile switch: ${e}`);
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

    async setPowerMode(mode, updateOverrideFlag = true) {
        if (!this._powerController || !this._powerController.isAvailable) {
            this._notifyError('Power Mode', 'Power profile control is not available. Install power-profiles-daemon.');
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
            this._notifyError('Power Mode', `Failed to set power mode to ${mode}. Check that power-profiles-daemon is running.`);
        }
        return success;
    }

    async setBatteryMode(mode, updateOverrideFlag = true) {
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
            // Provide actionable error message based on common failure causes
            if (this._batteryController.needsHelper) {
                this._notifyError(
                    _('Setup Required'),
                    _('Helper script not installed. Open Settings → About to copy installation command.')
                );
            } else {
                this._notifyError(
                    _('Battery Mode'),
                    _('Failed to set battery thresholds. Check extension logs for details.')
                );
            }
        }
        return success;
    }

    /**
     * Apply a profile by setting both power mode and battery mode.
     *
     * @param {string} profileName - Profile ID to apply
     * @param {boolean} isAuto - True if triggered by automatic detection (docking/power source)
     * @returns {Promise<boolean>} - Success status
     */
    async setProfile(profileName, isAuto = false) {
        const config = ProfileMatcher.getProfileById(this._settings, profileName);
        if (!config) {
            console.warn(`Unified Power Manager: Profile '${profileName}' not found in settings`);
            this._notifyError(
                _('Profile Switch Failed'),
                _('Profile "%s" does not exist.').format(profileName)
            );
            return false;
        }

        console.log(`Unified Power Manager: Switching to profile '${profileName}' (power: ${config.powerMode}, battery: ${config.batteryMode}, auto: ${isAuto})`);

        // Set both power mode and battery mode
        // Pass updateOverrideFlag=false to prevent nested calls from modifying behavior
        let success = true;

        if (this._powerController && this._powerController.isAvailable) {
            const powerSuccess = await this.setPowerMode(config.powerMode, false);
            success = powerSuccess && success;
            if (!powerSuccess) {
                console.warn(`Unified Power Manager: Failed to set power mode to '${config.powerMode}' for profile '${profileName}'`);
            }
        } else {
            console.log(`Unified Power Manager: Power profile controller not available, skipping power mode for profile '${profileName}'`);
        }

        if (this._batteryController && this._batteryController.isAvailable) {
            const batterySuccess = await this.setBatteryMode(config.batteryMode, false);
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
            console.warn(`Unified Power Manager: Profile '${profileName}' applied with errors`);
            this._notifyError(
                _('Profile Partially Applied'),
                _('Profile "%s" could not be fully applied. Check extension logs for details.').format(config.name || profileName)
            );
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

    get batteryHealth() {
        if (this._batteryController)
            return this._batteryController.batteryHealth;
        return null;
    }

    get timeToEmpty() {
        if (this._batteryController)
            return this._batteryController.timeToEmpty;
        return 0;
    }

    get timeToFull() {
        if (this._batteryController)
            return this._batteryController.timeToFull;
        return 0;
    }

    get onBattery() {
        if (this._batteryController)
            return this._batteryController.onBattery;
        return false;
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
        // Cancel any pending display event
        if (this._displayEventTimeout) {
            GLib.Source.remove(this._displayEventTimeout);
            this._displayEventTimeout = null;
        }

        this._destroyDisplayMonitoring();

        if (this._powerController) {
            this._powerController.disconnectObject(this);
            this._powerController = null;
        }

        if (this._batteryController) {
            this._batteryController.disconnectObject(this);
            this._batteryController = null;
        }

        if (this._settings) {
            this._settings.disconnectObject(this);
            this._settings = null;
        }
    }
});
