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

        initialize() {
            return false;
        }

        static isSupported() {
            return false;
        }

        getThresholds() {
            return {start: -1, end: -1};
        }

        setThresholds(_start, _end) {
            throw new Error('Not implemented');
        }

        get supportsForceDischarge() {
            return false;
        }

        getForceDischarge() {
            return false;
        }

        setForceDischarge(_enabled) {
            throw new Error('Not implemented');
        }

        get hasStartThreshold() {
            return false;
        }

        get needsHelper() {
            return false;
        }

        getBatteryLevel() {
            return 0;
        }

        async refreshValues() {}
    }
);
