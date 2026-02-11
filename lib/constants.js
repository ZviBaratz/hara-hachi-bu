/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

// No-op marker for xgettext extraction. Strings are translated at display time via _().
const N_ = s => s;

// System Paths
export const SYSFS_POWER_SUPPLY_PATH = '/sys/class/power_supply';
export const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
export const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';
export const UPOWER_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

// Sysfs Files
export const THRESHOLD_END_FILE = 'charge_control_end_threshold';
export const THRESHOLD_START_FILE = 'charge_control_start_threshold';
export const THRESHOLD_END_FILES = ['charge_control_end_threshold', 'stop_charge_thresh'];
export const THRESHOLD_START_FILES = ['charge_control_start_threshold', 'start_charge_thresh'];
export const CAPACITY_FILE = 'capacity';
export const STATUS_FILE = 'status';
export const BEHAVIOUR_FILE = 'charge_behaviour';

// Battery Health Files
export const ENERGY_FULL_DESIGN_FILE = 'energy_full_design';
export const ENERGY_FULL_FILE = 'energy_full';
export const CHARGE_FULL_DESIGN_FILE = 'charge_full_design';
export const CHARGE_FULL_FILE = 'charge_full';

// Executables
export const HELPER_BIN_NAME = 'hhb-power-ctl';

// Battery Modes
export const BATTERY_MODES = {
    'full-capacity': {
        label: N_('Full Capacity'),
        description: N_('Full runtime — charge fully'),
        defaultStart: 95,
        defaultEnd: 100,
        startKey: 'threshold-full-start',
        endKey: 'threshold-full-end',
    },
    'balanced': {
        label: N_('Moderate'),
        description: N_('Balance runtime and battery longevity'),
        defaultStart: 75,
        defaultEnd: 80,
        startKey: 'threshold-balanced-start',
        endKey: 'threshold-balanced-end',
    },
    'max-lifespan': {
        label: N_('Max Lifespan'),
        description: N_('Extend battery life — best for desk use'),
        defaultStart: 55,
        defaultEnd: 60,
        startKey: 'threshold-lifespan-start',
        endKey: 'threshold-lifespan-end',
    },
};

// Power Modes
export const POWER_MODES = {
    'performance': {
        label: N_('Performance'),
        icon: 'power-profile-performance-symbolic',
    },
    'balanced': {
        label: N_('Balanced'),
        icon: 'power-profile-balanced-symbolic',
    },
    'power-saver': {
        label: N_('Power Saver'),
        icon: 'power-profile-power-saver-symbolic',
    },
};

// Force Discharge Options
export const FORCE_DISCHARGE_OPTIONS = {
    on: {label: N_('On'), value: 'on'},
    off: {label: N_('Off'), value: 'off'},
    unspecified: {label: N_('Don\'t change'), value: 'unspecified'},
};

// Rule Parameters
export const PARAMETERS = {
    external_display: {
        name: 'external_display',
        label: N_('External Display'),
        values: ['connected', 'not_connected'],
        valueLabels: {
            connected: N_('Connected'),
            not_connected: N_('Not Connected'),
        },
    },
    power_source: {
        name: 'power_source',
        label: N_('Power Source'),
        values: ['ac', 'battery'],
        valueLabels: {
            ac: N_('AC Power'),
            battery: N_('Battery'),
        },
    },
    lid_state: {
        name: 'lid_state',
        label: N_('Lid State'),
        values: ['open', 'closed'],
        valueLabels: {
            open: N_('Open'),
            closed: N_('Closed'),
        },
    },
};

// Rule Operators
export const OPERATORS = {
    is: {
        name: 'is',
        label: N_('is'),
        evaluate: (actual, expected) => actual === expected,
    },
    is_not: {
        name: 'is_not',
        label: N_('is not'),
        evaluate: (actual, expected) => actual !== expected,
    },
};

// Days of Week (ISO: 1=Monday, 7=Sunday)
export const DAYS_OF_WEEK = {
    1: N_('Monday'),
    2: N_('Tuesday'),
    3: N_('Wednesday'),
    4: N_('Thursday'),
    5: N_('Friday'),
    6: N_('Saturday'),
    7: N_('Sunday'),
};

export const DAYS_SHORT = {
    1: N_('Mon'),
    2: N_('Tue'),
    3: N_('Wed'),
    4: N_('Thu'),
    5: N_('Fri'),
    6: N_('Sat'),
    7: N_('Sun'),
};

// Boost Charge
export const BOOST_CHARGE_DEFAULT_TIMEOUT_HOURS = 4;

// Default Profiles
export const DEFAULT_PROFILES = {
    docked: {
        id: 'docked',
        name: N_('Docked'),
        powerMode: 'performance',
        batteryMode: 'max-lifespan',
        forceDischarge: 'on',
        rules: [
            {param: 'external_display', op: 'is', value: 'connected'},
            {param: 'power_source', op: 'is', value: 'ac'},
        ],
        icon: 'hhb-docked-symbolic',
        builtin: true,
        autoManaged: true,
        schedule: null,
    },
    travel: {
        id: 'travel',
        name: N_('Travel'),
        powerMode: 'balanced',
        batteryMode: 'full-capacity',
        forceDischarge: 'off',
        rules: [{param: 'power_source', op: 'is', value: 'battery'}],
        icon: 'hhb-travel-symbolic',
        builtin: true,
        autoManaged: true,
        schedule: null,
    },
};
