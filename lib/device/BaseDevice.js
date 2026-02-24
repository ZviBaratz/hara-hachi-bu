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
         * @returns {Promise<boolean>} true if device is supported and ready
         */
        initialize() {
            return false;
        }

        /**
         * Check if this device implementation is applicable to the current hardware
         * @returns {boolean}
         */
        static isSupported() {
            return false;
        }

        /**
         * Get current battery thresholds
         * @returns {Object} { start: number, end: number }
         */
        getThresholds() {
            return {start: -1, end: -1};
        }

        /**
         * Set battery thresholds
         * @param {number} start
         * @param {number} end
         * @returns {Promise<boolean>}
         */
        setThresholds(_start, _end) {
            throw new Error('Not implemented');
        }

        /**
         * Check if force discharge is supported
         * @returns {boolean}
         */
        get supportsForceDischarge() {
            return false;
        }

        /**
         * Get force discharge state
         * @returns {boolean}
         */
        getForceDischarge() {
            return false;
        }

        /**
         * Set force discharge state
         * @param {boolean} enabled
         * @returns {Promise<boolean>}
         */
        setForceDischarge(_enabled) {
            throw new Error('Not implemented');
        }

        /**
         * Check if the device supports a start threshold in addition to end threshold
         * @returns {boolean}
         */
        get hasStartThreshold() {
            return false;
        }

        /**
         * Check if the device requires a missing helper tool
         * @returns {boolean}
         */
        get needsHelper() {
            return false;
        }

        /**
         * Get current battery level from hardware (sysfs)
         * @returns {number}
         */
        getBatteryLevel() {
            return 0;
        }

        /**
         * Refresh cached values from hardware
         * @returns {Promise<void>}
         */
        async refreshValues() {}

        /**
         * Clean up resources
         */
        destroy() {}
    }
);
