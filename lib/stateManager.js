'use strict';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ProfileMatcher from './profileMatcher.js';

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
        this._batteryControllerId = null;
        this._settingsIds = [];
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
            this._batteryControllerId = this._batteryController.connect('threshold-changed', (controller, start, end) => {
                const detectedMode = detectBatteryModeFromThresholds(start, end, this._settings);
                if (detectedMode && detectedMode !== this._currentBatteryMode) {
                    this._currentBatteryMode = detectedMode;
                    this._settings.set_string('current-battery-mode', detectedMode);
                    this._updateProfile();
                    this.emit('battery-mode-changed', detectedMode);
                    this.emit('state-changed');
                }
            });
        }

        // Connect to settings changes
        this._settingsIds.push(
            this._settings.connect('changed::custom-profiles', () => this._updateProfile()),
            // Keep old profile keys for backward compatibility during migration
            this._settings.connect('changed::profile-docked', () => this._updateProfile()),
            this._settings.connect('changed::profile-travel', () => this._updateProfile())
        );
    }

    _updateProfile() {
        const newProfile = detectProfile(this._currentPowerMode, this._currentBatteryMode, this._settings);

        if (newProfile !== this._currentProfile) {
            this._currentProfile = newProfile;
            this.emit('profile-changed', newProfile || 'custom');
        }
    }

    _notifyError(title, message) {
        Main.notify('Unified Power Manager', `${title}: ${message}`);
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
        if (!config)
            return false;

        // Set both power mode and battery mode
        let success = true;

        if (this._powerController && this._powerController.isAvailable)
            success = await this.setPowerMode(config.powerMode) && success;

        if (this._batteryController && this._batteryController.isAvailable)
            success = await this.setBatteryMode(config.batteryMode) && success;

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
        if (this._powerControllerId && this._powerController) {
            this._powerController.disconnect(this._powerControllerId);
            this._powerControllerId = null;
        }

        if (this._batteryControllerId && this._batteryController) {
            this._batteryController.disconnect(this._batteryControllerId);
            this._batteryControllerId = null;
        }

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

        this._settings = null;
        this._powerController = null;
        this._batteryController = null;
    }
});
