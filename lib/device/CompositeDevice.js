/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GObject from 'gi://GObject';
import {BaseDevice} from './BaseDevice.js';

/**
 * CompositeDevice manages multiple battery devices as a single unit.
 * It forwards configuration commands to all sub-devices and aggregates state.
 */
export const CompositeDevice = GObject.registerClass(
    {
        GTypeName: 'HhbCompositeDevice',
        Signals: {
            'partial-failure': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        },
    },
    class CompositeDevice extends BaseDevice {
        /**
         * @param {BaseDevice[]} devices - Array of initialized battery devices
         */
        constructor(devices = []) {
            super();
            this._devices = devices;
            this._destroyed = false;
            this.name = `Composite Device (${devices.length} batteries)`;

            // Connect to signals from all sub-devices.
            // Devices are sorted numerically (BAT0, BAT1, ...) by DeviceManager.
            // Only emit from primary device (index 0) to avoid duplicate signals.
            this._devices.forEach((device, index) => {
                device.connectObject(
                    'threshold-changed',
                    (dev, start, end) => {
                        // Forward threshold changes from sub-devices
                        // Only emit signals from the primary device (BAT0) because all batteries
                        // are synchronized to the same threshold values by design. Emitting from
                        // all devices would cause duplicate UI updates and rule evaluations.
                        // This assumes setThresholds() successfully applies to all batteries.
                        if (index === 0) this.emit('threshold-changed', start, end);
                    },
                    'force-discharge-changed',
                    (dev, enabled) => {
                        // Emit from the first device that supports force discharge.
                        // Unlike thresholds (which are synchronized across all batteries),
                        // force discharge may only be supported by some devices, so we
                        // can't unconditionally use index 0.
                        const isFirstSupported =
                            dev.supportsForceDischarge &&
                            !this._devices.slice(0, index).some((d) => d.supportsForceDischarge);
                        if (isFirstSupported) this.emit('force-discharge-changed', enabled);
                    },
                    this
                );
            });
        }

        initialize() {
            // Sub-devices are assumed to be initialized before passed to constructor
            return this._devices.length > 0;
        }

        getThresholds() {
            if (this._devices.length === 0) return {start: -1, end: -1};
            // Return thresholds from the first device as the authoritative state
            return this._devices[0].getThresholds();
        }

        async setThresholds(start, end) {
            if (this._destroyed || this._devices.length === 0) return false;

            // Apply to all devices in parallel; use allSettled so one failure doesn't mask others
            const settled = await Promise.allSettled(this._devices.map((d) => d.setThresholds(start, end)));
            const results = settled.map((r) => (r.status === 'fulfilled' ? r.value : false));
            if (this._destroyed) return false;

            // Primary battery (index 0) determines overall success
            const primarySuccess = results[0] === true;

            // Log and signal any secondary battery failures
            const failedSecondary = this._devices.filter((d, i) => i > 0 && results[i] !== true);
            if (failedSecondary.length > 0) {
                const failedNames = failedSecondary.map((d) => d.batteryName).join(', ');
                console.warn(
                    `Hara Hachi Bu: CompositeDevice setThresholds failed for secondary batteries: ${failedNames}`
                );
                this.emit('partial-failure', this._devices[0].batteryName, failedNames);
            }

            return primarySuccess;
        }

        get hasStartThreshold() {
            // Delegates to primary device
            return this._devices.length > 0 ? this._devices[0].hasStartThreshold : false;
        }

        get supportsForceDischarge() {
            // Supported if at least one sub-device supports it
            return this._devices.some((d) => d.supportsForceDischarge);
        }

        getForceDischarge() {
            if (this._devices.length === 0) return false;
            // Return state of the first device that supports it
            const dev = this._devices.find((d) => d.supportsForceDischarge);
            return dev ? dev.getForceDischarge() : false;
        }

        async setForceDischarge(enabled) {
            if (this._destroyed) return false;
            const targetDevices = this._devices.filter((d) => d.supportsForceDischarge);
            if (targetDevices.length === 0) return false;

            const settled = await Promise.allSettled(targetDevices.map((d) => d.setForceDischarge(enabled)));
            const results = settled.map((r) => (r.status === 'fulfilled' ? r.value : false));
            if (this._destroyed) return false;

            // First device with force discharge support determines overall success
            const primarySuccess = results[0] === true;

            const failedOthers = targetDevices.filter((d, i) => i > 0 && results[i] !== true);
            if (failedOthers.length > 0) {
                const failedNames = failedOthers.map((d) => d.batteryName).join(', ');
                console.warn(`Hara Hachi Bu: CompositeDevice setForceDischarge failed for: ${failedNames}`);
                this.emit('partial-failure', targetDevices[0].batteryName, failedNames);
            }

            return primarySuccess;
        }

        get needsHelper() {
            // If any device that we need to control needs a helper, we report it
            return this._devices.some((d) => d.needsHelper);
        }

        getBatteryLevel() {
            if (this._devices.length === 0) return 0;

            // Weighted average by capacity would be ideal, but simple average is a start
            // Actually, UPower provides the aggregate system level which is better.
            // We implement this for completeness.
            const levels = this._devices.map((d) => d.getBatteryLevel());
            return Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
        }

        getHealth() {
            if (this._devices.length === 0) return null;

            const healths = this._devices.map((d) => d.getHealth()).filter((h) => h !== null);
            if (healths.length === 0) return null;

            return Math.round(healths.reduce((a, b) => a + b, 0) / healths.length);
        }

        async refreshValues() {
            if (this._destroyed) return;
            const results = await Promise.allSettled(this._devices.map((d) => d.refreshValues()));
            for (let i = 0; i < results.length; i++) {
                if (results[i].status === 'rejected') {
                    console.error(
                        `Hara Hachi Bu: refreshValues failed for ${this._devices[i].batteryName}: ${results[i].reason}`
                    );
                }
            }
        }

        destroy() {
            this._destroyed = true;
            this._devices.forEach((d) => {
                d.disconnectObject(this);
                d.destroy();
            });
            this._devices = [];
        }

        /**
         * Get the name of the first battery (for backward compatibility with single-path logic)
         */
        get batteryName() {
            return this._devices.length > 0 ? this._devices[0].batteryName : 'BAT0';
        }
    }
);
