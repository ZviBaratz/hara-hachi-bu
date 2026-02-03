/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import * as RuleEvaluator from './ruleEvaluator.js';

// Maximum number of custom profiles
export const MAX_PROFILES = 10;

// Force discharge options
export const FORCE_DISCHARGE_OPTIONS = {
    on: {label: 'On', value: 'on'},
    off: {label: 'Off', value: 'off'},
    unspecified: {label: 'Unspecified', value: 'unspecified'},
};

// Default profile definitions (kept for backward compatibility)
export const PROFILES = {
    docked: {powerMode: 'performance', batteryMode: 'max-lifespan'},
    travel: {powerMode: 'balanced', batteryMode: 'full-capacity'},
};

// Battery mode definitions with threshold ranges
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

// Power mode definitions
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
 * Detect which profile matches the current power and battery mode combination
 * @param {string} currentPowerMode - Current power profile
 * @param {string} currentBatteryMode - Current battery mode
 * @param {Object} settings - GSettings object (or legacy customProfiles object)
 * @returns {string|null} - Profile ID or null if no match
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
 * Get profile configuration by name
 * @param {string} profileName - Profile ID
 * @param {Object} settings - GSettings object (or legacy customProfiles object)
 * @returns {Object|null} - Profile configuration or null
 */
export function getProfileConfig(profileName, settings = null) {
    // Support both new settings object and legacy profiles object
    if (settings && typeof settings.get_string === 'function') {
        // New: use getProfileById
        return getProfileById(settings, profileName);
    } else if (settings && typeof settings === 'object') {
        // Legacy: profiles object
        return settings[profileName] || null;
    } else {
        // Fallback to defaults
        return PROFILES[profileName] || null;
    }
}

/**
 * Get all available profiles
 * @param {Object} settings - GSettings object (or legacy customProfiles object)
 * @returns {Array} - Array of profile IDs
 */
export function getAvailableProfiles(settings = null) {
    // Support both new settings object and legacy profiles object
    if (settings && typeof settings.get_string === 'function') {
        // New: get from custom-profiles
        const profiles = getCustomProfiles(settings);
        return profiles.map(p => p.id);
    } else if (settings && typeof settings === 'object') {
        // Legacy: profiles object
        return Object.keys(settings);
    } else {
        // Fallback to defaults
        return Object.keys(PROFILES);
    }
}

/**
 * Detect battery mode from threshold values
 * @param {number} startThreshold - Start charge threshold (-1 or 0 if not supported)
 * @param {number} endThreshold - End charge threshold
 * @param {Object} settings - GSettings object to read custom thresholds
 * @returns {string|null} - Battery mode name or null if no match
 */
export function detectBatteryModeFromThresholds(startThreshold, endThreshold, settings = null) {
    // Check against each battery mode's thresholds
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

    // Determine if this is an end-only device (start threshold is -1, 0, or not set)
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

        // For end-only devices, match based on end threshold only
        if (isEndOnly) {
            if (endThreshold === expectedEnd)
                return mode.name;
        } else {
            // Full match for devices with both thresholds
            if (startThreshold === expectedStart && endThreshold === expectedEnd)
                return mode.name;
        }
    }

    return null;
}

/**
 * Get thresholds for a battery mode
 * @param {string} batteryMode - Battery mode name
 * @param {Object} settings - GSettings object to read custom thresholds
 * @returns {Object} - {start, end} threshold values
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
 * Parse profile from JSON settings string
 * @param {string} jsonString - JSON string from settings
 * @returns {Object|null} - Parsed profile or null
 */
export function parseProfileFromSettings(jsonString) {
    try {
        return JSON.parse(jsonString);
    } catch {
        return null;
    }
}

