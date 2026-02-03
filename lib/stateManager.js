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
 *   - 'auto-manage-paused-changed': Emitted when auto-manage pause state changes (param: boolean)
 */
'use strict';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ProfileMatcher from './profileMatcher.js';
import {ParameterDetector} from './parameterDetector.js';
import * as RuleEvaluator from './ruleEvaluator.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

const {
    detectProfile,
    detectBatteryModeFromThresholds,
    getThresholdsForMode,
    getProfilesFromSettings,
    getProfileConfig,
    getCustomProfiles,
    BATTERY_MODES,
    POWER_MODES,
} = ProfileMatcher;

export const StateManager = GObject.registerClass({
    Signals: {
        'state-changed': {},
        'power-mode-changed': {param_types: [GObject.TYPE_STRING]},
        'battery-mode-changed': {param_types: [GObject.TYPE_STRING]},
        'profile-changed': {param_types: [GObject.TYPE_STRING]},
        'auto-manage-paused-changed': {param_types: [GObject.TYPE_BOOLEAN]},
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

        // New rule-based system
        this._parameterDetector = null;
        this._autoManagePaused = false;

        // Legacy display monitor (kept for backward compatibility during transition)
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

        // Restore auto-manage paused state
        this._autoManagePaused = this._settings.get_boolean('auto-manage-paused');

        // Detect current profile
        this._updateProfile();

        // Initialize the unified parameter detector
        this._initializeParameterDetector();

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
            'changed::auto-switch-enabled', () => {
                // When auto-switch is re-enabled, unpause and evaluate rules
                if (this._settings.get_boolean('auto-switch-enabled')) {
                    this._setAutoManagePaused(false);
                    this._evaluateAndApplyRules();
                }
            },
            'changed::auto-manage-paused', () => {
                const paused = this._settings.get_boolean('auto-manage-paused');
                if (this._autoManagePaused !== paused) {
                    this._autoManagePaused = paused;
                    this.emit('auto-manage-paused-changed', paused);
                }
            },
            // Legacy settings - kept for backward compatibility during migration
            'changed::docking-detection-enabled', () => {
                // No-op: Now handled by rule-based system
            },
            'changed::power-source-detection-enabled', () => {
                // No-op: Now handled by rule-based system
            },
            this
        );

        // Perform initial rule evaluation if auto-switch is enabled and not paused
        if (this._settings.get_boolean('auto-switch-enabled') && !this._autoManagePaused) {
            // Delay initial evaluation to ensure all components are ready
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._evaluateAndApplyRules();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _initializeParameterDetector() {
        if (this._parameterDetector)
            return;

        this._parameterDetector = new ParameterDetector();
        this._parameterDetector.initialize();

        this._parameterDetector.connectObject(
            'parameter-changed', (detector, paramName, paramValue) => {
                this._onParameterChanged(paramName, paramValue);
            },
            this
        );
    }

    _onParameterChanged(paramName, paramValue) {
        console.log(`Unified Power Manager: Parameter changed: ${paramName} = ${paramValue}`);

        // If auto-switch is disabled, do nothing
        if (!this._settings.get_boolean('auto-switch-enabled')) {
            return;
        }

        // If paused and resume-on-state-change is enabled, unpause
        if (this._autoManagePaused && this._settings.get_boolean('resume-on-state-change')) {
            console.log('Unified Power Manager: State changed, resuming auto-management');
            this._setAutoManagePaused(false);
        }

        // If not paused, evaluate rules
        if (!this._autoManagePaused) {
            this._scheduleRuleEvaluation();
        }
    }

    /**
     * Schedule rule evaluation with debouncing
     */
    _scheduleRuleEvaluation() {
        if (this._ruleEvaluationTimeout) {
            GLib.Source.remove(this._ruleEvaluationTimeout);
        }

        this._ruleEvaluationTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._ruleEvaluationTimeout = null;
            this._evaluateAndApplyRules();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Evaluate profile rules and apply matching profile
     */
    async _evaluateAndApplyRules() {
        if (!this._parameterDetector) {
            return;
        }

        const currentParams = this._parameterDetector.getAllValues();
        const profiles = getCustomProfiles(this._settings);

        const matchingProfile = RuleEvaluator.findMatchingProfile(profiles, currentParams);

        if (matchingProfile) {
            // Only switch if it's a different profile
            if (matchingProfile.id !== this._currentProfile) {
                console.log(`Unified Power Manager: Rule matched profile "${matchingProfile.name}"`);
                await this._applyProfile(matchingProfile, true);
            }
        }
        // If no match, stay on current profile (no change)
    }

    /**
     * Apply a profile (internal helper)
     */
    async _applyProfile(profile, isAuto = false) {
        const success = await this.setProfile(profile.id, isAuto);

        if (success && isAuto) {
            Main.notify(
                _('Unified Power Manager'),
                _('Switched to %s profile').format(profile.name)
            );
        }

        return success;
    }

    /**
     * Set the auto-manage paused state
     */
    _setAutoManagePaused(paused) {
        if (this._autoManagePaused !== paused) {
            this._autoManagePaused = paused;
            this._settings.set_boolean('auto-manage-paused', paused);
            this.emit('auto-manage-paused-changed', paused);
            console.log(`Unified Power Manager: Auto-manage ${paused ? 'paused' : 'resumed'}`);
        }
    }

    /**
     * Check if auto-management is currently paused
     */
    get autoManagePaused() {
        return this._autoManagePaused;
    }

    /**
     * Pause auto-management (called on manual override)
     */
    pauseAutoManage() {
        this._setAutoManagePaused(true);
    }

    /**
     * Resume auto-management
     */
    resumeAutoManage() {
        this._setAutoManagePaused(false);
        this._evaluateAndApplyRules();
    }

    // Legacy display monitoring (kept for backward compatibility)
    _initializeDisplayMonitoring() {
        if (this._displayMonitor)
            return;

        // Use parameter detector instead
        if (!this._parameterDetector) {
            this._initializeParameterDetector();
        }

        // Initialize last docked state from parameter detector
        this._lastDockedState = this._parameterDetector &&
            this._parameterDetector.getValue('external_display') === 'connected';
    }

    // Legacy methods kept for backward compatibility - now handled by rule-based system
    _scheduleDisplayEvent(isConnect) {
        // Deprecated: Now handled by ParameterDetector
    }

    async _onDisplayConnected() {
        // Deprecated: Now handled by rule-based system
    }

    async _onDisplayDisconnected() {
        // Deprecated: Now handled by rule-based system
    }

    async _onPowerSourceChanged(onBattery) {
        // Deprecated: Now handled by rule-based system
        // Battery controller still emits this signal, but we handle it via ParameterDetector
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
     * @param {boolean} isAuto - True if triggered by automatic detection (rules)
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

        console.log(`Unified Power Manager: Switching to profile '${profileName}' (power: ${config.powerMode}, battery: ${config.batteryMode}, forceDischarge: ${config.forceDischarge || 'unspecified'}, auto: ${isAuto})`);

        // If this is a manual switch and auto-switch is enabled, pause auto-management
        if (!isAuto && this._settings.get_boolean('auto-switch-enabled')) {
            this._setAutoManagePaused(true);
        }

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

        // Handle force discharge preference
        if (config.forceDischarge && config.forceDischarge !== 'unspecified') {
            if (this._batteryController && this._batteryController.supportsForceDischarge) {
                const desiredState = config.forceDischarge === 'on';
                // Only change if we're on AC (force discharge on battery doesn't make sense)
                if (!this._batteryController.onBattery || !desiredState) {
                    const fdSuccess = await this._batteryController.setForceDischarge(desiredState, false);
                    if (fdSuccess) {
                        this._settings.set_boolean('force-discharge-enabled', desiredState);
                    } else {
                        console.warn(`Unified Power Manager: Failed to set force discharge to ${desiredState} for profile '${profileName}'`);
                    }
                }
            }
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

        // Cancel any pending rule evaluation
        if (this._ruleEvaluationTimeout) {
            GLib.Source.remove(this._ruleEvaluationTimeout);
            this._ruleEvaluationTimeout = null;
        }

        this._destroyDisplayMonitoring();

        // Destroy parameter detector
        if (this._parameterDetector) {
            this._parameterDetector.disconnectObject(this);
            this._parameterDetector.destroy();
            this._parameterDetector = null;
        }

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
