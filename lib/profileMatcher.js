/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import Gettext from 'gettext';
import * as RuleEvaluator from './ruleEvaluator.js';
import * as ScheduleUtils from './scheduleUtils.js';
import * as Constants from './constants.js';

const _ = (s) => Gettext.dgettext('hara-hachi-bu', s);

/**
 * Check if a profile ID belongs to a builtin profile.
 *
 * @param id - Profile ID
 * @returns - True if the profile is builtin (docked or travel)
 */
export function isBuiltinProfile(id) {
    return id === 'docked' || id === 'travel';
}

/**
 * Get the display name for a profile, translating builtin names.
 *
 * @param profile - Profile object with id and name fields
 * @returns - Translated name for builtins, raw name otherwise
 */
export function getProfileDisplayName(profile) {
    return isBuiltinProfile(profile.id) ? _(profile.name) : profile.name;
}

/**
 * Get the icon name for a profile. Builtin profiles have dedicated icons;
 * custom profiles return null (caller falls back to power mode icon).
 *
 * @param profile - Profile object with id field
 * @returns - Icon name or null
 */
export function getProfileIcon(profile) {
    switch (profile.id) {
        case 'docked':
            return 'hhb-docked-symbolic';
        case 'travel':
            return 'hhb-travel-symbolic';
        default:
            return null;
    }
}

/**
 * Maximum number of custom profiles allowed in settings.
 * @constant
 */
export const MAX_PROFILES = 10;

/**
 * Default profile definitions for backward compatibility.
 * @constant
 */
export const PROFILES = Constants.DEFAULT_PROFILES;

/**
 * Battery mode definitions with threshold ranges and default values.
 * @constant
 */
export const BATTERY_MODES = Constants.BATTERY_MODES;

/**
 * Power mode definitions with labels and icons.
 * @constant
 */
export const POWER_MODES = Constants.POWER_MODES;

/**
 * Detect which profile matches the current power and battery mode combination.
 *
 * @param currentPowerMode - Current power profile (performance, balanced, power-saver)
 * @param currentBatteryMode - Current battery mode (full-capacity, balanced, max-lifespan)
 * @param [settings] - GSettings object
 * @returns - Profile ID or null if no match (Custom mode)
 */
export function detectProfile(currentPowerMode, currentBatteryMode, settings = null) {
    const profiles = settings ? getCustomProfiles(settings) : Object.values(PROFILES);

    for (const profile of profiles) {
        if (profile.powerMode === currentPowerMode && profile.batteryMode === currentBatteryMode) return profile.id;
    }

    return null; // Custom/no match
}

/**
 * Get profile configuration by ID.
 *
 * @param profileId - Unique identifier for the profile
 * @param [settings] - GSettings object
 * @returns - Profile configuration object or null if not found
 */
export function getProfileConfig(profileId, settings = null) {
    if (settings) return getProfileById(settings, profileId);
    return PROFILES[profileId] || null;
}

/**
 * Get IDs of all available profiles.
 *
 * @param [settings] - GSettings object
 * @returns - Array of profile IDs
 */
export function getAvailableProfiles(settings = null) {
    if (settings) {
        const profiles = getCustomProfiles(settings);
        return profiles.map((p) => p.id);
    }
    return Object.keys(PROFILES);
}

/**
 * Detect battery mode name based on start and end threshold values.
 *
 * @param startThreshold - Start charge threshold (-1 or 0 if not supported)
 * @param endThreshold - End charge threshold (0-100)
 * @param [settings] - GSettings object to read custom threshold values
 * @returns - Battery mode name (full-capacity, balanced, max-lifespan) or null if no match
 */
