/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ScheduleUtils provides pure utility functions for time-based profile scheduling.
 * Importable from both extension (GNOME Shell) and prefs (GTK4) contexts.
 */
'use strict';

import GLib from 'gi://GLib';
import {DAYS_SHORT} from './constants.js';

// Dual-context i18n: works in both GNOME Shell (global _()) and prefs (ExtensionPreferences.gettext)
const _ = s => GLib.dgettext('hara-hachi-bu', s);

/**
 * Parse a "HH:MM" time string into hours and minutes.
 *
 * @param {string} timeStr - Time in "HH:MM" 24-hour format
 * @returns {{hours: number, minutes: number}|null} - Parsed time or null if invalid
 */
export function parseTime(timeStr) {
    if (typeof timeStr !== 'string')
        return null;

    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!match)
        return null;

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59)
        return null;

    return {hours, minutes};
}

/**
 * Convert a {hours, minutes} object to total minutes since midnight.
 *
 * @param {{hours: number, minutes: number}} time
 * @returns {number} - Minutes since midnight (0-1439)
 */
export function timeToMinutes({hours, minutes}) {
    return hours * 60 + minutes;
}

/**
 * Format hours and minutes as a zero-padded "HH:MM" string.
 *
 * @param {number} hours
 * @param {number} minutes
 * @returns {string} - e.g. "05:30"
 */
export function formatTimeHHMM(hours, minutes) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Convert JS Date.getDay() (0=Sun) to ISO weekday (1=Mon..7=Sun).
 * @private
 */
function _jsToIsoDay(jsDay) {
    return jsDay === 0 ? 7 : jsDay;
}

/**
 * Check if a schedule is currently active.
 * Handles overnight schedules (start > end) by checking yesterday's day-of-week
 * for the after-midnight portion.
 *
 * NOTE: Schedule math assumes 1440 minutes/day and uses wall-clock time from
 * Date(). During DST transitions a day may be 1380 or 1500 minutes long.
 * This can cause a schedule boundary to fire up to 1 hour early or late.
 * The 1-hour cap on the schedule timer in StateManager._rescheduleTimer()
 * ensures self-correction within that window.
 *
 * @param {Object} schedule - Schedule object with enabled, days, startTime, endTime
 * @param {Date} [now] - Override current time for testing
 * @returns {boolean} - True if schedule is currently active
 */
export function isScheduleActive(schedule, now = null) {
    if (!schedule || !schedule.enabled)
        return false;

    if (!now)
        now = new Date();

    const currentIsoDay = _jsToIsoDay(now.getDay());
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const start = parseTime(schedule.startTime);
    const end = parseTime(schedule.endTime);
    if (!start || !end)
        return false;

    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);

    if (startMin < endMin) {
        // Same-day schedule: e.g. 05:30-08:00
        return schedule.days.includes(currentIsoDay) &&
               currentMinutes >= startMin && currentMinutes < endMin;
    } else {
        // Overnight schedule: e.g. 23:00-07:00
        // Split into two intervals:
        //   1. startTime..midnight on the start day
        //   2. midnight..endTime on the next day (check yesterday's day)
        if (currentMinutes >= startMin) {
            // We're in the evening portion — check today's day
            return schedule.days.includes(currentIsoDay);
        } else if (currentMinutes < endMin) {
            // We're in the morning (after-midnight) portion — check yesterday's day
            const yesterdayIsoDay = currentIsoDay === 1 ? 7 : currentIsoDay - 1;
            return schedule.days.includes(yesterdayIsoDay);
        }
        return false;
    }
}

/**
 * Get the end time of the currently active schedule window as "HH:MM".
 * Returns null if the schedule is not currently active.
 *
 * @param {Object} schedule - Schedule object
 * @param {Date} [now] - Override current time for testing
 * @returns {string|null} - "HH:MM" or null
 */
export function getScheduleEndTimeToday(schedule, now = null) {
    if (!isScheduleActive(schedule, now))
        return null;

    const end = parseTime(schedule.endTime);
    if (!end)
        return null;

    return formatTimeHHMM(end.hours, end.minutes);
}

/**
 * Calculate seconds until the nearest schedule boundary (start or end).
 * Scans up to 7 days forward.
 *
 * Uses 1440 min/day arithmetic, which is inexact during DST transitions
 * (±60 min). The caller (StateManager._rescheduleTimer) caps the delay
 * at 3600s, so the timer self-corrects within one hour regardless.
 *
 * @param {Object} schedule - Schedule object
 * @param {Date} [now] - Override current time for testing
 * @returns {number} - Seconds until next boundary, or Infinity if no valid boundary
 */
