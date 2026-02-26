/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GObject from 'gi://GObject';

export const BaseDevice = GObject.registerClass(
    {
        GTypeName: 'HhbBaseDevice',
        Signals: {
            'threshold-changed': {param_types: [GObject.TYPE_INT, GObject.TYPE_INT]},
            'force-discharge-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        },
    },
    class BaseDevice extends GObject.Object {
        constructor() {
            super();
            this.name = 'BaseDevice';
        }

        /**
         * Initialize the device (check paths, vendors, etc.)
         */
        initialize() {
            return false;
        }

        /**
         * Check if this device implementation is applicable to the current hardware
         */
        static isSupported() {
            return false;
        }

        /**
         * Get current battery thresholds
         */
        getThresholds() {
            return {start: -1, end: -1};
        }

        /**
         * Set battery thresholds
         */
        setThresholds(_start, _end) {
            throw new Error('Not implemented');
        }

        /**
         * Check if force discharge is supported
         */
        get supportsForceDischarge() {
            return false;
        }

        /**
         * Get force discharge state
         */
        getForceDischarge() {
            return false;
        }

        /**
         * Set force discharge state
         */
        setForceDischarge(_enabled) {
            throw new Error('Not implemented');
        }

        /**
         * Check if the device supports a start threshold in addition to end threshold
         */
        get hasStartThreshold() {
            return false;
        }

        /**
         * Check if the device requires a missing helper tool
         */
        get needsHelper() {
            return false;
        }

        /**
         * Get current battery level from hardware (sysfs)
         */
        getBatteryLevel() {
            return 0;
        }

        /**
         * Refresh cached values from hardware
         */
        async refreshValues() {}

        /**
         * Clean up resources
         */
        destroy() {}
    }
);