export function detectBatteryModeFromThresholds(startThreshold, endThreshold, settings = null) {
    const modes = [
        {
            name: 'full-capacity',
            startKey: 'threshold-full-start',
            endKey: 'threshold-full-end',
        },
        {
            name: 'balanced',
            startKey: 'threshold-balanced-start',
            endKey: 'threshold-balanced-end',
        },
        {
            name: 'max-lifespan',
            startKey: 'threshold-lifespan-start',
            endKey: 'threshold-lifespan-end',
        },
    ];

    // Determine if this is an end-only device (start threshold is not provided)
    // Use < 0 (not <= 0) because 0 is a valid start threshold on some hardware
    const isEndOnly = startThreshold < 0;

    for (const mode of modes) {
        let expectedStart, expectedEnd;

        if (settings) {
            expectedStart = settings.get_int(mode.startKey);
            expectedEnd = settings.get_int(mode.endKey);
        } else {
            expectedStart = BATTERY_MODES[mode.name].defaultStart;
            expectedEnd = BATTERY_MODES[mode.name].defaultEnd;
        }

        if (isEndOnly) {
            // Use tolerance window for end-only devices to handle minor user adjustments
            if (Math.abs(endThreshold - expectedEnd) <= 2) return mode.name;
        } else if (startThreshold === expectedStart && endThreshold === expectedEnd) {
            return mode.name;
        }
    }

    return null;
}

/**
 * Get threshold values associated with a specific battery mode.
 *
 * @param batteryMode - Battery mode name
 * @param [settings] - GSettings object to read custom thresholds
 * @returns - {start: number, end: number} or null if invalid mode
 */
export function getThresholdsForMode(batteryMode, settings = null) {
    // Mode config is now in Constants.BATTERY_MODES, but for backward compatibility/clarity
    // we can look it up dynamically or keep using the map if we want to be safe.
    // However, Constants.BATTERY_MODES has the keys startKey/endKey which we can use.

    const config = BATTERY_MODES[batteryMode];
    if (!config) return null;

    if (settings) {
        const start = settings.get_int(config.startKey);
        const end = settings.get_int(config.endKey);
        if (start >= end) {
            console.warn(
                `Hara Hachi Bu: Invalid thresholds for ${batteryMode} (start=${start} >= end=${end}), using defaults`
            );
            return {start: config.defaultStart, end: config.defaultEnd};
        }
        return {start, end};
    }

    return {
        start: config.defaultStart,
        end: config.defaultEnd,
    };
}

/**
 * Parse a profile configuration from a JSON string.
 *
 * @param jsonString - JSON string from settings
 * @returns - Parsed profile object or null if parsing failed
 */
export function parseProfileFromSettings(jsonString) {
    try {
        return JSON.parse(jsonString);
    } catch {
        return null;
    }
}

/**
 * Validate and sanitize a profile object for schema compliance.
 * Mutates the profile in-place (trims name, filters invalid rules).
 *
 * @param profile - Profile object to validate (modified in-place)
 * @returns - The validated profile or null if invalid
 */
export function validateProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;

    const validPowerModes = Object.keys(POWER_MODES);
    const validBatteryModes = Object.keys(BATTERY_MODES);

    // Validate required fields
    if (!validPowerModes.includes(profile.powerMode)) return null;
    if (!validBatteryModes.includes(profile.batteryMode)) return null;

    // Validate name
    if (typeof profile.name !== 'string') return null;
    const trimmedName = profile.name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 50) return null;
    profile.name = trimmedName;

    if (typeof profile.id !== 'string' || !isValidProfileId(profile.id)) return null;

    if (profile.rules !== undefined && profile.rules !== null) {
        if (!Array.isArray(profile.rules)) {
            profile.rules = [];
        } else {
            const validRules = profile.rules.filter((rule, i) => {
                const result = RuleEvaluator.validateCondition(rule);
                if (!result.valid) {
                    console.warn(
                        `Hara Hachi Bu: Dropping invalid rule ${i + 1} from profile "${profile.id}": ${result.error}`
                    );
                    return false;
                }
                return true;
            });
            if (validRules.length !== profile.rules.length) profile.rules = validRules;
        }
    }

    if (profile.schedule !== undefined && profile.schedule !== null) {
        // Only fully validate when the schedule is enabled; when disabled,
        // preserve raw data so the user's time inputs survive save/edit cycles.
        if (profile.schedule.enabled) {
            const scheduleResult = ScheduleUtils.validateSchedule(profile.schedule);
            if (!scheduleResult.valid) {
                console.warn(
                    `Hara Hachi Bu: Invalid schedule in profile "${profile.id}": ${scheduleResult.error}, setting to null`
                );
                profile.schedule = null;
            }
        }
    }

    return profile;
}

