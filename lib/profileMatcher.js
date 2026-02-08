/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import Gettext from 'gettext';
import * as RuleEvaluator from './ruleEvaluator.js';
import * as Constants from './constants.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

/**
 * Maximum number of custom profiles allowed in settings.
 * @constant {number}
 */
export const MAX_PROFILES = 10;

/**
 * Valid options for the force discharge setting.
 * @constant {Object}
 */
export const FORCE_DISCHARGE_OPTIONS = Constants.FORCE_DISCHARGE_OPTIONS;

/**
 * Default profile definitions for backward compatibility.
 * @constant {Object}
 */
export const PROFILES = Constants.DEFAULT_PROFILES;

/**
 * Battery mode definitions with threshold ranges and default values.
 * @constant {Object}
 */
export const BATTERY_MODES = Constants.BATTERY_MODES;

/**
 * Power mode definitions with labels and icons.
 * @constant {Object}
 */
export const POWER_MODES = Constants.POWER_MODES;

/**
 * Detect which profile matches the current power and battery mode combination.
 *
 * @param {string} currentPowerMode - Current power profile (performance, balanced, power-saver)
 * @param {string} currentBatteryMode - Current battery mode (full-capacity, balanced, max-lifespan)
 * @param {Gio.Settings} [settings] - GSettings object
 * @param {boolean} [currentForceDischarge] - Current force discharge state (optional)
 * @returns {string|null} - Profile ID or null if no match (Custom mode)
 */
export function detectProfile(currentPowerMode, currentBatteryMode, settings = null, currentForceDischarge = undefined) {
    const profiles = settings ? getCustomProfiles(settings) : Object.values(PROFILES);

    for (const profile of profiles) {
        if (profile.powerMode !== currentPowerMode ||
            profile.batteryMode !== currentBatteryMode)
            continue;

        // If profile specifies forceDischarge and caller provided current state, check match
        if (currentForceDischarge !== undefined &&
            profile.forceDischarge && profile.forceDischarge !== 'unspecified') {
            const profileFD = profile.forceDischarge === 'on';
            if (profileFD !== currentForceDischarge)
                continue;
        }

        return profile.id;
    }

    return null; // Custom/no match
}

/**
 * Get profile configuration by ID.
 *
 * @param {string} profileId - Unique identifier for the profile
 * @param {Gio.Settings} [settings] - GSettings object
 * @returns {Object|null} - Profile configuration object or null if not found
 */
export function getProfileConfig(profileId, settings = null) {
    if (settings)
        return getProfileById(settings, profileId);
    return PROFILES[profileId] || null;
}

/**
 * Get IDs of all available profiles.
 *
 * @param {Gio.Settings} [settings] - GSettings object
 * @returns {string[]} - Array of profile IDs
 */
export function getAvailableProfiles(settings = null) {
    if (settings) {
        const profiles = getCustomProfiles(settings);
        return profiles.map(p => p.id);
    }
    return Object.keys(PROFILES);
}

/**
 * Detect battery mode name based on start and end threshold values.
 * 
 * @param {number} startThreshold - Start charge threshold (-1 or 0 if not supported)
 * @param {number} endThreshold - End charge threshold (0-100)
 * @param {Gio.Settings} [settings] - GSettings object to read custom threshold values
 * @returns {string|null} - Battery mode name (full-capacity, balanced, max-lifespan) or null if no match
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
    const isEndOnly = startThreshold <= 0;

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
            if (endThreshold === expectedEnd)
                return mode.name;
        } else {
            if (startThreshold === expectedStart && endThreshold === expectedEnd)
                return mode.name;
        }
    }

    return null;
}

/**
 * Get threshold values associated with a specific battery mode.
 * 
 * @param {string} batteryMode - Battery mode name
 * @param {Gio.Settings} [settings] - GSettings object to read custom thresholds
 * @returns {Object|null} - {start: number, end: number} or null if invalid mode
 */
