/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * StateManager coordinates power and battery state across controllers.
 * Signals:
 *   - 'state-changed': Emitted when any state changes
 *   - 'power-mode-changed': Emitted when power mode changes (param: mode string)
 *   - 'battery-mode-changed': Emitted when battery mode changes (param: mode string)
 *   - 'profile-changed': Emitted when detected profile changes (param: profile string)
 *   - 'auto-manage-paused-changed': Emitted when auto-manage pause state changes (param: boolean)
 *   - 'boost-charge-changed': Emitted when boost charge state changes (param: boolean)
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ProfileMatcher from './profileMatcher.js';
import {ParameterDetector} from './parameterDetector.js';
import * as RuleEvaluator from './ruleEvaluator.js';
import * as ScheduleUtils from './scheduleUtils.js';
import * as Constants from './constants.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus');

const _ = s => Gettext.dgettext('hara-hachi-bu', s);

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
    getProfileDisplayName,
    isAutoManaged,
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
        'boost-charge-changed': {param_types: [GObject.TYPE_BOOLEAN]},
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

        // Schedule timer for time-based profile activation
        this._scheduleTimerId = null;

        // Login manager proxy for suspend/resume detection
        this._loginManagerProxy = null;
        this._prepareForSleepId = null;

        // Boost charge state machine
        this._boostChargeActive = false;
        this._boostChargeSavedBatteryMode = null;
        this._boostChargeSavedAutoManagePaused = false;
        this._boostChargeTimeoutId = null;
        this._boostChargeActivatedTime = null;
        this._boostChargeUpdateTimerId = null;
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
                // Skip enabling force discharge on battery — it will apply when AC connects
                if (desiredState && this._batteryController.onBattery) {
                    console.debug('Hara Hachi Bu: Skipping force-discharge restore (on battery)');
                } else {
                    const success = await this._batteryController.setForceDischarge(desiredState, false);
                    if (this._destroyed)
                        return;
                    if (!success) {
                        console.error(`Hara Hachi Bu: Failed to restore force-discharge state to ${desiredState}`);
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

        // Initialize login manager proxy for suspend/resume detection
        await this._initializeLoginManagerProxy();
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
                    // Auto-revert boost charge when battery is full.
                    // Some hardware reports 99% when truly full; cross-check
                    // with the sysfs status string for reliable detection.
                    if (this._boostChargeActive) {
                        const level = this._batteryController.batteryLevel;
                        const status = this._batteryController.getBatteryStatus();
                        if (level >= 99 || status === 'Full' ||
                            (status === 'Not charging' && level >= 95)) {
                            this._deactivateBoostCharge('battery_full').catch(e => {
                                if (!this._destroyed)
                                    console.error(`Hara Hachi Bu: Error deactivating boost charge: ${e.message}`);
                            });
                        }
                    }
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
            'changed::custom-profiles', () => {
                this._updateProfile();
                this._rescheduleTimer();
                if (this._settings.get_boolean('auto-switch-enabled')) {
                    if (this._autoManagePaused) {
                        const profiles = getCustomProfiles(this._settings);
                        if (profiles.some(p => isAutoManaged(p) && p.schedule?.enabled &&
                            ScheduleUtils.isScheduleActive(p.schedule))) {
                            console.log('Hara Hachi Bu: Profile saved with active schedule, resuming auto-management');
                            this._setAutoManagePaused(false);
                        }
                    }
                    if (!this._autoManagePaused)
                        this._scheduleRuleEvaluation();
                }
            },
            'changed::auto-manage-battery-levels', () => {
                const enabled = this._settings.get_boolean('auto-manage-battery-levels');
                if (this._batteryController) {
                    if (enabled) {
                        this._batteryController.checkAutoManagement().catch(e => {
                            if (!this._destroyed)
                                console.error(`Hara Hachi Bu: Auto-management check error: ${e.message}`);
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
                            console.error(`Hara Hachi Bu: Error evaluating rules: ${e.message}`);
                    });
                }
                this._rescheduleTimer();
            },
            'changed::auto-manage-paused', () => {
                const paused = this._settings.get_boolean('auto-manage-paused');
                if (this._autoManagePaused !== paused) {
                    this._autoManagePaused = paused;
                    this.emit('auto-manage-paused-changed', paused);
                    // Trigger rule evaluation when unpausing via external settings change,
                    // matching the behavior of resumeAutoManage()
                    if (!paused && this._settings.get_boolean('auto-switch-enabled'))
                        this._scheduleRuleEvaluation();
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
                        console.error(`Hara Hachi Bu: Error evaluating rules: ${e.message}`);
                });
                return GLib.SOURCE_REMOVE;
            });
        }

        // Start schedule timer for time-based profile activation
        this._rescheduleTimer();
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
        console.debug(`Hara Hachi Bu: Parameter changed: ${paramName} = ${paramValue}`);

        // Auto-revert boost charge when AC is disconnected
        if (this._boostChargeActive && paramName === 'power_source' && paramValue === 'battery') {
            this._deactivateBoostCharge('ac_disconnected').catch(e => {
                if (!this._destroyed)
                    console.error(`Hara Hachi Bu: Error deactivating boost charge on AC disconnect: ${e.message}`);
            });
        }

        // Always emit state-changed for UI updates (e.g. force discharge toggle sensitivity)
        this.emit('state-changed');

        // If auto-switch is disabled, skip rule evaluation
        if (!this._settings.get_boolean('auto-switch-enabled')) {
            return;
        }

        // If paused and resume-on-state-change is enabled, unpause
        if (this._autoManagePaused && this._settings.get_boolean('resume-on-state-change')) {
            console.debug('Hara Hachi Bu: State changed, resuming auto-management');
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
                    console.error(`Hara Hachi Bu: Error evaluating rules: ${e.message}`);
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
                    console.log(`Hara Hachi Bu: Rule matched profile "${matchingProfile.name}"`);
                    await this._applyProfile(matchingProfile, true);
                    if (this._destroyed) return;
                }
            }
            // If no match, stay on current profile (no change)
        } finally {
            this._evaluatingRules = false;
            if (!this._destroyed)
                this._rescheduleTimer();
            if (this._pendingReevaluation && !this._destroyed) {
                this._pendingReevaluation = false;
                this._scheduleRuleEvaluation();
            }
        }
    }

    /**
     * Schedule-aware rule evaluation for timer callbacks.
     * Unlike _evaluateAndApplyRules(), this method unpauses auto-management
     * when a schedule boundary fires — the user explicitly configured a
     * time-based schedule, which takes precedence over a manual profile
     * selection (a temporary override).
     * @private
     */
    async _evaluateAndApplyRulesForSchedule() {
        if (this._destroyed || !this._parameterDetector)
            return;
        if (!this._settings.get_boolean('auto-switch-enabled'))
            return;
        // Don't interfere with active boost charge
        if (this._boostChargeActive)
            return;

        // Schedule boundaries override manual pause
        if (this._autoManagePaused) {
            console.log('Hara Hachi Bu: Schedule boundary reached, resuming auto-management');
            this._setAutoManagePaused(false);
        }

        this._scheduleRuleEvaluation();
    }

    /**
     * Apply a profile (internal helper)
     */
    async _applyProfile(profile, isAuto = false) {
        const success = await this.setProfile(profile.id, isAuto);

        if (success && isAuto) {
            const now = Date.now();
            const notifKey = 'auto-switch';
            const lastTime = this._lastNotifications.get(notifKey) ?? 0;
            if (now - lastTime >= AUTO_SWITCH_NOTIFICATION_THROTTLE_MS) {
                this._lastNotifications.set(notifKey, now);
                let message = _('Switched to %s scenario').format(getProfileDisplayName(profile));

                // Build cause explanation (what triggered this switch)
                const causes = [];
                if (profile.schedule?.enabled) {
                    const endTime = ScheduleUtils.getScheduleEndTimeToday(profile.schedule);
                    if (endTime) {
                        causes.push(_('schedule until %s').format(endTime));
                    } else {
                        causes.push(_('schedule active'));
                    }
                }
                if (profile.rules && profile.rules.length > 0) {
                    const ruleDescs = profile.rules.map(rule => {
                        const param = Constants.PARAMETERS[rule.param];
                        const opDef = Constants.OPERATORS[rule.op];
                        const valueLabel = param?.valueLabels?.[rule.value];
                        if (param && opDef && valueLabel)
                            return `${_(param.label)} ${_(opDef.label)} ${_(valueLabel)}`;
                        return null;
                    }).filter(Boolean);
                    if (ruleDescs.length > 0)
                        causes.push(ruleDescs.join(', '));
                    else
                        causes.push(_('conditions matched'));
                }

                if (causes.length > 0) {
                    message = _('Switched to %s (%s)').format(getProfileDisplayName(profile), causes.join(', '));
                }

                Main.notify(
                    _('Hara Hachi Bu'),
                    message
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
            console.log(`Hara Hachi Bu: Auto-manage ${paused ? 'paused' : 'resumed'}`);
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
                console.error('Hara Hachi Bu: Error evaluating rules on resume:', e);
        });
    }

    _updateProfile() {
        // Skip intermediate updates during setProfile (both modes applied in parallel)
        if (this._suppressProfileUpdate) return;

        const newProfile = detectProfile(this._currentPowerMode, this._currentBatteryMode, this._settings);

        if (newProfile !== this._currentProfile) {
            this._currentProfile = newProfile;
            this.emit('profile-changed', newProfile || 'custom');
        }
    }

    _notifyError(title, message) {
        const now = Date.now();
        const key = `${title}:${message}`;
        const lastTime = this._lastNotifications.get(key) ?? 0;

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
        Main.notify(_('Hara Hachi Bu'), `${title}: ${message}`);
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
                    this._notifyError(_('Power Mode'), _('Failed to apply power mode %s. Check that power-profiles-daemon is running.').format(mode));
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

        // If boost charge is active and user manually changes battery mode,
        // silently deactivate boost (user is taking manual control)
        if (this._boostChargeActive) {
            this._boostChargeActive = false;
            this._boostChargeActivatedTime = null;
            if (this._boostChargeTimeoutId) {
                GLib.Source.remove(this._boostChargeTimeoutId);
                this._boostChargeTimeoutId = null;
            }
            if (this._boostChargeUpdateTimerId) {
                GLib.Source.remove(this._boostChargeUpdateTimerId);
                this._boostChargeUpdateTimerId = null;
            }
            // Restore auto-manage state
            this._setAutoManagePaused(this._boostChargeSavedAutoManagePaused);
            this._boostChargeSavedBatteryMode = null;
            this._boostChargeSavedAutoManagePaused = false;
            this.emit('boost-charge-changed', false);
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
                        _('Failed to apply battery thresholds. Try: 1) Run install-helper.sh to set up battery control, 2) Check Settings \u2192 About for installation instructions.')
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
            console.warn(`Hara Hachi Bu: Profile '${profileName}' not found in settings`);
            this._notifyError(
                _('Scenario Switch Failed'),
                _('Scenario "%s" does not exist.').format(profileName)
            );
            return false;
        }

        console.log(`Hara Hachi Bu: Switching to profile '${profileName}' (power: ${config.powerMode}, battery: ${config.batteryMode}, auto: ${isAuto})`);

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
                            if (!res) console.warn(`Hara Hachi Bu: Failed to set power mode to '${config.powerMode}' for profile '${profileName}'`);
                            return res;
                        })
                        .catch(e => {
                            if (!this._destroyed)
                                console.error(`Hara Hachi Bu: Exception setting power mode: ${e.message}`);
                            return false;
                        })
                );
            } else {
                console.debug(`Hara Hachi Bu: Power profile controller not available, skipping power mode for profile '${profileName}'`);
            }

            if (this._batteryController && this._batteryController.canControlThresholds) {
                labels.push(_('battery mode'));
                promises.push(
                    this.setBatteryMode(config.batteryMode, false)
                        .then(res => {
                            if (!res) console.warn(`Hara Hachi Bu: Failed to set battery mode to '${config.batteryMode}' for profile '${profileName}'`);
                            return res;
                        })
                        .catch(e => {
                            if (!this._destroyed)
                                console.error(`Hara Hachi Bu: Exception setting battery mode: ${e.message}`);
                            return false;
                        })
                );
            } else {
                console.debug(`Hara Hachi Bu: Battery threshold controller not available, skipping battery mode for profile '${profileName}'`);
            }

            results = await Promise.all(promises);
        } finally {
            this._suppressProfileUpdate = false;
        }

        if (this._destroyed) return false;

        const success = results.every(r => r === true);

        if (success) {
            // Set _currentProfile directly from the requested profile rather than
            // relying on detectProfile(), which returns the first mode-match and
            // can pick the wrong profile when multiple profiles share modes
            // (e.g., time-based variants).
            if (this._currentProfile !== profileName) {
                this._currentProfile = profileName;
                this.emit('profile-changed', profileName);
            }
            console.debug(`Hara Hachi Bu: Successfully applied profile '${profileName}'`);
        } else {
            const failedParts = labels.filter((label, i) => results[i] !== true);
            console.warn(`Hara Hachi Bu: Profile '${profileName}' applied with errors`);
            // Partial failure: state is inconsistent, so clear profile identity
            this._currentProfile = null;
            this.emit('profile-changed', 'custom');
            this._notifyError(
                _('Scenario Partially Applied'),
                _('Scenario "%s": failed to apply %s').format(config.name || profileName, failedParts.join(', '))
            );
        }

        this.emit('state-changed');
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

    /**
     * Reschedule the timer for time-based profile activation.
     * Finds the nearest start/end boundary across all scheduled profiles and
     * sets a GLib timer to fire at that point.
     * @private
     */
    _rescheduleTimer() {
        if (this._scheduleTimerId) {
            GLib.Source.remove(this._scheduleTimerId);
            this._scheduleTimerId = null;
        }

        if (this._destroyed || !this._settings?.get_boolean('auto-switch-enabled'))
            return;

        const profiles = getCustomProfiles(this._settings);
        let minSeconds = Infinity;

        for (const profile of profiles) {
            if (!isAutoManaged(profile) || !profile.schedule?.enabled)
                continue;
            const secs = ScheduleUtils.secondsUntilNextBoundary(profile.schedule);
            if (secs < minSeconds)
                minSeconds = secs;
        }

        if (minSeconds === Infinity)
            return; // No scheduled profiles

        // Cap at 1 hour to guard against clock drift / DST transitions
        const delay = Math.max(1, Math.min(minSeconds, 3600));

        console.log(`Hara Hachi Bu: Schedule timer set for ${delay}s`);
        this._scheduleTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._scheduleTimerId = null;
            if (!this._destroyed) {
                this._evaluateAndApplyRulesForSchedule().catch(e => {
                    if (!this._destroyed)
                        console.error(`Hara Hachi Bu: Error on schedule evaluation: ${e.message}`);
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Initialize D-Bus proxy for login manager to detect suspend/resume.
     * On resume, reschedules the timer and triggers rule evaluation.
     * @private
     */
    async _initializeLoginManagerProxy() {
        try {
            this._loginManagerProxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                null,
                'org.freedesktop.login1',
                '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager',
                null
            );

            if (this._destroyed) return;

            this._prepareForSleepId = this._loginManagerProxy.connectSignal(
                'PrepareForSleep',
                (_proxy, _sender, [starting]) => {
                    if (this._destroyed) return;
                    if (!starting) {
                        // Resuming from suspend — a schedule may have started during sleep
                        console.log('Hara Hachi Bu: Resumed from suspend, rescheduling timer');
                        this._rescheduleTimer();
                        if (this._settings.get_boolean('auto-switch-enabled')) {
                            this._evaluateAndApplyRulesForSchedule().catch(e => {
                                if (!this._destroyed)
                                    console.error(`Hara Hachi Bu: Error on post-resume evaluation: ${e.message}`);
                            });
                        }
                    }
                }
            );
        } catch (e) {
            console.debug(`Hara Hachi Bu: Could not connect to login manager: ${e.message}`);
        }
    }

    /**
     * Activate boost charge — temporarily override thresholds to charge to 100%.
     * Saves current state, pauses auto-management, and sets a safety timeout.
     *
     * @returns {Promise<boolean>} - True if successfully activated
     */
    async activateBoostCharge() {
        if (this._destroyed || this._boostChargeActive)
            return false;

        if (!this._batteryController || !this._batteryController.canControlThresholds)
            return false;

        // Save current state
        this._boostChargeSavedBatteryMode = this._currentBatteryMode;
        this._boostChargeSavedAutoManagePaused = this._autoManagePaused;

        // Pause auto-management
        this._setAutoManagePaused(true);

        // Disable force discharge if active
        if (this._batteryController.supportsForceDischarge && this._batteryController.forceDischargeEnabled) {
            await this._batteryController.setForceDischarge(false, false);
            if (this._destroyed) return false;
        }

        // Set thresholds to max: 95/100 for start+end devices, 0/100 for end-only
        const hasStart = this._batteryController.hasStartThreshold;
        const success = await this._batteryController.setThresholds(hasStart ? 95 : 0, 100);
        if (this._destroyed) return false;

        if (!success) {
            // Restore pause state on failure
            this._setAutoManagePaused(this._boostChargeSavedAutoManagePaused);
            this._boostChargeSavedBatteryMode = null;
            this._boostChargeSavedAutoManagePaused = false;
            return false;
        }

        this._boostChargeActive = true;
        this._boostChargeActivatedTime = new Date();

        // Start safety timeout
        const timeoutHours = this._settings.get_int('boost-charge-timeout-hours');
        this._boostChargeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutHours * 3600, () => {
            this._boostChargeTimeoutId = null;
            if (!this._destroyed && this._boostChargeActive) {
                this._deactivateBoostCharge('timeout').catch(e => {
                    if (!this._destroyed)
                        console.error(`Hara Hachi Bu: Error on boost charge timeout: ${e.message}`);
                });
            }
            return GLib.SOURCE_REMOVE;
        });

        // Start UI update timer (every minute)
        this._boostChargeUpdateTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!this._destroyed && this._boostChargeActive) {
                this.emit('state-changed'); // Trigger UI update for countdown
                return GLib.SOURCE_CONTINUE;
            }
            this._boostChargeUpdateTimerId = null;
            return GLib.SOURCE_REMOVE;
        });

        this.emit('boost-charge-changed', true);
        this.emit('state-changed');
        Main.notify(
            _('Hara Hachi Bu'),
            _('Boost Charge activated — charging to 100%. Auto-stops when full.')
        );

        return true;
    }

    /**
     * Deactivate boost charge and restore previous state.
     *
     * @param {string} reason - Why boost was deactivated: 'user', 'battery_full', 'timeout', 'ac_disconnected'
     * @returns {Promise<boolean>} - True if successfully deactivated
     * @private
     */
    async _deactivateBoostCharge(reason) {
        if (this._destroyed || !this._boostChargeActive)
            return false;

        this._boostChargeActive = false;
        this._boostChargeActivatedTime = null;

        // Cancel safety timeout
        if (this._boostChargeTimeoutId) {
            GLib.Source.remove(this._boostChargeTimeoutId);
            this._boostChargeTimeoutId = null;
        }

        // Cancel UI update timer
        if (this._boostChargeUpdateTimerId) {
            GLib.Source.remove(this._boostChargeUpdateTimerId);
            this._boostChargeUpdateTimerId = null;
        }

        const savedPaused = this._boostChargeSavedAutoManagePaused;
        const savedMode = this._boostChargeSavedBatteryMode;
        this._boostChargeSavedBatteryMode = null;
        this._boostChargeSavedAutoManagePaused = false;

        // Smart restore: if auto-management was active before boost, let rule evaluation
        // pick the correct mode instead of restoring a potentially stale mode
        const autoSwitchEnabled = this._settings.get_boolean('auto-switch-enabled');
        if (!savedPaused && autoSwitchEnabled) {
            // Unpause auto-management → rule eval picks correct mode
            this._setAutoManagePaused(false);
            this._scheduleRuleEvaluation();
        } else {
            // Auto-management was off/paused: manually restore saved battery mode
            if (savedMode && this._batteryController?.canControlThresholds) {
                const restored = await this.setBatteryMode(savedMode, false);
                if (this._destroyed) return false;
                if (!restored) {
                    console.warn(`Hara Hachi Bu: Failed to restore battery mode '${savedMode}' after boost charge`);
                    this._notifyError(
                        _('Boost Charge'),
                        _('Could not restore previous battery mode. Thresholds may still be at boost levels.')
                    );
                }
            }
            this._setAutoManagePaused(savedPaused);
        }

        this.emit('boost-charge-changed', false);
        this.emit('state-changed');

        // Notify with reason-specific message
        const messages = {
            user: _('Boost charge deactivated'),
            battery_full: _('Boost charge complete — battery is full'),
            timeout: _('Boost charge timed out — reverting to previous mode'),
            ac_disconnected: _('Boost charge stopped — AC power disconnected'),
        };
        Main.notify(
            _('Hara Hachi Bu'),
            messages[reason] || _('Boost charge deactivated')
        );

        return true;
    }

    /**
     * Toggle boost charge on or off.
     *
     * @returns {Promise<boolean>} - True if operation succeeded
     */
    async toggleBoostCharge() {
        if (this._boostChargeActive)
            return this._deactivateBoostCharge('user');
        return this.activateBoostCharge();
    }

    /**
     * Whether boost charge is currently active.
     */
    get boostChargeActive() {
        return this._boostChargeActive;
    }

    /**
     * Get boost charge end time (ISO string) or null if not active.
     */
    get boostChargeEndTime() {
        if (!this._boostChargeActive || !this._boostChargeActivatedTime)
            return null;

        const timeoutHours = this._settings.get_int('boost-charge-timeout-hours');
        const endTime = new Date(this._boostChargeActivatedTime.getTime() + (timeoutHours * 3600 * 1000));
        return endTime;
    }

    /**
     * Get remaining boost charge time in seconds, or 0 if not active.
     */
    get boostChargeRemainingSeconds() {
        const endTime = this.boostChargeEndTime;
        if (!endTime)
            return 0;

        const now = new Date();
        const remaining = Math.max(0, Math.floor((endTime.getTime() - now.getTime()) / 1000));
        return remaining;
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

        // Cancel schedule timer
        if (this._scheduleTimerId) {
            GLib.Source.remove(this._scheduleTimerId);
            this._scheduleTimerId = null;
        }

        // Cancel boost charge timeout
        if (this._boostChargeTimeoutId) {
            GLib.Source.remove(this._boostChargeTimeoutId);
            this._boostChargeTimeoutId = null;
        }

        // Cancel boost charge UI update timer
        if (this._boostChargeUpdateTimerId) {
            GLib.Source.remove(this._boostChargeUpdateTimerId);
            this._boostChargeUpdateTimerId = null;
        }

        this._boostChargeActive = false;
        this._boostChargeActivatedTime = null;

        // Disconnect login manager proxy
        if (this._loginManagerProxy) {
            if (this._prepareForSleepId) {
                this._loginManagerProxy.disconnectSignal(this._prepareForSleepId);
                this._prepareForSleepId = null;
            }
            this._loginManagerProxy = null;
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
