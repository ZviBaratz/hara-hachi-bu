/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import * as RuleEvaluator from './ruleEvaluator.js';

/**
 * Maximum number of custom profiles allowed in settings.
 * @constant {number}
 */
export const MAX_PROFILES = 10;

/**
 * Valid options for the force discharge setting.
 * @constant {Object}
 */
export const FORCE_DISCHARGE_OPTIONS = {
    on: {label: 'On', value: 'on'},
    off: {label: 'Off', value: 'off'},
    unspecified: {label: 'Unspecified', value: 'unspecified'},
};

/**
 * Default profile definitions for backward compatibility.
 * @constant {Object}
 */
export const PROFILES = {
    docked: {powerMode: 'performance', batteryMode: 'max-lifespan'},
    travel: {powerMode: 'balanced', batteryMode: 'full-capacity'},
};

/**
 * Battery mode definitions with threshold ranges and default values.
 * @constant {Object}
 */
export const BATTERY_MODES = {
    'full-capacity': {
        label: 'Full Capacity',
        description: '95-100%',
        defaultStart: 95,
        defaultEnd: 100,
    },
    'balanced': {
        label: 'Balanced',
        description: '75-80%',
        defaultStart: 75,
        defaultEnd: 80,
    },
    'max-lifespan': {
        label: 'Max Lifespan',
        description: '55-60%',
        defaultStart: 55,
        defaultEnd: 60,
    },
};

/**
 * Power mode definitions with labels and icons.
 * @constant {Object}
 */
export const POWER_MODES = {
    'performance': {
        label: 'Performance',
        icon: 'power-profile-performance-symbolic',
    },
    'balanced': {
        label: 'Balanced',
        icon: 'power-profile-balanced-symbolic',
    },
    'power-saver': {
        label: 'Power Saver',
        icon: 'power-profile-power-saver-symbolic',
    },
};

/**
 * Detect which profile matches the current power and battery mode combination.
 * 
 * @param {string} currentPowerMode - Current power profile (performance, balanced, power-saver)
 * @param {string} currentBatteryMode - Current battery mode (full-capacity, balanced, max-lifespan)
 * @param {Gio.Settings|Object} [settings] - GSettings object or legacy profiles object
 * @returns {string|null} - Profile ID or null if no match (Custom mode)
 */
export function detectProfile(currentPowerMode, currentBatteryMode, settings = null) {
    // Support both new settings object and legacy profiles object
    let profiles;
    if (settings && typeof settings.get_string === 'function') {
        // New: settings object
        profiles = getCustomProfiles(settings);
    } else if (settings && typeof settings === 'object') {
        // Legacy: profiles object
        profiles = Object.entries(settings).map(([id, config]) => ({
            id,
            ...config,
        }));
    } else {
        // Fallback to defaults
        profiles = Object.entries(PROFILES).map(([id, config]) => ({
            id,
            ...config,
        }));
    }

    for (const profile of profiles) {
        if (profile.powerMode === currentPowerMode &&
            profile.batteryMode === currentBatteryMode) {
            return profile.id;
        }
    }

    return null; // Custom/no match
}

/**
 * Get profile configuration by ID.
 * 
 * @param {string} profileId - Unique identifier for the profile
 * @param {Gio.Settings|Object} [settings] - GSettings object or legacy profiles object
 * @returns {Object|null} - Profile configuration object or null if not found
 */
export function getProfileConfig(profileId, settings = null) {
    // Support both new settings object and legacy profiles object
    if (settings && typeof settings.get_string === 'function') {
        return getProfileById(settings, profileId);
    } else if (settings && typeof settings === 'object') {
        return settings[profileId] || null;
    } else {
        return PROFILES[profileId] || null;
    }
}

/**
 * Get IDs of all available profiles.
 * 
 * @param {Gio.Settings|Object} [settings] - GSettings object or legacy profiles object
 * @returns {string[]} - Array of profile IDs
 */