/**
 * Validate a profile object for required fields and valid values
 * @param {Object} profile - Profile object to validate
 * @returns {Object|null} - Validated profile or null if invalid
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

    // Validate name - must be non-empty string after trimming
    if (typeof profile.name !== 'string')
        return null;
    const trimmedName = profile.name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 50)
        return null;

    if (typeof profile.id !== 'string' || !isValidProfileId(profile.id))
        return null;

    // Validate optional fields
    // icon: must be null, undefined, or a valid icon name string
    if (profile.icon !== null && profile.icon !== undefined) {
        if (typeof profile.icon !== 'string')
            return null;
        // Basic icon name validation: alphanumeric, hyphens, must end with -symbolic for symbolic icons
        if (profile.icon.length > 0 && !/^[a-zA-Z0-9_-]+$/.test(profile.icon))
            return null;
    }

    // builtin: must be boolean if present
    if (profile.builtin !== undefined && typeof profile.builtin !== 'boolean')
        return null;

    // forceDischarge: must be valid option if present
    if (profile.forceDischarge !== undefined && profile.forceDischarge !== null) {
        if (!validForceDischarge.includes(profile.forceDischarge))
            return null;
    }

    // rules: must be valid array of conditions if present
    if (profile.rules !== undefined && profile.rules !== null) {
        const rulesValidation = RuleEvaluator.validateRules(profile.rules);
        if (!rulesValidation.valid)
            return null;
    }

    return profile;
}

/**
 * Check if a profile has auto-activation rules
 * @param {Object} profile - Profile object
 * @returns {boolean} - Whether profile has rules
 */
export function hasAutoRules(profile) {
    return profile && profile.rules && profile.rules.length > 0;
}

/**
 * Get profiles from settings (DEPRECATED - use getCustomProfiles instead)
 * @param {Object} settings - GSettings object
 * @returns {Object} - Profile definitions
 */
export function getProfilesFromSettings(settings) {
    const profiles = {};

    const dockedJson = settings.get_string('profile-docked');
    const dockedConfig = parseProfileFromSettings(dockedJson);
    if (dockedConfig)
        profiles.docked = dockedConfig;

    const travelJson = settings.get_string('profile-travel');
    const travelConfig = parseProfileFromSettings(travelJson);
    if (travelConfig)
        profiles.travel = travelConfig;

    return Object.keys(profiles).length > 0 ? profiles : PROFILES;
}

/**
 * Get all profiles from custom-profiles settings
 * @param {Object} settings - GSettings object
 * @returns {Array} - Array of profile objects
 */