export function secondsUntilNextBoundary(schedule, now = null) {
    if (!schedule || !schedule.enabled)
        return Infinity;

    if (!now)
        now = new Date();

    const start = parseTime(schedule.startTime);
    const end = parseTime(schedule.endTime);
    if (!start || !end || !schedule.days || schedule.days.length === 0)
        return Infinity;

    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const currentSeconds = now.getSeconds();

    let best = Infinity;

    // Scan 8 days (today + 7 forward) to guarantee finding next boundary
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const futureDate = new Date(now);
        futureDate.setDate(futureDate.getDate() + dayOffset);
        const isoDay = _jsToIsoDay(futureDate.getDay());

        if (!schedule.days.includes(isoDay))
            continue;

        // Check start boundary on this day
        const startDiffMin = (dayOffset === 0)
            ? startMin - currentMinutes
            : startMin + dayOffset * 1440 - currentMinutes;

        if (startDiffMin > 0) {
            const startDiffSec = startDiffMin * 60 - currentSeconds;
            if (startDiffSec > 0 && startDiffSec < best)
                best = startDiffSec;
        }

        // Check end boundary on this day
        if (startMin < endMin) {
            // Same-day: end is on the same day
            const endDiffMin = (dayOffset === 0)
                ? endMin - currentMinutes
                : endMin + dayOffset * 1440 - currentMinutes;

            if (endDiffMin > 0) {
                const endDiffSec = endDiffMin * 60 - currentSeconds;
                if (endDiffSec > 0 && endDiffSec < best)
                    best = endDiffSec;
            }
        } else {
            // Overnight: end is on the NEXT day
            const endDiffMin = (dayOffset === 0)
                ? endMin + 1440 - currentMinutes
                : endMin + (dayOffset + 1) * 1440 - currentMinutes;

            if (endDiffMin > 0) {
                const endDiffSec = endDiffMin * 60 - currentSeconds;
                if (endDiffSec > 0 && endDiffSec < best)
                    best = endDiffSec;
            }
        }
    }

    // For overnight schedules, check if yesterday's schedule ends today.
    // The main loop only places end boundaries on the day AFTER each scheduled day,
    // but never looks backward to find today's end from yesterday's overnight start.
    if (startMin >= endMin) {
        const yesterdayDate = new Date(now.getTime() - 86400000);
        const yesterdayIsoDay = _jsToIsoDay(yesterdayDate.getDay());
        if (schedule.days.includes(yesterdayIsoDay)) {
            const endDiffMin = endMin - currentMinutes;
            if (endDiffMin > 0) {
                const endDiffSec = endDiffMin * 60 - currentSeconds;
                if (endDiffSec > 0 && endDiffSec < best)
                    best = endDiffSec;
            }
        }
    }

    return best;
}

/**
 * Check if two schedules have overlapping active windows.
 * Handles overnight schedules by splitting them into two same-day intervals.
 *
 * @param {Object} schedule1 - First schedule object
 * @param {Object} schedule2 - Second schedule object
 * @returns {boolean} - True if schedules overlap
 */