/**
 * Check if a profile is configured for automatic activation.
 * Derived from presence of rules or an enabled schedule.
 *
 * @param profile - Profile object to check
 * @returns - True if profile has rules or an active schedule
 */
export function isAutoManaged(profile) {
    return !!(profile && (profile.rules?.length > 0 || profile.schedule?.enabled));
}

// Module-level cache for getCustomProfiles
let _cachedProfiles = null;
let _cachedProfilesJson = null;

/**
 * Get all profiles from custom-profiles settings, initializing with defaults if necessary.
 * Results are cached and invalidated when the GSettings JSON string changes.
 *
 * @param settings - GSettings object
 * @returns - Array of validated profile objects
 */
export function getCustomProfiles(settings) {
    const defaults = Object.values(PROFILES);

    try {
        const json = settings.get_string('custom-profiles');

        if (json === _cachedProfilesJson && _cachedProfiles !== null) return _cachedProfiles;

        const profiles = JSON.parse(json);

        if (!Array.isArray(profiles)) {
            saveCustomProfiles(settings, defaults);
            _cachedProfiles = defaults;
            _cachedProfilesJson = null; // Will differ after save
            return defaults;
        }

        // An empty array is a valid user choice (all profiles deleted)
        if (profiles.length === 0) {
            _cachedProfiles = profiles;
            _cachedProfilesJson = json;
            return profiles;
        }

        const validProfiles = profiles.filter((p) => {
            if (validateProfile(p) === null) {
                console.warn(
                    `Hara Hachi Bu: Dropping invalid profile (id: ${p?.id || 'unknown'}, name: ${p?.name || 'unknown'}): missing or invalid required fields`
                );
                return false;
            }
            return true;
        });

        // If all profiles were invalid, reinitialize with defaults
        if (validProfiles.length === 0) {
            saveCustomProfiles(settings, defaults);
            _cachedProfiles = defaults;
            _cachedProfilesJson = null;
            return defaults;
        }

        _cachedProfiles = validProfiles;
        _cachedProfilesJson = json;
        return validProfiles;
    } catch (e) {
        console.error('Hara Hachi Bu: Failed to parse custom profiles:', e);
        _cachedProfiles = null;
        _cachedProfilesJson = null;
        return defaults;
    }
}

/**
 * Reset the module-level profile cache.
 * Should be called on extension disable to prevent stale data across cycles.
 */
export function resetCache() {
    _cachedProfiles = null;
    _cachedProfilesJson = null;
}

/**
 * Persist custom profiles to GSettings as a JSON string.
 *
 * @param settings - GSettings object
 * @param profiles - Array of profile objects to save
 */
export function saveCustomProfiles(settings, profiles) {
    settings.set_string('custom-profiles', JSON.stringify(profiles));
    _cachedProfiles = null;
    _cachedProfilesJson = null;
}

/**
 * Find a specific profile by its ID.
 *
 * @param settings - GSettings object
 * @param profileId - Unique identifier for the profile
 * @returns - Profile object or null if not found
 */
export function getProfileById(settings, profileId) {
    const profiles = getCustomProfiles(settings);
    return profiles.find((p) => p.id === profileId) || null;
}

/**
 * Create a new custom profile.
 *
 * @param settings - GSettings object
 * @param id - Unique profile ID
 * @param name - Display name for the profile
 * @param powerMode - Power profile name
 * @param batteryMode - Battery mode name
 * @param [rules=null] - Optional automatic activation rules
 * @param [schedule=null] - Optional time-based schedule
 * @returns - True if creation was successful
 */
