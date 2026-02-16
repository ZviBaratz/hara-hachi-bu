/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * RuleEvaluator implements most-specific-wins matching for profile rules.
 */
'use strict';

import GLib from 'gi://GLib';
import {OPERATORS, PARAMETERS} from './constants.js';
import * as ScheduleUtils from './scheduleUtils.js';

const _ = s => GLib.dgettext('hara-hachi-bu', s);

/**
 * Evaluate a single rule condition against current parameters
 * @param {Object} condition - {param, op, value}
 * @param {Object} currentParams - Current parameter values
 * @returns {boolean} - Whether condition matches
 */
export function evaluateCondition(condition, currentParams, isCurrentlyActive = false) {
    try {
        const {param, op, value} = condition;
        const currentValue = currentParams[param];

        if (currentValue === undefined || currentValue === null) {
            return false;
        }

        const operator = OPERATORS[op];
        if (!operator) {
            console.warn(`Hara Hachi Bu: Unknown operator "${op}"`);
            return false;
        }

        if (isCurrentlyActive && operator.evaluateWithHysteresis)
            return operator.evaluateWithHysteresis(currentValue, value, true);

        return operator.evaluate(currentValue, value);
    } catch (e) {
        console.error(`Hara Hachi Bu: Error evaluating condition: ${e.message}`);
        return false;
    }
}

/**
 * Evaluate all rules for a profile against current parameters
 * @param {Array} rules - Array of rule conditions
 * @param {Object} currentParams - Current parameter values
 * @returns {boolean} - Whether all rules match
 */