export function schedulesOverlap(schedule1, schedule2) {
    if (!schedule1?.enabled || !schedule2?.enabled)
        return false;

    // Check day intersection
    const days1 = new Set(schedule1.days);
    const commonDays = schedule2.days.filter(d => days1.has(d));

    const start1 = parseTime(schedule1.startTime);
    const end1 = parseTime(schedule1.endTime);
    const start2 = parseTime(schedule2.startTime);
    const end2 = parseTime(schedule2.endTime);
    if (!start1 || !end1 || !start2 || !end2)
        return false;

    const s1Min = timeToMinutes(start1);
    const e1Min = timeToMinutes(end1);
    const s2Min = timeToMinutes(start2);
    const e2Min = timeToMinutes(end2);

    // Build same-day intervals [start, end) for each schedule.
    // Overnight schedules (start >= end) produce two intervals:
    //   [start, 1440) and [0, end)
    const intervals1 = _buildIntervals(s1Min, e1Min);
    const intervals2 = _buildIntervals(s2Min, e2Min);

    // For same-day intervals, check direct day overlap
    if (commonDays.length > 0) {
        if (_intervalsOverlap(intervals1, intervals2))
            return true;
    }

    // For overnight schedules, also check cross-day overlap:
    // Schedule1's evening portion on day D overlaps with schedule2's morning on day D+1
    // and vice versa.
    const isOvernight1 = s1Min >= e1Min;
    const isOvernight2 = s2Min >= e2Min;

    if (isOvernight1) {
        // Schedule1's [0, e1) morning portion lands on the day AFTER each scheduled day.
        // Compare against schedule2's intervals that are actually on that same day.
        for (const day of schedule1.days) {
            const nextDay = day === 7 ? 1 : day + 1;
            if (schedule2.days.includes(nextDay)) {
                // Schedule2 starts on nextDay: use only its evening/same-day portion,
                // NOT its morning (which belongs to the day after nextDay)
                const s2OnNextDay = isOvernight2
                    ? [[s2Min, 1440]]
                    : intervals2;
                if (_intervalsOverlap([[0, e1Min]], s2OnNextDay))
                    return true;
            }
        }
    }

    if (isOvernight2) {
        // Schedule2's [0, e2) morning portion lands on the day AFTER each scheduled day.
        for (const day of schedule2.days) {
            const nextDay = day === 7 ? 1 : day + 1;
            if (schedule1.days.includes(nextDay)) {
                const s1OnNextDay = isOvernight1
                    ? [[s1Min, 1440]]
                    : intervals1;
                if (_intervalsOverlap(s1OnNextDay, [[0, e2Min]]))
                    return true;
            }
        }
    }

    return false;
}

/**
 * Build same-day intervals from start/end minutes.
 * @private
 */
function _buildIntervals(startMin, endMin) {
    if (startMin < endMin) {
        return [[startMin, endMin]];
    } else {
        // Overnight: [start, 1440) and [0, end)
        return [[startMin, 1440], [0, endMin]];
    }
}

/**
 * Check if any interval in set A overlaps with any interval in set B.
 * Intervals are [start, end) — half-open.
 * @private
 */
function _intervalsOverlap(setA, setB) {
    for (const [a0, a1] of setA) {
        for (const [b0, b1] of setB) {
            if (a0 < b1 && b0 < a1)
                return true;
        }
    }
    return false;
}

/**
 * Validate a schedule object for structural correctness.
 *
 * @param {Object} schedule - Schedule object to validate
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object')
        return {valid: false, error: _('Invalid schedule object')};

    if (typeof schedule.enabled !== 'boolean')
        return {valid: false, error: _('Schedule must have an enabled flag')};

    if (!Array.isArray(schedule.days) || schedule.days.length === 0)
        return {valid: false, error: _('Schedule must have at least one day')};

    for (const day of schedule.days) {
        if (!Number.isInteger(day) || day < 1 || day > 7)
            return {valid: false, error: _('Invalid day: must be 1 (Monday) through 7 (Sunday)')};
    }

    // Check for duplicate days
    if (new Set(schedule.days).size !== schedule.days.length)
        return {valid: false, error: _('Duplicate days in schedule')};

    if (typeof schedule.startTime !== 'string')
        return {valid: false, error: _('Start time is required')};

    if (typeof schedule.endTime !== 'string')
        return {valid: false, error: _('End time is required')};

    const start = parseTime(schedule.startTime);
    if (!start)
        return {valid: false, error: _('Invalid start time format (expected HH:MM)')};

    const end = parseTime(schedule.endTime);
    if (!end)
        return {valid: false, error: _('Invalid end time format (expected HH:MM)')};

    if (start.hours === end.hours && start.minutes === end.minutes)
        return {valid: false, error: _('Start and end time must be different')};

    return {valid: true, error: null};
}

/**
 * Format an array of ISO weekday numbers into a human-readable summary.
 * Smart labeling: [1-5] → "Weekdays", [6,7] → "Weekends", [1-7] → "Daily",
 * otherwise abbreviated day names.
 *
 * @param {number[]} days - ISO weekday numbers (1=Mon..7=Sun)
 * @returns {string} - Human-readable summary
 */
export function formatDaysSummary(days) {
    if (!days || days.length === 0)
        return '';

    const sorted = [...days].sort((a, b) => a - b);

    // Check common patterns
    const key = sorted.join(',');
    if (key === '1,2,3,4,5')
        return _('Weekdays');
    if (key === '6,7')
        return _('Weekends');
    if (key === '1,2,3,4,5,6,7')
        return _('Daily');

    // Fall back to abbreviated names
    return sorted.map(d => _(DAYS_SHORT[d])).join(', ');
}