export function createProfile(settings, id, name, powerMode, batteryMode, rules = null, schedule = null) {
    const profiles = [...getCustomProfiles(settings)];

    if (profiles.length >= MAX_PROFILES) return false;
    if (profiles.some((p) => p.id === id)) return false;
    if (!isValidProfileId(id)) return false;
    if (!name || name.trim().length === 0) return false;

    if (rules) {
        const rulesValidation = RuleEvaluator.validateRules(rules);
        if (!rulesValidation.valid) return false;
    }

    if (schedule?.enabled) {
        const scheduleValidation = ScheduleUtils.validateSchedule(schedule);
        if (!scheduleValidation.valid) return false;
    }

    const hasRules = rules && rules.length > 0;
    const hasSchedule = schedule?.enabled;
    if (hasRules || hasSchedule) {
        const newProfile = {id, name, powerMode, batteryMode, rules: rules || [], schedule};
        const conflict = RuleEvaluator.findRuleConflict(profiles, newProfile);
        if (conflict) return false;
    }

    const newProfile = {
        id,
        name: name.trim(),
        powerMode,
        batteryMode,
        rules: rules || [],
        schedule: schedule || null,
    };

    if (validateProfile(newProfile) === null) {
        console.warn(`Hara Hachi Bu: createProfile validation failed for "${id}"`);
        return false;
    }

    profiles.push(newProfile);
    saveCustomProfiles(settings, profiles);
    return true;
}

/**
 * Update an existing profile configuration.
 *
 * @param settings - GSettings object
 * @param profileId - ID of the profile to update
 * @param updates - Fields and new values to update
 * @returns - True if update was successful
 */
export function updateProfile(settings, profileId, updates) {
    const profiles = [...getCustomProfiles(settings)];
    const index = profiles.findIndex((p) => p.id === profileId);
    if (index === -1) return false;

    // Shallow copy to avoid mutating the caller's object
    updates = {...updates};
    delete updates.id; // Prevent ID modification

    if (updates.rules !== undefined) {
        const rulesValidation = RuleEvaluator.validateRules(updates.rules);
        if (!rulesValidation.valid) return false;
    }

    if (updates.schedule !== undefined && updates.schedule !== null && updates.schedule.enabled) {
        const scheduleValidation = ScheduleUtils.validateSchedule(updates.schedule);
        if (!scheduleValidation.valid) return false;
    }

    if (updates.rules !== undefined || updates.schedule !== undefined) {
        const updatedProfile = {...profiles[index], ...updates};
        const conflict = RuleEvaluator.findRuleConflict(profiles, updatedProfile, profileId);
        if (conflict) return false;
    }

    const merged = {...profiles[index], ...updates};
    if (validateProfile(merged) === null) {
        console.warn(`Hara Hachi Bu: updateProfile validation failed for "${profileId}"`);
        return false;
    }
    profiles[index] = merged;
    saveCustomProfiles(settings, profiles);
    return true;
}

/**
 * Delete a profile by ID.
 *
 * @param settings - GSettings object
 * @param profileId - ID of the profile to delete
 * @returns - True if deletion was successful
 */
export function deleteProfile(settings, profileId) {
    const profiles = [...getCustomProfiles(settings)];
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return false;

    const filtered = profiles.filter((p) => p.id !== profileId);
    saveCustomProfiles(settings, filtered);
    return true;
}

/**
 * Validate a profile ID for alphanumeric, hyphens and underscores only.
 *
 * @param id - Profile ID to validate
 * @returns - True if ID is valid
 */
