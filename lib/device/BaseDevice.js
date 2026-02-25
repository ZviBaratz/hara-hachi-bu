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
         * @returns true if device is supported and ready
         */
        initialize() {
            return false;
        }

        /**
         * Check if this device implementation is applicable to the current hardware
         * @returns
         */
        static isSupported() {
            return false;
        }

        /**
         * Get current battery thresholds
         * @returns
         */
        getThresholds() {
            return {start: -1, end: -1};
        }

        /**
         * Set battery thresholds
         * @param start
         * @param end
         * @returns
         */
        setThresholds(_start, _end) {
            throw new Error('Not implemented');
        }

        /**
         * Check if force discharge is supported
         * @returns
         */
        get supportsForceDischarge() {
            return false;
        }

        /**
         * Get force discharge state
         * @returns
         */
        getForceDischarge() {
            return false;
        }

        /**
         * Set force discharge state
         * @param enabled
         * @returns
         */
        setForceDischarge(_enabled) {
            throw new Error('Not implemented');
        }

        /**
         * Check if the device supports a start threshold in addition to end threshold
         * @returns
         */
        get hasStartThreshold() {
            return false;
        }

        /**
         * Check if the device requires a missing helper tool
         * @returns
         */
        get needsHelper() {
            return false;
        }

        /**
         * Get current battery level from hardware (sysfs)
         * @returns
         */
        getBatteryLevel() {
            return 0;
        }

        /**
         * Refresh cached values from hardware
         * @returns
         */
        async refreshValues() {}

        /**
         * Clean up resources
         */
        destroy() {}
    }
);
