/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

export const SYSFS_POWER_SUPPLY_PATH = '/sys/class/power_supply';
export const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
export const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';
export const UPOWER_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

export const THRESHOLD_END_FILE = 'charge_control_end_threshold';
export const THRESHOLD_START_FILE = 'charge_control_start_threshold';
export const CAPACITY_FILE = 'capacity';
export const STATUS_FILE = 'status';
export const BEHAVIOUR_FILE = 'charge_behaviour';

export const ENERGY_FULL_DESIGN_FILE = 'energy_full_design';
export const ENERGY_FULL_FILE = 'energy_full';
export const CHARGE_FULL_DESIGN_FILE = 'charge_full_design';
export const CHARGE_FULL_FILE = 'charge_full';

export const HELPER_BIN_NAME = 'unified-power-ctl';
