/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * RuleEvaluator implements most-specific-wins matching for profile rules.
 */
'use strict';

import {OPERATORS} from './parameterDetector.js';

/**
 * Evaluate a single rule condition against current parameters
 * @param {Object} condition - {param, op, value}
 * @param {Object} currentParams - Current parameter values
 * @returns {boolean} - Whether condition matches
 */
export function evaluateCondition(condition, currentParams) {
    try {
        const {param, op, value} = condition;
        const currentValue = currentParams[param];

        if (currentValue === undefined || currentValue === null) {
            return false;
        }

        const operator = OPERATORS[op];
        if (!operator) {
            console.warn(`Unified Power Manager: Unknown operator "${op}"`);
            return false;
        }

        return operator.evaluate(currentValue, value);
    } catch (e) {
        console.error(`Unified Power Manager: Error evaluating condition: ${e.message}`);
        return false;
    }
}

/**
 * Evaluate all rules for a profile against current parameters
 * @param {Array} rules - Array of rule conditions
 * @param {Object} currentParams - Current parameter values
 * @returns {boolean} - Whether all rules match
 */
export function evaluateRules(rules, currentParams) {
    if (!rules || rules.length === 0) {
        return false; // Profiles with no rules don't auto-activate
    }

    for (const condition of rules) {
        if (!evaluateCondition(condition, currentParams)) {
            return false;
        }
    }

    return true;
}

/**
 * Find the best matching profile using most-specific-wins logic
 * @param {Array} profiles - Array of profile objects with rules
 * @param {Object} currentParams - Current parameter values
 * @returns {Object|null} - Best matching profile or null
 */
export function findMatchingProfile(profiles, currentParams) {
    try {
        let bestMatch = null;
        let bestSpecificity = -1;

        for (const profile of profiles) {
            if (!profile.rules || profile.rules.length === 0) {
                continue; // Skip profiles without rules
            }

            if (evaluateRules(profile.rules, currentParams)) {
                const specificity = profile.rules.length;

                // More conditions = more specific
                if (specificity > bestSpecificity) {
                    bestMatch = profile;
                    bestSpecificity = specificity;
                }
            }
        }

        return bestMatch;
    } catch (e) {
        console.error(`Unified Power Manager: Error finding matching profile: ${e.message}`);
        return null;
    }
}

/**
 * Check if adding a rule would conflict with existing profiles
 * @param {Array} profiles - Existing profiles
 * @param {Object} newProfile - Profile being created/edited (with rules)
 * @param {string|null} editingProfileId - ID of profile being edited (null for new)
 * @returns {Object|null} - Conflicting profile or null
 */
export function findRuleConflict(profiles, newProfile, editingProfileId = null) {
    if (!newProfile.rules || newProfile.rules.length === 0) {
        return null; // No rules = no conflict
    }

    const newSpecificity = newProfile.rules.length;

    for (const existing of profiles) {
        // Skip self when editing
        if (editingProfileId && existing.id === editingProfileId) {
            continue;
        }

        if (!existing.rules || existing.rules.length === 0) {
            continue;
        }

        const existingSpecificity = existing.rules.length;

        // Check for exact same specificity with overlapping conditions
        if (existingSpecificity === newSpecificity) {
            if (rulesCouldConflict(existing.rules, newProfile.rules)) {
                return existing;
            }
        }
    }

    return null;
}

/**
 * Check if two rule sets could activate at the same time
 * This is a conservative check - if there's any parameter state
 * where both rule sets would match, they conflict
 * @param {Array} rules1 - First rule set
 * @param {Array} rules2 - Second rule set
 * @returns {boolean} - Whether rules could conflict
 */