export function getThresholdsForMode(batteryMode, settings = null) {
    // Mode config is now in Constants.BATTERY_MODES, but for backward compatibility/clarity
    // we can look it up dynamically or keep using the map if we want to be safe.
    // However, Constants.BATTERY_MODES has the keys startKey/endKey which we can use.
    
    const config = BATTERY_MODES[batteryMode];
    if (!config)
        return null;

    if (settings) {
        const start = settings.get_int(config.startKey);
        const end = settings.get_int(config.endKey);
        if (start >= end) {
            console.warn(`Unified Power Manager: Invalid thresholds for ${batteryMode} (start=${start} >= end=${end}), using defaults`);
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
 * @param {string} jsonString - JSON string from settings
 * @returns {Object|null} - Parsed profile object or null if parsing failed
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
 * @param {Object} profile - Profile object to validate (modified in-place)
 * @returns {Object|null} - The validated profile or null if invalid
 */
export function validateProfile(profile) {
    if (!profile || typeof profile !== 'object')
        return null;

    const validPowerModes = Object.keys(POWER_MODES);
    const validBatteryModes = Object.keys(BATTERY_MODES);
    const validForceDischarge = Object.keys(FORCE_DISCHARGE_OPTIONS);

    // Validate required fields
    if (!validPowerModes.includes(profile.powerMode))
        return null;
    if (!validBatteryModes.includes(profile.batteryMode))
        return null;

    // Validate name
    if (typeof profile.name !== 'string')
        return null;
    const trimmedName = profile.name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 50)
        return null;
    profile.name = trimmedName;

    if (typeof profile.id !== 'string' || !isValidProfileId(profile.id))
        return null;

    // Validate optional fields
    if (profile.icon !== null && profile.icon !== undefined) {
        if (typeof profile.icon !== 'string')
            return null;
        if (profile.icon.length > 0 && !/^[a-zA-Z0-9_-]+$/.test(profile.icon))
            return null;
    }

    if (profile.builtin !== undefined && typeof profile.builtin !== 'boolean')
        return null;

    if (profile.autoManaged !== undefined && typeof profile.autoManaged !== 'boolean')
        return null;

    if (profile.forceDischarge !== undefined && profile.forceDischarge !== null) {
        if (!validForceDischarge.includes(profile.forceDischarge))
            return null;
    }

    if (profile.rules !== undefined && profile.rules !== null) {
        if (!Array.isArray(profile.rules)) {
            profile.rules = [];
        } else {
            const validRules = profile.rules.filter((rule, i) => {
                const result = RuleEvaluator.validateCondition(rule);
                if (!result.valid) {
                    console.warn(`Unified Power Manager: Dropping invalid rule ${i + 1} from profile "${profile.id}": ${result.error}`);
                    return false;
                }
                return true;
            });
            if (validRules.length !== profile.rules.length)
                profile.rules = validRules;
        }
    }

    return profile;
}

/**
 * Check if a profile is configured for automatic activation.
 *
 * @param {Object} profile - Profile object to check
 * @returns {boolean} - True if profile has autoManaged enabled
 */
export function isAutoManaged(profile) {
    return !!(profile && profile.autoManaged);
}

// Module-level cache for getCustomProfiles
let _cachedProfiles = null;
let _cachedProfilesJson = null;

/**
 * Get all profiles from custom-profiles settings, initializing with defaults if necessary.
 * Results are cached and invalidated when the GSettings JSON string changes.
 *
 * @param {Gio.Settings} settings - GSettings object
 * @returns {Object[]} - Array of validated profile objects
 */
export function getCustomProfiles(settings) {
    const defaults = Object.values(PROFILES);

    try {
        const json = settings.get_string('custom-profiles');

        if (json === _cachedProfilesJson && _cachedProfiles !== null)
            return _cachedProfiles;

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

        const validProfiles = profiles.filter(p => {
            if (validateProfile(p) === null) {
                console.warn(`Unified Power Manager: Dropping invalid profile (id: ${p?.id || 'unknown'}, name: ${p?.name || 'unknown'}): missing or invalid required fields`);
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
        console.error('Unified Power Manager: Failed to parse custom profiles:', e);
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
 * @param {Gio.Settings} settings - GSettings object
 * @param {Object[]} profiles - Array of profile objects to save
 */
export function saveCustomProfiles(settings, profiles) {
    settings.set_string('custom-profiles', JSON.stringify(profiles));
}

/**
 * Find a specific profile by its ID.
 * 
 * @param {Gio.Settings} settings - GSettings object
 * @param {string} profileId - Unique identifier for the profile
 * @returns {Object|null} - Profile object or null if not found
 */
export function getProfileById(settings, profileId) {
    const profiles = getCustomProfiles(settings);
    return profiles.find(p => p.id === profileId) || null;
}

/**
 * Create a new custom profile.
 *
 * @param {Gio.Settings} settings - GSettings object
 * @param {string} id - Unique profile ID
 * @param {string} name - Display name for the profile
 * @param {string} powerMode - Power profile name
 * @param {string} batteryMode - Battery mode name
 * @param {string} [forceDischarge='unspecified'] - Force discharge preference
 * @param {Object[]} [rules=null] - Optional automatic activation rules
 * @param {boolean} [autoManaged=false] - Whether profile auto-activates when rules match
 * @returns {boolean} - True if creation was successful
 */
export function createProfile(settings, id, name, powerMode, batteryMode, forceDischarge = 'unspecified', rules = null, autoManaged = false) {
    const profiles = getCustomProfiles(settings);

    if (profiles.length >= MAX_PROFILES) return false;
    if (profiles.some(p => p.id === id)) return false;
    if (!isValidProfileId(id)) return false;
    if (!name || name.trim().length === 0) return false;

    if (rules) {
        const rulesValidation = RuleEvaluator.validateRules(rules);
        if (!rulesValidation.valid) return false;

        const newProfile = {id, name, powerMode, batteryMode, rules};
        const conflict = RuleEvaluator.findRuleConflict(profiles, newProfile);
        if (conflict) return false;
    }

    profiles.push({
        id,
        name: name.trim(),
        powerMode,
        batteryMode,
        forceDischarge: forceDischarge || 'unspecified',
        rules: rules || [],
        icon: null,
        builtin: false,
        autoManaged: !!autoManaged,
    });
    saveCustomProfiles(settings, profiles);
    return true;
}

/**
 * Update an existing profile configuration.
 * 
 * @param {Gio.Settings} settings - GSettings object
 * @param {string} profileId - ID of the profile to update
 * @param {Object} updates - Fields and new values to update
 * @returns {boolean} - True if update was successful
 */
export function updateProfile(settings, profileId, updates) {
    const profiles = getCustomProfiles(settings);
    const index = profiles.findIndex(p => p.id === profileId);
    if (index === -1) return false;

    // Shallow copy to avoid mutating the caller's object
    updates = {...updates};
    delete updates.id; // Prevent ID modification

    if (updates.rules !== undefined) {
        const rulesValidation = RuleEvaluator.validateRules(updates.rules);
        if (!rulesValidation.valid) return false;

        const updatedProfile = {...profiles[index], ...updates};
        const conflict = RuleEvaluator.findRuleConflict(profiles, updatedProfile, profileId);
        if (conflict) return false;
    }

    const merged = {...profiles[index], ...updates};
    if (validateProfile(merged) === null) {
        console.warn(`Unified Power Manager: updateProfile validation failed for "${profileId}"`);
        return false;
    }
    profiles[index] = merged;
    saveCustomProfiles(settings, profiles);
    return true;
}

/**
 * Delete a profile by ID.
 *
 * @param {Gio.Settings} settings - GSettings object
 * @param {string} profileId - ID of the profile to delete
 * @returns {boolean} - True if deletion was successful
 */
export function deleteProfile(settings, profileId) {
    const profiles = getCustomProfiles(settings);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return false;

    const filtered = profiles.filter(p => p.id !== profileId);
    saveCustomProfiles(settings, filtered);
    return true;
}

/**
 * Validate a profile ID for alphanumeric, hyphens and underscores only.
 * 
 * @param {string} id - Profile ID to validate
 * @returns {boolean} - True if ID is valid
 */
export function isValidProfileId(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Validate profile input data and return detailed validation status.
 * 
 * @param {Gio.Settings} settings - GSettings object
 * @param {string} id - Profile ID
 * @param {string} name - Profile display name
 * @param {string} powerMode - Power mode
 * @param {string} batteryMode - Battery mode
 * @param {boolean} [isEdit=false] - True if this is an update operation
 * @returns {Object} - {valid: boolean, error: string|null}
 */
export function validateProfileInput(settings, id, name, powerMode, batteryMode, isEdit = false) {
    if (!name || name.trim().length === 0)
        return {valid: false, error: _('Profile name is required')};

    if (name.trim().length > 50)
        return {valid: false, error: _('Profile name too long (max 50 characters)')};

    if (!isValidProfileId(id))
        return {valid: false, error: _('Invalid profile ID')};

    if (!isEdit) {
        const profiles = getCustomProfiles(settings);
        if (profiles.some(p => p.id === id))
            return {valid: false, error: _('Profile ID already exists')};

        if (profiles.length >= MAX_PROFILES)
            return {valid: false, error: _('Maximum profile limit reached')};
    }

    const validPowerModes = Object.keys(POWER_MODES);
    if (!validPowerModes.includes(powerMode))
        return {valid: false, error: _('Invalid power mode')};

    const validBatteryModes = Object.keys(BATTERY_MODES);
    if (!validBatteryModes.includes(batteryMode))
        return {valid: false, error: _('Invalid battery mode')};

    return {valid: true, error: null};
}

/** @constant {number} */
const CURRENT_MIGRATION_VERSION = 4;

/**
 * Run all pending data migrations based on version tracking.
 * 
 * @param {Gio.Settings} settings - GSettings object
 * @returns {boolean} - True if any migration was performed
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

    settings.set_int('migration-version', CURRENT_MIGRATION_VERSION);
    return migrationsPerformed;
}

/**
 * Internal migration: feature flags to rule-based profile configurations.
 * @private
 * @param {Gio.Settings} settings - GSettings object
 * @returns {boolean}
 */
function _migrateToRuleBasedProfiles(settings) {
    const profiles = getCustomProfiles(settings);
    let changed = false;

    for (const profile of profiles) {
        if (!profile.rules) { profile.rules = []; changed = true; }
        if (!profile.forceDischarge) { profile.forceDischarge = 'unspecified'; changed = true; }
    }

    if (changed) saveCustomProfiles(settings, profiles);
    return changed;
}

/**
 * Internal migration: derive autoManaged field from existing rules.
 * @private
 * @param {Gio.Settings} settings - GSettings object
 * @returns {boolean}
 */
function _migrateToAutoManagedField(settings) {
    const profiles = getCustomProfiles(settings);
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
 * @param {Gio.Settings} settings - GSettings object
 * @returns {boolean}
 */
function _seedDefaultProfiles(settings) {
    try {
        const json = settings.get_string('custom-profiles');
        const profiles = JSON.parse(json);
        if (Array.isArray(profiles) && profiles.length === 0) {
            saveCustomProfiles(settings, Object.values(PROFILES));
            return true;
        }
    } catch {
        // Parse failure handled by getCustomProfiles elsewhere
    }
    return false;
}