export function isValidProfileId(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Validate profile input data and return detailed validation status.
 *
 * @param settings - GSettings object
 * @param id - Profile ID
 * @param name - Profile display name
 * @param powerMode - Power mode
 * @param batteryMode - Battery mode
 * @param [isEdit=false] - True if this is an update operation
 * @returns - {valid: boolean, error: string|null}
 */
export function validateProfileInput(settings, id, name, powerMode, batteryMode, isEdit = false) {
    if (!name || name.trim().length === 0) return {valid: false, error: _('Scenario name is required')};

    if (name.trim().length > 50) return {valid: false, error: _('Scenario name too long (max 50 characters)')};

    if (!isValidProfileId(id)) return {valid: false, error: _('Invalid scenario ID')};

    if (!isEdit) {
        const profiles = getCustomProfiles(settings);
        if (profiles.some((p) => p.id === id))
            return {valid: false, error: _('A scenario with a similar name already exists. Try a more distinct name.')};

        if (profiles.length >= MAX_PROFILES) return {valid: false, error: _('Maximum scenario limit reached')};
    }

    const validPowerModes = Object.keys(POWER_MODES);
    if (!validPowerModes.includes(powerMode)) return {valid: false, error: _('Invalid power mode')};

    const validBatteryModes = Object.keys(BATTERY_MODES);
    if (!validBatteryModes.includes(batteryMode)) return {valid: false, error: _('Invalid battery mode')};

    return {valid: true, error: null};
}

/** @constant */
const CURRENT_MIGRATION_VERSION = 6;

/**
 * Run all pending data migrations based on version tracking.
 *
 * @param settings - GSettings object
 * @returns - True if any migration was performed
 */
export function runMigrations(settings) {
    const currentVersion = settings.get_int('migration-version');
    if (currentVersion >= CURRENT_MIGRATION_VERSION) return false;

    let migrationsPerformed = false;

    if (currentVersion < 2) {
        if (_migrateToRuleBasedProfiles(settings)) migrationsPerformed = true;
    }

    if (currentVersion < 3) {
        if (_migrateToAutoManagedField(settings)) migrationsPerformed = true;
    }

    if (currentVersion < 4) {
        if (_seedDefaultProfiles(settings)) migrationsPerformed = true;
    }

    if (currentVersion < 5) {
        if (_addScheduleFieldToProfiles(settings)) migrationsPerformed = true;
    }

    if (currentVersion < 6) {
        if (_stripDerivedFields(settings)) migrationsPerformed = true;
    }

    settings.set_int('migration-version', CURRENT_MIGRATION_VERSION);
    return migrationsPerformed;
}

/**
 * Internal migration: feature flags to rule-based profile configurations.
 * @private
 * @param settings - GSettings object
 * @returns
 */
function _migrateToRuleBasedProfiles(settings) {
    const profiles = [...getCustomProfiles(settings)];
    let changed = false;

    for (const profile of profiles) {
        if (!profile.rules) {
            profile.rules = [];
            changed = true;
        }
        if (!profile.forceDischarge) {
            profile.forceDischarge = 'unspecified';
            changed = true;
        }
    }

    if (changed) saveCustomProfiles(settings, profiles);
    return changed;
}

/**
 * Internal migration: derive autoManaged field from existing rules.
 * @private
 * @param settings - GSettings object
 * @returns
 */
function _migrateToAutoManagedField(settings) {
    const profiles = [...getCustomProfiles(settings)];
    let changed = false;

    for (const profile of profiles) {
        if (profile.autoManaged === undefined) {
            profile.autoManaged = !!(profile.rules && profile.rules.length > 0);
            changed = true;
        }
    }

    if (changed) saveCustomProfiles(settings, profiles);
    return changed;
}

/**
 * Internal migration: seed default profiles on fresh install.
 * Only populates if custom-profiles is an empty array (fresh install).
 * @private
 * @param settings - GSettings object
 * @returns
 */
function _seedDefaultProfiles(settings) {
    try {
        const json = settings.get_string('custom-profiles');
        const profiles = JSON.parse(json);
        if (Array.isArray(profiles) && profiles.length === 0) {
            saveCustomProfiles(settings, Object.values(PROFILES));
            return true;
        }
    } catch (e) {
        console.debug('Hara Hachi Bu: restoreDefaultProfiles parse error:', e.message);
    }
    return false;
}

/**
 * Internal migration: add schedule field to all existing profiles.
 * @private
 * @param settings - GSettings object
 * @returns
 */
function _addScheduleFieldToProfiles(settings) {
    const profiles = [...getCustomProfiles(settings)];
    let changed = false;

    for (const profile of profiles) {
        if (profile.schedule === undefined) {
            profile.schedule = null;
            changed = true;
        }
    }

    if (changed) saveCustomProfiles(settings, profiles);
    return changed;
}

/**
 * Internal migration: strip derived/removed fields from all stored profiles.
 * Fields removed: icon, builtin, autoManaged, forceDischarge.
 * These are now either derived at runtime or orthogonal to profiles.
 * @private
 * @param settings - GSettings object
 * @returns
 */
function _stripDerivedFields(settings) {
    const profiles = [...getCustomProfiles(settings)];
    let changed = false;
    const fieldsToRemove = ['icon', 'builtin', 'autoManaged', 'forceDischarge'];

    for (const profile of profiles) {
        for (const field of fieldsToRemove) {
            if (field in profile) {
                delete profile[field];
                changed = true;
            }
        }
    }

    if (changed) saveCustomProfiles(settings, profiles);
    return changed;
}
