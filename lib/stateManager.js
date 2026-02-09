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

const INITIAL_RULE_EVAL_DELAY_MS = 500;
const RULE_EVAL_DEBOUNCE_MS = 300;
const NOTIFICATION_THROTTLE_MS = 60000;
const NOTIFICATION_PRUNE_AGE_MS = 300000; // 5 minutes
const AUTO_SWITCH_NOTIFICATION_THROTTLE_MS = 10000;

// No-op marker for xgettext extraction. Strings are translated at call sites via _().
const N_ = s => s;

const SETUP_REQUIRED_TITLE = N_('Setup Required');
const SETUP_REQUIRED_MESSAGE = N_('Helper script not installed. Open Settings \u2192 About to copy installation command.');

const {
    detectProfile,
    detectBatteryModeFromThresholds,
    getThresholdsForMode,
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

        // Notification throttling
        this._lastNotifications = new Map();

        // Rule-based automatic profile switching
        this._parameterDetector = null;
        this._autoManagePaused = false;

        // Initial rule evaluation timeout (stored for cleanup)
        this._initialRuleEvalTimeout = null;
        this._ruleEvaluationTimeout = null;

        // Async safety flag
        this._destroyed = false;

        // Prevent duplicate signal emission during setPowerMode
        this._settingPowerMode = false;

        // Prevent concurrent rule evaluation
        this._evaluatingRules = false;
        this._pendingReevaluation = false;

        // Suppress intermediate _updateProfile calls during setProfile
        this._suppressProfileUpdate = false;
    }

    async initialize() {
        // Get initial power mode from controller
        if (this._powerController && this._powerController.isAvailable)
            this._currentPowerMode = this._powerController.currentProfile;

        // Get initial battery mode from thresholds
        if (this._batteryController && this._batteryController.canControlThresholds) {
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
                if (this._destroyed)
                    return;
                if (!success) {
                    console.error(`Unified Power Manager: Failed to restore force-discharge state to ${desiredState}`);
                    if (this._batteryController.needsHelper) {
                        this._notifyError(_(SETUP_REQUIRED_TITLE), _(SETUP_REQUIRED_MESSAGE));
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

        // Reset paused state on session start if resume-on-state-change is enabled
        if (this._autoManagePaused && this._settings.get_boolean('resume-on-state-change'))
            this._setAutoManagePaused(false);

        // Detect current profile
        this._updateProfile();

        // Initialize the unified parameter detector
        await this._initializeParameterDetector();
        if (this._destroyed) return;

        // Connect to controller signals
        if (this._powerController) {
            this._powerController.connectObject(
                'power-profile-changed', (controller, profile) => {
                    // Skip if we're inside setPowerMode (it handles its own emissions)
                    if (this._settingPowerMode) return;
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
                'force-discharge-changed', (controller, enabled) => {
                    this.emit('state-changed');
                },
                'partial-failure', (controller, succeededBat, failedBats) => {
                    this._notifyError(
                        _('Partial Failure'),
                        _('Threshold set on %s but failed on %s').format(succeededBat, failedBats)
                    );
                },
                this
            );
        }

        // Connect to settings changes
        this._settings.connectObject(
            'changed::custom-profiles', () => this._updateProfile(),
            'changed::auto-manage-battery-levels', () => {
                const enabled = this._settings.get_boolean('auto-manage-battery-levels');
                if (this._batteryController) {
                    if (enabled) {
                        this._batteryController.checkAutoManagement().catch(e => {
                            if (!this._destroyed)
                                console.error(`Unified Power Manager: Auto-management check error: ${e.message}`);
                        });
                    } else {
                        this._batteryController.cancelAutoManagement();
                    }
                }
            },
            'changed::auto-switch-enabled', () => {
                // When auto-switch is re-enabled, unpause and evaluate rules
                if (this._settings.get_boolean('auto-switch-enabled')) {
                    this._setAutoManagePaused(false);
                    this._evaluateAndApplyRules().catch(e => {
                        if (!this._destroyed)
                            console.error(`Unified Power Manager: Error evaluating rules: ${e.message}`);
                    });
                }
            },
            'changed::auto-manage-paused', () => {
                const paused = this._settings.get_boolean('auto-manage-paused');
                if (this._autoManagePaused !== paused) {
                    this._autoManagePaused = paused;
                    this.emit('auto-manage-paused-changed', paused);
                }
            },
            this
        );

        // Perform initial rule evaluation if auto-switch is enabled and not paused
        if (this._settings.get_boolean('auto-switch-enabled') && !this._autoManagePaused) {
            // Delay initial evaluation to ensure all components are ready
            this._initialRuleEvalTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INITIAL_RULE_EVAL_DELAY_MS, () => {
                this._initialRuleEvalTimeout = null;
                this._evaluateAndApplyRules().catch(e => {
                    if (!this._destroyed)
                        console.error(`Unified Power Manager: Error evaluating rules: ${e.message}`);
                });
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    async _initializeParameterDetector() {
        if (this._parameterDetector)
            return;

        this._parameterDetector = new ParameterDetector();

        // Connect signal BEFORE initialize() to avoid missing early emissions
        this._parameterDetector.connectObject(
            'parameter-changed', (detector, paramName, paramValue) => {
                this._onParameterChanged(paramName, paramValue);
            },
            this
        );

        await this._parameterDetector.initialize();
    }

    _onParameterChanged(paramName, paramValue) {
        console.debug(`Unified Power Manager: Parameter changed: ${paramName} = ${paramValue}`);

        // Always emit state-changed for UI updates (e.g. force discharge toggle sensitivity)
        this.emit('state-changed');

        // If auto-switch is disabled, skip rule evaluation
        if (!this._settings.get_boolean('auto-switch-enabled')) {
            return;
        }

        // If paused and resume-on-state-change is enabled, unpause
        if (this._autoManagePaused && this._settings.get_boolean('resume-on-state-change')) {
            console.debug('Unified Power Manager: State changed, resuming auto-management');
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

        this._ruleEvaluationTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RULE_EVAL_DEBOUNCE_MS, () => {
            this._ruleEvaluationTimeout = null;
            this._evaluateAndApplyRules().catch(e => {
                if (!this._destroyed)
                    console.error(`Unified Power Manager: Error evaluating rules: ${e.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Evaluate profile rules and apply matching profile.
     *
     * Rule evaluation uses most-specific-wins logic:
     * - Profiles with more matching conditions take precedence
     * - Example: A profile with 2 rules (display + power) wins over one with 1 rule (display only)
     * - If no profile matches, the current profile remains active
     *
     * This method is called when:
     * - System parameters change (display connect/disconnect, AC plug/unplug)
     * - Auto-switch setting is re-enabled
     * - Auto-manage is unpaused (after manual override timeout)
     *
     * @private
     */
    async _evaluateAndApplyRules() {
        if (this._destroyed || !this._parameterDetector || this._autoManagePaused) {
            return;
        }

        if (this._evaluatingRules) {
            this._pendingReevaluation = true;
            return;
        }

        this._evaluatingRules = true;
        try {
            const currentParams = this._parameterDetector.getAllValues();
            const profiles = getCustomProfiles(this._settings);

            const matchingProfile = RuleEvaluator.findMatchingProfile(profiles, currentParams);

            if (matchingProfile) {
                // Only switch if it's a different profile
                if (matchingProfile.id !== this._currentProfile) {
                    console.debug(`Unified Power Manager: Rule matched profile "${matchingProfile.name}"`);
                    await this._applyProfile(matchingProfile, true);
                    if (this._destroyed) return;
                }
            }
            // If no match, stay on current profile (no change)
        } finally {
            this._evaluatingRules = false;
            if (this._pendingReevaluation && !this._destroyed) {
                this._pendingReevaluation = false;
                this._scheduleRuleEvaluation();
            }
        }
    }

    /**
     * Apply a profile (internal helper)
     */
    async _applyProfile(profile, isAuto = false) {
        const success = await this.setProfile(profile.id, isAuto);

        if (success && isAuto) {
            const now = Date.now();
            const notifKey = 'auto-switch';
            const lastTime = this._lastNotifications.get(notifKey) || 0;
            if (now - lastTime >= AUTO_SWITCH_NOTIFICATION_THROTTLE_MS) {
                this._lastNotifications.set(notifKey, now);
                Main.notify(
                    _('Unified Power Manager'),
                    _('Switched to %s profile').format(profile.name)
                );
            }
        }

        return success;
    }

    /**
     * Set the auto-manage paused state
     */
    _setAutoManagePaused(paused) {
        if (this._destroyed) return;
        if (this._autoManagePaused !== paused) {
            this._autoManagePaused = paused;
            this._settings.set_boolean('auto-manage-paused', paused);
            // Cancel any pending rule evaluation when pausing to prevent stale timeouts
            // from firing after a manual profile switch
            if (paused && this._ruleEvaluationTimeout) {
                GLib.Source.remove(this._ruleEvaluationTimeout);
                this._ruleEvaluationTimeout = null;
            }
            this.emit('auto-manage-paused-changed', paused);
            console.debug(`Unified Power Manager: Auto-manage ${paused ? 'paused' : 'resumed'}`);
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
        this._evaluateAndApplyRules().catch(e => {
            if (!this._destroyed)
                console.error('Unified Power Manager: Error evaluating rules on resume:', e);
        });
    }

    _updateProfile() {
        // Skip intermediate updates during setProfile (both modes applied in parallel)
        if (this._suppressProfileUpdate) return;

        const currentFD = this._batteryController ? this._batteryController.forceDischargeEnabled : undefined;
        const newProfile = detectProfile(this._currentPowerMode, this._currentBatteryMode, this._settings, currentFD);

        if (newProfile !== this._currentProfile) {
            this._currentProfile = newProfile;
            this.emit('profile-changed', newProfile || 'custom');
        }
    }

    _notifyError(title, message) {
        const now = Date.now();
        const key = `${title}:${message}`;
        const lastTime = this._lastNotifications.get(key) || 0;

        // Throttle: 60 seconds
        if (now - lastTime < NOTIFICATION_THROTTLE_MS)
            return;

        // Prune stale entries to prevent unbounded growth
        if (this._lastNotifications.size > 20) {
            for (const [k, t] of this._lastNotifications) {
                if (now - t > NOTIFICATION_PRUNE_AGE_MS)
                    this._lastNotifications.delete(k);
            }
        }

        this._lastNotifications.set(key, now);
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
        if (this._batteryController && this._batteryController.canControlThresholds)
            return Object.keys(BATTERY_MODES);
        return [];
    }

    get hasStartThreshold() {
        if (this._batteryController)
            return this._batteryController.hasStartThreshold;
        return false;
    }

    get batteryControlAvailable() {
        return this._batteryController && this._batteryController.canControlThresholds;
    }

    get currentEndThreshold() {
        if (this._batteryController)
            return this._batteryController.currentEndThreshold;
        return -1;
    }

    get batteryNeedsHelper() {
        return this._batteryController && this._batteryController.needsHelper;
    }

    get availableProfiles() {
        return ProfileMatcher.getAvailableProfiles(this._settings);
    }

    async setPowerMode(mode, notifyError = true) {
        if (!this._powerController || !this._powerController.isAvailable || this._destroyed) {
            if (!this._destroyed && notifyError)
                this._notifyError(_('Power Mode'), _('Power profile control is not available. Install power-profiles-daemon.'));
            return false;
        }

        this._settingPowerMode = true;
        let success;
        try {
            success = await this._powerController.setProfile(mode);
            if (this._destroyed)
                return false;
            if (success) {
                this._currentPowerMode = mode;
                this._settings.set_string('current-power-mode', mode);
                this._updateProfile();
                this.emit('power-mode-changed', mode);
                this.emit('state-changed');
            } else {
                if (notifyError)
                    this._notifyError(_('Power Mode'), _('Failed to set power mode to %s. Check that power-profiles-daemon is running.').format(mode));
                this.emit('state-changed'); // Revert UI
            }
        } finally {
            this._settingPowerMode = false;
        }
        return success;
    }

    async setBatteryMode(mode, notifyError = true) {
        if (!this._batteryController || !this._batteryController.canControlThresholds || this._destroyed) {
            if (!this._destroyed && notifyError)
                this._notifyError(_('Battery Mode'), _('Battery threshold control is not available'));
            return false;
        }

        const thresholds = getThresholdsForMode(mode, this._settings);
        if (!thresholds) {
            if (notifyError)
                this._notifyError(_('Battery Mode'), _('Invalid battery mode: %s').format(mode));
            return false;
        }

        const success = await this._batteryController.setThresholds(thresholds.start, thresholds.end);
        if (this._destroyed)
            return false;
        if (success) {
            this._currentBatteryMode = mode;
            this._settings.set_string('current-battery-mode', mode);
            this._updateProfile();
            this.emit('battery-mode-changed', mode);
            this.emit('state-changed');
        } else {
            // Provide actionable error message based on common failure causes
            if (notifyError) {
                if (this._batteryController.needsHelper) {
                    this._notifyError(_(SETUP_REQUIRED_TITLE), _(SETUP_REQUIRED_MESSAGE));
                } else {
                    this._notifyError(
                        _('Battery Mode'),
                        _('Failed to set battery thresholds. Check extension logs for details.')
                    );
                }
            }
            this.emit('state-changed'); // Revert UI
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
        if (this._destroyed)
            return false;

        const config = ProfileMatcher.getProfileById(this._settings, profileName);
        if (!config) {
            console.warn(`Unified Power Manager: Profile '${profileName}' not found in settings`);
            this._notifyError(
                _('Profile Switch Failed'),
                _('Profile "%s" does not exist.').format(profileName)
            );
            return false;
        }

        console.debug(`Unified Power Manager: Switching to profile '${profileName}' (power: ${config.powerMode}, battery: ${config.batteryMode}, forceDischarge: ${config.forceDischarge || 'unspecified'}, auto: ${isAuto})`);

        // If this is a manual switch and auto-switch is enabled, pause auto-management
        if (!isAuto && this._settings.get_boolean('auto-switch-enabled')) {
            this._setAutoManagePaused(true);
        }

        // Suppress intermediate _updateProfile() calls while applying modes in parallel
        this._suppressProfileUpdate = true;

        let results;
        let labels = [];
        try {
            // Set modes in parallel for better performance
            // Pass notifyError=false to prevent spamming notifications if parts fail; we notify summary at end
            const promises = [];

            if (this._powerController && this._powerController.isAvailable) {
                labels.push(_('power mode'));
                promises.push(
                    this.setPowerMode(config.powerMode, false)
                        .then(res => {
                            if (!res) console.warn(`Unified Power Manager: Failed to set power mode to '${config.powerMode}' for profile '${profileName}'`);
                            return res;
                        })
                        .catch(e => {
                            console.error(`Unified Power Manager: Exception setting power mode: ${e.message}`);
                            return false;
                        })
                );
            } else {
                console.debug(`Unified Power Manager: Power profile controller not available, skipping power mode for profile '${profileName}'`);
            }

            if (this._batteryController && this._batteryController.canControlThresholds) {
                labels.push(_('battery mode'));
                promises.push(
                    this.setBatteryMode(config.batteryMode, false)
                        .then(res => {
                            if (!res) console.warn(`Unified Power Manager: Failed to set battery mode to '${config.batteryMode}' for profile '${profileName}'`);
                            return res;
                        })
                        .catch(e => {
                            console.error(`Unified Power Manager: Exception setting battery mode: ${e.message}`);
                            return false;
                        })
                );
            } else {
                console.debug(`Unified Power Manager: Battery threshold controller not available, skipping battery mode for profile '${profileName}'`);
            }

            // Handle force discharge preference
            if (config.forceDischarge && config.forceDischarge !== 'unspecified') {
                if (this._batteryController && this._batteryController.supportsForceDischarge) {
                    const desiredState = config.forceDischarge === 'on';
                    // Only change if we're on AC (force discharge on battery doesn't make sense)
                    if (!this._batteryController.onBattery || !desiredState) {
                        labels.push(_('force discharge'));
                        promises.push(
                            this._batteryController.setForceDischarge(desiredState, false)
                                .then(res => {
                                    if (res) {
                                        this._settings.set_boolean('force-discharge-enabled', desiredState);
                                    } else {
                                        console.warn(`Unified Power Manager: Failed to set force discharge to ${desiredState} for profile '${profileName}'`);
                                    }
                                    return res;
                                })
                                .catch(e => {
                                    console.error(`Unified Power Manager: Exception setting force discharge: ${e.message}`);
                                    return false;
                                })
                        );
                    }
                }
            }

            results = await Promise.all(promises);
        } finally {
            this._suppressProfileUpdate = false;
            if (!this._destroyed) {
                this._updateProfile();
                this.emit('state-changed');
            }
        }

        if (this._destroyed) return false;

        const success = results.every(r => r === true);

        if (success) {
            console.debug(`Unified Power Manager: Successfully applied profile '${profileName}'`);
        } else {
            const failedParts = labels.filter((label, i) => results[i] !== true);
            console.warn(`Unified Power Manager: Profile '${profileName}' applied with errors`);
            this._notifyError(
                _('Profile Partially Applied'),
                _('Profile "%s": failed to apply %s').format(config.name || profileName, failedParts.join(', '))
            );
        }

        return success;
    }

    async setForceDischarge(enabled, notifyError = true) {
        if (!this._batteryController || !this._batteryController.supportsForceDischarge || this._destroyed) {
            if (!this._destroyed && notifyError)
                this._notifyError(_('Force Discharge'), _('Force discharge is not supported on this device'));
            return false;
        }

        const success = await this._batteryController.setForceDischarge(enabled);
        if (this._destroyed)
            return false;
        if (success) {
            this._settings.set_boolean('force-discharge-enabled', enabled);
        } else {
            if (notifyError)
                this._notifyError(_('Force Discharge'), _('Failed to change force discharge mode'));
            this.emit('state-changed'); // Revert UI
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

    async refreshState() {
        if (this._batteryController)
            await this._batteryController.refreshValues();

        if (this._destroyed) return;

        // Re-detect modes
        if (this._batteryController && this._batteryController.canControlThresholds) {
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
        this._destroyed = true;

        // Cancel any pending rule evaluation
        if (this._ruleEvaluationTimeout) {
            GLib.Source.remove(this._ruleEvaluationTimeout);
            this._ruleEvaluationTimeout = null;
        }

        // Cancel initial rule evaluation timeout
        if (this._initialRuleEvalTimeout) {
            GLib.Source.remove(this._initialRuleEvalTimeout);
            this._initialRuleEvalTimeout = null;
        }

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

        this._lastNotifications = null;
    }
});