export function evaluateRules(rules, currentParams, isCurrentlyActive = false) {
    if (!rules || rules.length === 0) {
        return false; // Profiles with no rules don't auto-activate
    }

    for (const condition of rules) {
        if (!evaluateCondition(condition, currentParams, isCurrentlyActive)) {
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
export function findMatchingProfile(profiles, currentParams, activeProfileId = null) {
    try {
        let bestMatch = null;
        let bestSpecificity = -1;

        for (const profile of profiles) {
            const hasRules = profile.rules?.length > 0;
            const hasSchedule = profile.schedule?.enabled;

            if (!hasRules && !hasSchedule)
                continue;

            // Schedule check: if profile has schedule but it's not active now, skip
            if (hasSchedule && !ScheduleUtils.isScheduleActive(profile.schedule))
                continue;

            const isCurrentlyActive = activeProfileId !== null && profile.id === activeProfileId;

            // Rules check: schedule-only profiles always match on the rules side
            const rulesMatch = hasRules
                ? evaluateRules(profile.rules, currentParams, isCurrentlyActive)
                : true;
            if (!rulesMatch)
                continue;

            const specificity = (hasRules ? profile.rules.length : 0) + (hasSchedule ? 1 : 0);

            if (specificity > bestSpecificity) {
                bestMatch = profile;
                bestSpecificity = specificity;
            } else if (specificity === bestSpecificity) {
                const bestHasSchedule = bestMatch.schedule?.enabled;
                if (hasSchedule && !bestHasSchedule) {
                    // Tiebreaker: scheduled profile wins over unscheduled
                    // at same specificity during its active window
                    bestMatch = profile;
                } else if (hasSchedule && bestHasSchedule) {
                    // Both have active schedules at same specificity:
                    // deterministic tiebreaker — alphabetical by profile ID
                    // so result is independent of array order
                    if (profile.id < bestMatch.id)
                        bestMatch = profile;
                }
                // If neither has schedule, or only bestMatch has schedule: keep bestMatch
            }
        }

        return bestMatch;
    } catch (e) {
        console.error(`Hara Hachi Bu: Error finding matching profile: ${e.message}`);
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
    const newHasRules = newProfile.rules?.length > 0;
    const newHasSchedule = newProfile.schedule?.enabled;

    if (!newHasRules && !newHasSchedule)
        return null; // No rules and no schedule = no conflict

    const newSpecificity = (newHasRules ? newProfile.rules.length : 0) + (newHasSchedule ? 1 : 0);

    for (const existing of profiles) {
        // Skip self when editing
        if (editingProfileId && existing.id === editingProfileId)
            continue;

        const existingHasRules = existing.rules?.length > 0;
        const existingHasSchedule = existing.schedule?.enabled;

        if (!existingHasRules && !existingHasSchedule)
            continue;

        // Identical rules with different schedules allow time-based variants.
        // e.g., "Docked" (no schedule) + "Morning Docked" (07:00-09:00) with
        // the same rules: the scheduled variant wins during its window.
        if (existingHasRules && newHasRules &&
            rulesAreIdentical(existing.rules, newProfile.rules)) {
            // One scheduled, one not → no conflict (scheduled wins when active)
            if (existingHasSchedule !== newHasSchedule)
                continue;

            // Both scheduled → check time overlap
            if (existingHasSchedule && newHasSchedule) {
                if (!ScheduleUtils.schedulesOverlap(existing.schedule, newProfile.schedule))
                    continue; // Non-overlapping → no conflict
                return existing; // Overlapping schedules with same rules → conflict
            }

            // Both unscheduled with identical rules → conflict
            return existing;
        }

        const existingSpecificity = (existingHasRules ? existing.rules.length : 0) + (existingHasSchedule ? 1 : 0);

        // Only check same specificity — different specificity is resolved by most-specific-wins
        if (existingSpecificity !== newSpecificity)
            continue;

        // Check if rules could conflict
        // Only when BOTH have rules can we check for mutual exclusivity.
        // Otherwise (one or neither has rules), assume rules don't prevent conflict.
        const rulesConflict = (existingHasRules && newHasRules)
            ? rulesCouldConflict(existing.rules, newProfile.rules)
            : true;

        if (!rulesConflict)
            continue;

        // One scheduled, one not → no conflict
        // (scheduled wins during its window via runtime tiebreaker)
        if (existingHasSchedule !== newHasSchedule)
            continue;

        // Both scheduled → check time overlap
        if (existingHasSchedule && newHasSchedule) {
            if (!ScheduleUtils.schedulesOverlap(existing.schedule, newProfile.schedule))
                continue;
        }

        // Both unscheduled, or both scheduled with overlap → conflict
        return existing;
    }

    return null;
}

/**
 * Check if two rule arrays are identical (same params, ops, values).
 * Order-independent comparison.
 * @param {Array|null} rules1
 * @param {Array|null} rules2
 * @returns {boolean}
 * @private
 */
function rulesAreIdentical(rules1, rules2) {
    if (!rules1 && !rules2)
        return true;
    if (!rules1 || !rules2)
        return false;
    if (rules1.length !== rules2.length)
        return false;
    if (rules1.length === 0)
        return true;

    const sorted1 = [...rules1].sort((a, b) =>
        a.param.localeCompare(b.param) || a.op.localeCompare(b.op) || a.value.localeCompare(b.value));
    const sorted2 = [...rules2].sort((a, b) =>
        a.param.localeCompare(b.param) || a.op.localeCompare(b.op) || a.value.localeCompare(b.value));

    for (let i = 0; i < sorted1.length; i++) {
        if (sorted1[i].param !== sorted2[i].param ||
            sorted1[i].op !== sorted2[i].op ||
            sorted1[i].value !== sorted2[i].value)
            return false;
    }

    return true;
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
        if (!constraintsCanCoexist(c1, c2, param)) {
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
 * Check if two constraint lists for the same parameter can both be true.
 * Assumes each constraint list has at most one 'is' and one 'is_not' per
 * parameter (enforced by validateRules duplicate-parameter check).
 */
function constraintsCanCoexist(constraints1, constraints2, param) {
    for (const c1 of constraints1) {
        for (const c2 of constraints2) {
            // Binary operator pairs (existing logic)
            if (c1.op === 'is' && c2.op === 'is') {
                if (c1.value === c2.value)
                    return true;
            } else if (c1.op === 'is' && c2.op === 'is_not') {
                if (c1.value !== c2.value)
                    return true;
            } else if (c1.op === 'is_not' && c2.op === 'is') {
                if (c1.value !== c2.value)
                    return true;
            } else if (c1.op === 'is_not' && c2.op === 'is_not') {
                const paramDef = PARAMETERS[param];
                if (paramDef && paramDef.values) {
                    const forbidden = new Set([c1.value, c2.value]);
                    if (paramDef.values.every(v => forbidden.has(v)))
                        return false;
                }
                return true;
            // Numeric operator pairs
            } else if (c1.op === 'below' && c2.op === 'below') {
                return true; // Both match for values below min(X, Y)
            } else if (c1.op === 'above' && c2.op === 'above') {
                return true; // Both match for values above max(X, Y)
            } else if (c1.op === 'below' && c2.op === 'above') {
                // below X AND above Y: possible if X > Y
                return Number(c1.value) > Number(c2.value);
            } else if (c1.op === 'above' && c2.op === 'below') {
                // above X AND below Y: possible if Y > X
                return Number(c2.value) > Number(c1.value);
            } else {
                // Mixed binary/numeric on same param — shouldn't happen,
                // but assume coexistence (conservative)
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
        return {valid: false, error: _('Invalid condition object')};
    }

    const {param, op, value} = condition;

    if (!param || typeof param !== 'string') {
        return {valid: false, error: _('Missing or invalid parameter')};
    }

    if (!op || typeof op !== 'string') {
        return {valid: false, error: _('Missing or invalid operator')};
    }

    if (!OPERATORS[op]) {
        return {valid: false, error: _('Unknown operator: %s').format(op)};
    }

    if (value === undefined || value === null) {
        return {valid: false, error: _('Missing value')};
    }

    const paramDef = PARAMETERS[param];
    if (!paramDef) {
        return {valid: false, error: _('Unknown parameter: %s').format(param)};
    }

    // Validate operator compatibility with parameter type
    const paramType = paramDef.type || 'binary';
    const operator = OPERATORS[op];
    if (operator.type && operator.type !== paramType) {
        return {valid: false, error: _('Operator "%s" cannot be used with parameter "%s"').format(op, param)};
    }

    // Validate value based on parameter type
    if (paramType === 'numeric') {
        const numVal = Number(value);
        if (isNaN(numVal) || !Number.isInteger(numVal)) {
            return {valid: false, error: _('Value must be a whole number for "%s"').format(param)};
        }
        if (numVal < paramDef.range[0] || numVal > paramDef.range[1]) {
            return {valid: false, error: _('Value must be between %d and %d for "%s"').format(
                paramDef.range[0], paramDef.range[1], param)};
        }
    } else {
        if (!paramDef.values.includes(value)) {
            return {valid: false, error: _('Invalid value "%s" for parameter "%s"').format(value, param)};
        }
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
        return {valid: false, errors: [_('Rules must be an array')]};
    }

    const errors = [];
    const seenParams = new Set();

    for (let i = 0; i < rules.length; i++) {
        const result = validateCondition(rules[i]);
        if (!result.valid) {
            errors.push(_('Condition %d: %s').format(i + 1, result.error));
        } else {
            // Check for duplicate parameters with same operator
            const key = `${rules[i].param}:${rules[i].op}`;
            if (seenParams.has(key)) {
                errors.push(_('Condition %d: Duplicate condition for %s').format(i + 1, rules[i].param));
            }
            seenParams.add(key);
        }
    }

    // Check for contradictions: same param with 'is' and 'is_not' targeting the same value
    if (errors.length === 0) {
        const paramConstraints = {};
        for (const rule of rules) {
            if (!paramConstraints[rule.param])
                paramConstraints[rule.param] = [];
            paramConstraints[rule.param].push({op: rule.op, value: rule.value});
        }

        for (const [param, constraints] of Object.entries(paramConstraints)) {
            const isValues = constraints.filter(c => c.op === 'is').map(c => c.value);
            const isNotValues = constraints.filter(c => c.op === 'is_not').map(c => c.value);

            for (const v of isValues) {
                if (isNotValues.includes(v)) {
                    errors.push(_('Contradictory conditions for %s: "is %s" and "is not %s" can never both be true').format(param, v, v));
                }
            }
        }
    }

    return {valid: errors.length === 0, errors};
}