function rulesCouldConflict(rules1, rules2) {
    // Build constraint maps for each rule set
    const constraints1 = buildConstraintMap(rules1);
    const constraints2 = buildConstraintMap(rules2);

    // Check if there's a valid parameter assignment that satisfies both
    const allParams = new Set([...Object.keys(constraints1), ...Object.keys(constraints2)]);

    for (const param of allParams) {
        const c1 = constraints1[param];
        const c2 = constraints2[param];

        if (!c1 || !c2) {
            continue; // One doesn't constrain this param, no conflict on this param
        }

        // Check if constraints are mutually exclusive
        if (!constraintsCanCoexist(c1, c2)) {
            return false; // They can't both match at the same time
        }
    }

    return true; // Both could potentially match simultaneously
}

/**
 * Build a map of parameter -> constraint from rules
 */
function buildConstraintMap(rules) {
    const map = {};
    for (const rule of rules) {
        if (!map[rule.param]) {
            map[rule.param] = [];
        }
        map[rule.param].push({op: rule.op, value: rule.value});
    }
    return map;
}

/**
 * Check if two constraint lists for the same parameter can both be true
 */
function constraintsCanCoexist(constraints1, constraints2) {
    // Simplification: For 'is' operator, check if required values overlap
    for (const c1 of constraints1) {
        for (const c2 of constraints2) {
            if (c1.op === 'is' && c2.op === 'is') {
                // Both require specific values - must be same
                if (c1.value === c2.value) {
                    return true;
                }
            } else if (c1.op === 'is' && c2.op === 'is_not') {
                // c1 requires value, c2 forbids different value - compatible if different
                if (c1.value !== c2.value) {
                    return true;
                }
            } else if (c1.op === 'is_not' && c2.op === 'is') {
                // c1 forbids value, c2 requires different value - compatible if different
                if (c1.value !== c2.value) {
                    return true;
                }
            } else if (c1.op === 'is_not' && c2.op === 'is_not') {
                // Both forbid values - potentially compatible
                return true;
            }
        }
    }

    return false;
}

/**
 * Validate a rule condition
 * @param {Object} condition - {param, op, value}
 * @returns {Object} - {valid: boolean, error: string|null}
 */
export function validateCondition(condition) {
    if (!condition || typeof condition !== 'object') {
        return {valid: false, error: 'Invalid condition object'};
    }

    const {param, op, value} = condition;

    if (!param || typeof param !== 'string') {
        return {valid: false, error: 'Missing or invalid parameter'};
    }

    if (!op || typeof op !== 'string') {
        return {valid: false, error: 'Missing or invalid operator'};
    }

    if (!OPERATORS[op]) {
        return {valid: false, error: `Unknown operator: ${op}`};
    }

    if (value === undefined || value === null) {
        return {valid: false, error: 'Missing value'};
    }

    return {valid: true, error: null};
}

/**
 * Validate a complete rule set
 * @param {Array} rules - Array of conditions
 * @returns {Object} - {valid: boolean, errors: string[]}
 */
export function validateRules(rules) {
    if (!rules) {
        return {valid: true, errors: []}; // No rules is valid
    }

    if (!Array.isArray(rules)) {
        return {valid: false, errors: ['Rules must be an array']};
    }

    const errors = [];
    const seenParams = new Set();

    for (let i = 0; i < rules.length; i++) {
        const result = validateCondition(rules[i]);
        if (!result.valid) {
            errors.push(`Rule ${i + 1}: ${result.error}`);
        } else {
            // Check for duplicate parameters with same operator
            const key = `${rules[i].param}:${rules[i].op}`;
            if (seenParams.has(key)) {
                errors.push(`Rule ${i + 1}: Duplicate condition for ${rules[i].param}`);
            }
            seenParams.add(key);
        }
    }

    return {valid: errors.length === 0, errors};
}

/**
 * Format rules for display
 * @param {Array} rules - Array of conditions
 * @returns {string} - Human-readable description
 */
export function formatRules(rules) {
    if (!rules || rules.length === 0) {
        return 'Manual only';
    }

    const parts = rules.map(r => {
        const opLabel = OPERATORS[r.op]?.label || r.op;
        return `${r.param} ${opLabel} ${r.value}`;
    });

    return parts.join(' AND ');
}