export function getCustomProfiles(settings) {
    const defaults = [
        {
            id: 'docked',
            name: 'Docked',
            powerMode: 'performance',
            batteryMode: 'max-lifespan',
            icon: 'upm-docked-symbolic',
            builtin: true,
        },
        {
            id: 'travel',
            name: 'Travel',
            powerMode: 'balanced',
            batteryMode: 'full-capacity',
            icon: 'upm-travel-symbolic',
            builtin: true,
        },
    ];

    try {
        const json = settings.get_string('custom-profiles');
        const profiles = JSON.parse(json);

        // Initialize with defaults if empty
        if (!Array.isArray(profiles) || profiles.length === 0) {
            saveCustomProfiles(settings, defaults);
            return defaults;
        }

        // Validate each profile and filter out invalid ones
        const validProfiles = profiles.filter(p => validateProfile(p) !== null);

        // If all profiles were invalid, return defaults
        if (validProfiles.length === 0) {
            console.error('Unified Power Manager: All profiles invalid, resetting to defaults');
            saveCustomProfiles(settings, defaults);
            return defaults;
        }

        // Ensure builtin profiles are always present
        const hasBuiltins = {docked: false, travel: false};
        for (const p of validProfiles) {
            if (p.id === 'docked')
                hasBuiltins.docked = true;
            if (p.id === 'travel')
                hasBuiltins.travel = true;
        }

        let needsSave = false;
        for (const defaultProfile of defaults) {
            if (!hasBuiltins[defaultProfile.id]) {
                console.log(`Unified Power Manager: Restoring missing builtin profile '${defaultProfile.id}'`);
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
 * Save custom profiles to settings
 * @param {Object} settings - GSettings object
 * @param {Array} profiles - Array of profile objects
 */
export function saveCustomProfiles(settings, profiles) {
    settings.set_string('custom-profiles', JSON.stringify(profiles));
}

/**
 * Get a profile by ID
 * @param {Object} settings - GSettings object
 * @param {string} profileId - Profile ID
 * @returns {Object|null} - Profile object or null
 */
export function getProfileById(settings, profileId) {
    const profiles = getCustomProfiles(settings);
    return profiles.find(p => p.id === profileId) || null;
}

/**
 * Create a new profile
 * @param {Object} settings - GSettings object
 * @param {string} id - Profile ID
 * @param {string} name - Profile display name
 * @param {string} powerMode - Power mode
 * @param {string} batteryMode - Battery mode
 * @param {string} forceDischarge - Force discharge preference (on/off/unspecified)
 * @param {Array} rules - Auto-activation rules
 * @returns {boolean} - Success status
 */
export function createProfile(settings, id, name, powerMode, batteryMode, forceDischarge = 'unspecified', rules = null) {
    const profiles = getCustomProfiles(settings);

    if (profiles.length >= MAX_PROFILES)
        return false;
    if (profiles.some(p => p.id === id))
        return false;
    if (!isValidProfileId(id))
        return false;
    if (!name || name.trim().length === 0)
        return false;

    // Validate rules if provided
    if (rules) {
        const rulesValidation = RuleEvaluator.validateRules(rules);
        if (!rulesValidation.valid)
            return false;

        // Check for conflicts
        const newProfile = {id, name, powerMode, batteryMode, rules};
        const conflict = RuleEvaluator.findRuleConflict(profiles, newProfile);
        if (conflict) {
            console.warn(`Unified Power Manager: Rule conflict with profile "${conflict.name}"`);
            return false;
        }
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
 * Update an existing profile
 * @param {Object} settings - GSettings object
 * @param {string} profileId - Profile ID
 * @param {Object} updates - Fields to update
 * @returns {boolean} - Success status
 */
export function updateProfile(settings, profileId, updates) {
    const profiles = getCustomProfiles(settings);
    const index = profiles.findIndex(p => p.id === profileId);
    if (index === -1)
        return false;

    // Never allow changing ID (stable identifier)
    delete updates.id;

    // Builtin profiles can only change modes, forceDischarge, and rules, not name
    if (profiles[index].builtin)
        updates = {
            powerMode: updates.powerMode,
            batteryMode: updates.batteryMode,
            forceDischarge: updates.forceDischarge,
            rules: updates.rules,
        };

    // Validate rules if being updated
    if (updates.rules !== undefined) {
        const rulesValidation = RuleEvaluator.validateRules(updates.rules);
        if (!rulesValidation.valid)
            return false;

        // Check for conflicts with other profiles
        const updatedProfile = {...profiles[index], ...updates};
        const conflict = RuleEvaluator.findRuleConflict(profiles, updatedProfile, profileId);
        if (conflict) {
            console.warn(`Unified Power Manager: Rule conflict with profile "${conflict.name}"`);
            return false;
        }
    }

    profiles[index] = {...profiles[index], ...updates};
    saveCustomProfiles(settings, profiles);
    return true;
}

/**
 * Delete a profile
 * @param {Object} settings - GSettings object
 * @param {string} profileId - Profile ID
 * @returns {boolean} - Success status
 */
export function deleteProfile(settings, profileId) {
    const profiles = getCustomProfiles(settings);
    const profile = profiles.find(p => p.id === profileId);
    if (!profile || profile.builtin)
        return false;

    const filtered = profiles.filter(p => p.id !== profileId);
    saveCustomProfiles(settings, filtered);
    return true;
}

/**
 * Validate profile ID format
 * @param {string} id - Profile ID to validate
 * @returns {boolean} - Valid status
 */
export function isValidProfileId(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Validate profile creation inputs and return detailed error information.
 * This centralizes validation logic for use in UI and business logic layers.
 *
 * @param {Object} settings - GSettings object
 * @param {string} id - Profile ID
 * @param {string} name - Profile display name
 * @param {string} powerMode - Power mode
 * @param {string} batteryMode - Battery mode
 * @param {boolean} isEdit - Whether this is an edit operation
 * @returns {Object} - {valid: boolean, error: string|null}
 */
export function validateProfileInput(settings, id, name, powerMode, batteryMode, isEdit = false) {
    // Validate name
    if (!name || name.trim().length === 0) {
        return {valid: false, error: 'Profile name is required'};
    }
    if (name.trim().length > 50) {
        return {valid: false, error: 'Profile name too long (max 50 characters)'};
    }

    // Validate ID format
    if (!isValidProfileId(id)) {
        return {valid: false, error: 'Invalid profile ID (use lowercase letters, numbers, hyphens, underscores)'};
    }

    // Check for duplicate ID (only on create)
    if (!isEdit) {
        const profiles = getCustomProfiles(settings);
        if (profiles.some(p => p.id === id)) {
            return {valid: false, error: 'A profile with this ID already exists'};
        }
        if (profiles.length >= MAX_PROFILES) {
            return {valid: false, error: `Maximum ${MAX_PROFILES} profiles allowed`};
        }
    }

    // Validate power mode
    const validPowerModes = ['performance', 'balanced', 'power-saver'];
    if (!validPowerModes.includes(powerMode)) {
        return {valid: false, error: 'Invalid power mode'};
    }

    // Validate battery mode
    const validBatteryModes = ['full-capacity', 'balanced', 'max-lifespan'];
    if (!validBatteryModes.includes(batteryMode)) {
        return {valid: false, error: 'Invalid battery mode'};
    }

    return {valid: true, error: null};
}

// Current migration version - increment when adding new migrations
const CURRENT_MIGRATION_VERSION = 2;

/**
 * Run all pending migrations based on version tracking
 * @param {Object} settings - GSettings object
 * @returns {boolean} - True if any migrations were performed
 */
export function runMigrations(settings) {
    const currentVersion = settings.get_int('migration-version');

    if (currentVersion >= CURRENT_MIGRATION_VERSION) {
        return false; // Already up to date
    }

    let migrationsPerformed = false;

    // Migration v0 -> v1: Migrate old profile format to custom-profiles
    if (currentVersion < 1) {
        if (_migrateProfilesToCustomFormat(settings)) {
            migrationsPerformed = true;
        }
    }

    // Migration v1 -> v2: Migrate docking/power-source settings to rules
    if (currentVersion < 2) {
        if (_migrateToRuleBasedProfiles(settings)) {
            migrationsPerformed = true;
        }
    }

    // Mark migrations as complete
    settings.set_int('migration-version', CURRENT_MIGRATION_VERSION);
    console.log(`Unified Power Manager: Migration version updated to ${CURRENT_MIGRATION_VERSION}`);

    return migrationsPerformed;
}

/**
 * Internal migration: old profile format to custom-profiles
 * @param {Object} settings - GSettings object
 * @returns {boolean} - True if migration was performed
 */
function _migrateProfilesToCustomFormat(settings) {
    const customProfilesJson = settings.get_string('custom-profiles');
    if (customProfilesJson && customProfilesJson !== '[]')
        return false; // Already has custom profiles

    const profiles = [];

    // Migrate docked
    try {
        const dockedJson = settings.get_string('profile-docked');
        const config = JSON.parse(dockedJson);
        profiles.push({
            id: 'docked',
            name: 'Docked',
            powerMode: config.powerMode,
            batteryMode: config.batteryMode,
            icon: 'upm-docked-symbolic',
            builtin: true,
        });
    } catch {
        profiles.push({
            id: 'docked',
            name: 'Docked',
            powerMode: 'performance',
            batteryMode: 'max-lifespan',
            icon: 'upm-docked-symbolic',
            builtin: true,
        });
    }

    // Migrate travel
    try {
        const travelJson = settings.get_string('profile-travel');
        const config = JSON.parse(travelJson);
        profiles.push({
            id: 'travel',
            name: 'Travel',
            powerMode: config.powerMode,
            batteryMode: config.batteryMode,
            icon: 'upm-travel-symbolic',
            builtin: true,
        });
    } catch {
        profiles.push({
            id: 'travel',
            name: 'Travel',
            powerMode: 'balanced',
            batteryMode: 'full-capacity',
            icon: 'upm-travel-symbolic',
            builtin: true,
        });
    }

    saveCustomProfiles(settings, profiles);
    console.log('Unified Power Manager: Migrated profiles to custom format');
    return true;
}

/**
 * Internal migration: docking/power-source settings to rule-based profiles
 * @param {Object} settings - GSettings object
 * @returns {boolean} - True if migration was performed
 */
function _migrateToRuleBasedProfiles(settings) {
    console.log('Unified Power Manager: Starting rule-based migration');

    const profiles = getCustomProfiles(settings);
    let changed = false;

    // Ensure all profiles have required new fields
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

    // Read old docking detection settings
    const dockingEnabled = settings.get_boolean('docking-detection-enabled');
    const dockedProfileId = settings.get_string('docked-profile-id');
    const undockedProfileId = settings.get_string('undocked-profile-id');

    // Read old power source detection settings
    const powerSourceEnabled = settings.get_boolean('power-source-detection-enabled');
    const acProfileId = settings.get_string('ac-profile-id');
    const batteryProfileId = settings.get_string('battery-profile-id');

    // Helper to find or create rules for a profile
    const addRuleToProfile = (profileId, rule) => {
        const profile = profiles.find(p => p.id === profileId);
        if (!profile) {
            console.warn(`Unified Power Manager: Migration - Profile "${profileId}" not found`);
            return false;
        }

        if (!profile.rules) {
            profile.rules = [];
        }

        // Check if rule already exists
        const exists = profile.rules.some(r =>
            r.param === rule.param && r.op === rule.op && r.value === rule.value
        );

        if (!exists) {
            profile.rules.push(rule);
            return true;
        }
        return false;
    };

    // Migrate docking detection rules
    if (dockingEnabled) {
        if (dockedProfileId) {
            if (addRuleToProfile(dockedProfileId, {
                param: 'external_display',
                op: 'is',
                value: 'connected',
            })) {
                console.log(`Unified Power Manager: Added external_display rule to "${dockedProfileId}"`);
                changed = true;
            }
        }

        if (undockedProfileId) {
            if (addRuleToProfile(undockedProfileId, {
                param: 'external_display',
                op: 'is',
                value: 'not_connected',
            })) {
                console.log(`Unified Power Manager: Added external_display rule to "${undockedProfileId}"`);
                changed = true;
            }
        }
    }

    // Migrate power source detection rules
    if (powerSourceEnabled) {
        if (acProfileId) {
            if (addRuleToProfile(acProfileId, {
                param: 'power_source',
                op: 'is',
                value: 'ac',
            })) {
                console.log(`Unified Power Manager: Added power_source rule to "${acProfileId}"`);
                changed = true;
            }
        }

        if (batteryProfileId) {
            if (addRuleToProfile(batteryProfileId, {
                param: 'power_source',
                op: 'is',
                value: 'battery',
            })) {
                console.log(`Unified Power Manager: Added power_source rule to "${batteryProfileId}"`);
                changed = true;
            }
        }
    }

    // Handle potential conflicts from combining docking + power source rules
    // If a profile has both external_display AND power_source rules, it becomes more specific
    // This is actually correct behavior - more conditions = more specific = wins

    if (changed) {
        saveCustomProfiles(settings, profiles);
        console.log('Unified Power Manager: Migrated to rule-based profiles');
    }

    return changed;
}

/**
 * Migrate from old profile format to custom-profiles
 * @param {Object} settings - GSettings object
 * @returns {boolean} - True if migration was performed
 * @deprecated Use runMigrations() instead
 */
export function migrateProfilesToCustomFormat(settings) {
    // Delegate to runMigrations for backward compatibility
    return runMigrations(settings);
}