export function getAvailableProfiles(settings = null) {
    // Support both new settings object and legacy profiles object
    if (settings && typeof settings.get_string === 'function') {
        const profiles = getCustomProfiles(settings);
        return profiles.map(p => p.id);
    } else if (settings && typeof settings === 'object') {
        return Object.keys(settings);
    } else {
        return Object.keys(PROFILES);
    }
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
    const modeConfig = {
        'full-capacity': {startKey: 'threshold-full-start', endKey: 'threshold-full-end'},
        'balanced': {startKey: 'threshold-balanced-start', endKey: 'threshold-balanced-end'},
        'max-lifespan': {startKey: 'threshold-lifespan-start', endKey: 'threshold-lifespan-end'},
    };

    const config = modeConfig[batteryMode];
    if (!config)
        return null;

    if (settings) {
        return {
            start: settings.get_int(config.startKey),
            end: settings.get_int(config.endKey),
        };
    }

    const defaults = BATTERY_MODES[batteryMode];
    return {
        start: defaults.defaultStart,
        end: defaults.defaultEnd,
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
 * Validate a profile object for schema compliance.
 * 
 * @param {Object} profile - Profile object to validate
 * @returns {Object|null} - The validated profile or null if invalid
 */
export function validateProfile(profile) {
    if (!profile || typeof profile !== 'object')
        return null;

    const validPowerModes = ['performance', 'balanced', 'power-saver'];
    const validBatteryModes = ['full-capacity', 'balanced', 'max-lifespan'];
    const validForceDischarge = ['on', 'off', 'unspecified'];

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

    if (profile.forceDischarge !== undefined && profile.forceDischarge !== null) {
        if (!validForceDischarge.includes(profile.forceDischarge))
            return null;
    }

    if (profile.rules !== undefined && profile.rules !== null) {
        const rulesValidation = RuleEvaluator.validateRules(profile.rules);
        if (!rulesValidation.valid)
            return null;
    }

    return profile;
}

/**
 * Check if a profile contains automatic activation rules.
 * 
 * @param {Object} profile - Profile object to check
 * @returns {boolean} - True if profile has at least one rule
 */
export function hasAutoRules(profile) {
    return !!(profile && profile.rules && profile.rules.length > 0);
}

/**
 * Get all profiles from custom-profiles settings, initializing with defaults if necessary.
 * 
 * @param {Gio.Settings} settings - GSettings object
 * @returns {Object[]} - Array of validated profile objects
 */
export function getCustomProfiles(settings) {
    const defaults = [
        {
            id: 'docked',
            name: 'Docked',
            powerMode: 'performance',
            batteryMode: 'max-lifespan',
            forceDischarge: 'on',
            rules: [{param: 'external_display', op: 'is', value: 'connected'}],
            icon: 'upm-docked-symbolic',
            builtin: true,
        },
        {
            id: 'travel',
            name: 'Travel',
            powerMode: 'balanced',
            batteryMode: 'full-capacity',
            forceDischarge: 'off',
            rules: [{param: 'power_source', op: 'is', value: 'battery'}],
            icon: 'upm-travel-symbolic',
            builtin: true,
        },
    ];

    try {
        const json = settings.get_string('custom-profiles');
        const profiles = JSON.parse(json);

        if (!Array.isArray(profiles) || profiles.length === 0) {
            saveCustomProfiles(settings, defaults);
            return defaults;
        }

        const validProfiles = profiles.filter(p => validateProfile(p) !== null);

        if (validProfiles.length === 0) {
            saveCustomProfiles(settings, defaults);
            return defaults;
        }

        // Ensure builtin profiles are always present
        const hasBuiltins = {docked: false, travel: false};
        for (const p of validProfiles) {
            if (p.id === 'docked') hasBuiltins.docked = true;
            if (p.id === 'travel') hasBuiltins.travel = true;
        }

        let needsSave = false;
        for (const defaultProfile of defaults) {
            if (!hasBuiltins[defaultProfile.id]) {
                validProfiles.unshift(defaultProfile);
                needsSave = true;
            }
        }

        if (needsSave)
            saveCustomProfiles(settings, validProfiles);

        return validProfiles;
    } catch (e) {
        console.error('Unified Power Manager: Failed to parse custom profiles:', e);
        return defaults;
    }
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
 * @returns {boolean} - True if creation was successful
 */
export function createProfile(settings, id, name, powerMode, batteryMode, forceDischarge = 'unspecified', rules = null) {
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

    delete updates.id; // Prevent ID modification

    if (profiles[index].builtin)
        updates = {
            name: updates.name,
            powerMode: updates.powerMode,
            batteryMode: updates.batteryMode,
            forceDischarge: updates.forceDischarge,
            rules: updates.rules,
        };

    if (updates.rules !== undefined) {
        const rulesValidation = RuleEvaluator.validateRules(updates.rules);
        if (!rulesValidation.valid) return false;

        const updatedProfile = {...profiles[index], ...updates};
        const conflict = RuleEvaluator.findRuleConflict(profiles, updatedProfile, profileId);
        if (conflict) return false;
    }

    profiles[index] = {...profiles[index], ...updates};
    saveCustomProfiles(settings, profiles);
    return true;
}

/**
 * Delete a custom profile. Built-in profiles cannot be deleted.
 * 
 * @param {Gio.Settings} settings - GSettings object
 * @param {string} profileId - ID of the profile to delete
 * @returns {boolean} - True if deletion was successful
 */
export function deleteProfile(settings, profileId) {
    const profiles = getCustomProfiles(settings);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile || profile.builtin) return false;

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
        return {valid: false, error: 'Profile name is required'};
    
    if (name.trim().length > 50)
        return {valid: false, error: 'Profile name too long (max 50 characters)'};

    if (!isValidProfileId(id))
        return {valid: false, error: 'Invalid profile ID'};

    if (!isEdit) {
        const profiles = getCustomProfiles(settings);
        if (profiles.some(p => p.id === id))
            return {valid: false, error: 'Profile ID already exists'};

        if (profiles.length >= MAX_PROFILES)
            return {valid: false, error: 'Maximum profile limit reached'};
    }

    const validPowerModes = ['performance', 'balanced', 'power-saver'];
    if (!validPowerModes.includes(powerMode))
        return {valid: false, error: 'Invalid power mode'};

    const validBatteryModes = ['full-capacity', 'balanced', 'max-lifespan'];
    if (!validBatteryModes.includes(batteryMode))
        return {valid: false, error: 'Invalid battery mode'};

    return {valid: true, error: null};
}

/** @constant {number} */
const CURRENT_MIGRATION_VERSION = 2;

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

    if (currentVersion < 1) {
        if (_migrateProfilesToCustomFormat(settings)) migrationsPerformed = true;
    }

    if (currentVersion < 2) {
        if (_migrateToRuleBasedProfiles(settings)) migrationsPerformed = true;
    }

    settings.set_int('migration-version', CURRENT_MIGRATION_VERSION);
    return migrationsPerformed;
}

/**
 * Internal migration: legacy profile format to custom-profiles JSON.
 * @private
 * @param {Gio.Settings} settings - GSettings object
 * @returns {boolean}
 */
function _migrateProfilesToCustomFormat(settings) {
    const customProfilesJson = settings.get_string('custom-profiles');
    if (customProfilesJson && customProfilesJson !== '[]') return false;

    const profiles = [];
    ['docked', 'travel'].forEach(id => {
        try {
            const config = JSON.parse(settings.get_string(`profile-${id}`));
            profiles.push({
                id,
                name: id.charAt(0).toUpperCase() + id.slice(1),
                powerMode: config.powerMode,
                batteryMode: config.batteryMode,
                icon: `upm-${id}-symbolic`,
                builtin: true,
            });
        } catch {
            profiles.push({
                id,
                name: id.charAt(0).toUpperCase() + id.slice(1),
                powerMode: id === 'docked' ? 'performance' : 'balanced',
                batteryMode: id === 'docked' ? 'max-lifespan' : 'full-capacity',
                icon: `upm-${id}-symbolic`,
                builtin: true,
            });
        }
    });

    saveCustomProfiles(settings, profiles);
    return true;
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

    // Add rule only if an identical rule doesn't already exist
    const addRuleIfNew = (profile, rule) => {
        const exists = profile.rules.some(r =>
            r.param === rule.param && r.op === rule.op && r.value === rule.value
        );
        if (!exists) {
            profile.rules.push(rule);
            return true;
        }
        return false;
    };

    const dockingEnabled = settings.get_boolean('docking-detection-enabled');
    const powerSourceEnabled = settings.get_boolean('power-source-detection-enabled');

    if (dockingEnabled) {
        const dockedId = settings.get_string('docked-profile-id');
        const undockedId = settings.get_string('undocked-profile-id');

        const dockedProfile = profiles.find(p => p.id === dockedId);
        if (dockedProfile && addRuleIfNew(dockedProfile, {param: 'external_display', op: 'is', value: 'connected'}))
            changed = true;

        const undockedProfile = profiles.find(p => p.id === undockedId);
        if (undockedProfile && addRuleIfNew(undockedProfile, {param: 'external_display', op: 'is', value: 'not_connected'}))
            changed = true;
    }

    if (powerSourceEnabled) {
        const acId = settings.get_string('ac-profile-id');
        const batId = settings.get_string('battery-profile-id');

        const acProfile = profiles.find(p => p.id === acId);
        if (acProfile && addRuleIfNew(acProfile, {param: 'power_source', op: 'is', value: 'ac'}))
            changed = true;

        const batProfile = profiles.find(p => p.id === batId);
        if (batProfile && addRuleIfNew(batProfile, {param: 'power_source', op: 'is', value: 'battery'}))
            changed = true;
    }

    if (changed) saveCustomProfiles(settings, profiles);
    return changed;
}