/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

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
export const HELPER_BIN_NAME = 'unified-power-ctl';

// Battery Modes
export const BATTERY_MODES = {
    'full-capacity': {
        label: 'Full Capacity',
        description: '95-100%',
        defaultStart: 95,
        defaultEnd: 100,
        startKey: 'threshold-full-start',
        endKey: 'threshold-full-end',
    },
    'balanced': {
        label: 'Balanced',
        description: '75-80%',
        defaultStart: 75,
        defaultEnd: 80,
        startKey: 'threshold-balanced-start',
        endKey: 'threshold-balanced-end',
    },
    'max-lifespan': {
        label: 'Max Lifespan',
        description: '55-60%',
        defaultStart: 55,
        defaultEnd: 60,
        startKey: 'threshold-lifespan-start',
        endKey: 'threshold-lifespan-end',
    },
};

// Power Modes
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

// Force Discharge Options
export const FORCE_DISCHARGE_OPTIONS = {
    on: {label: 'On', value: 'on'},
    off: {label: 'Off', value: 'off'},
    unspecified: {label: 'Unspecified', value: 'unspecified'},
};

// Rule Parameters
export const PARAMETERS = {
    external_display: {
        name: 'external_display',
        label: 'External Display',
        values: ['connected', 'not_connected'],
        valueLabels: {
            connected: 'Connected',
            not_connected: 'Not Connected',
        },
    },
    power_source: {
        name: 'power_source',
        label: 'Power Source',
        values: ['ac', 'battery'],
        valueLabels: {
            ac: 'AC Power',
            battery: 'Battery',
        },
    },
    lid_state: {
        name: 'lid_state',
        label: 'Lid State',
        values: ['open', 'closed'],
        valueLabels: {
            open: 'Open',
            closed: 'Closed',
        },
    },
};

// Rule Operators
export const OPERATORS = {
    is: {
        name: 'is',
        label: 'is',
        evaluate: (actual, expected) => actual === expected,
    },
    is_not: {
        name: 'is_not',
        label: 'is not',
        evaluate: (actual, expected) => actual !== expected,
    },
};

// Default Profiles
export const DEFAULT_PROFILES = {
    docked: {
        id: 'docked',
        name: 'Docked',
        powerMode: 'performance',
        batteryMode: 'max-lifespan',
        forceDischarge: 'on',
        rules: [{param: 'external_display', op: 'is', value: 'connected'}],
        icon: 'upm-docked-symbolic',
        builtin: true,
        autoManaged: true,
    },
    travel: {
        id: 'travel',
        name: 'Travel',
        powerMode: 'balanced',
        batteryMode: 'full-capacity',
        forceDischarge: 'off',
        rules: [{param: 'power_source', op: 'is', value: 'battery'}],
        icon: 'upm-travel-symbolic',
        builtin: true,
        autoManaged: true,
    },
};
