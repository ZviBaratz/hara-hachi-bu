/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GObject from 'gi://GObject';
import { BaseDevice } from './BaseDevice.js';

/**
 * CompositeDevice manages multiple battery devices as a single unit.
 * It forwards configuration commands to all sub-devices and aggregates state.
 */
export const CompositeDevice = GObject.registerClass({
    GTypeName: 'UPMCompositeDevice',
}, class CompositeDevice extends BaseDevice {
    /**
     * @param {BaseDevice[]} devices - Array of initialized battery devices
     */
    constructor(devices = []) {
        super();
        this._devices = devices;
        this.name = `Composite Device (${devices.length} batteries)`;
        
        // Connect to signals from all sub-devices
        this._devices.forEach((device, index) => {
            device.connectObject(
                'threshold-changed', (dev, start, end) => {
                    // Forward threshold changes from sub-devices
                    // Only emit signals from the primary device (BAT0) because all batteries
                    // are synchronized to the same threshold values by design. Emitting from
                    // all devices would cause duplicate UI updates and rule evaluations.
                    // This assumes setThresholds() successfully applies to all batteries.
                    if (index === 0) {
                        this.emit('threshold-changed', start, end);
                    }
                },
                'force-discharge-changed', (dev, enabled) => {
                    // Same reasoning as threshold-changed: only emit from primary device
                    if (index === 0) {
                        this.emit('force-discharge-changed', enabled);
                    }
                },
                this
            );
        });
    }

    async initialize() {
        // Sub-devices are assumed to be initialized before passed to constructor
        return this._devices.length > 0;
    }

    getThresholds() {
        if (this._devices.length === 0) return { start: -1, end: -1 };
        // Return thresholds from the first device as the authoritative state
        return this._devices[0].getThresholds();
    }

    async setThresholds(start, end) {
        if (this._devices.length === 0) return false;

        // Apply to all devices in parallel
        const results = await Promise.all(this._devices.map(d => d.setThresholds(start, end)));
        
        // Return true only if all succeeded
        return results.every(res => res === true);
    }

    get supportsForceDischarge() {
        // Supported if at least one sub-device supports it
        return this._devices.some(d => d.supportsForceDischarge);
    }

    getForceDischarge() {
        if (this._devices.length === 0) return false;
        // Return state of the first device that supports it
        const dev = this._devices.find(d => d.supportsForceDischarge);
        return dev ? dev.getForceDischarge() : false;
    }

    async setForceDischarge(enabled) {
        const targetDevices = this._devices.filter(d => d.supportsForceDischarge);
        if (targetDevices.length === 0) return false;

        const results = await Promise.all(targetDevices.map(d => d.setForceDischarge(enabled)));
        return results.every(res => res === true);
    }

    get needsHelper() {
        // If any device that we need to control needs a helper, we report it
        return this._devices.some(d => d.needsHelper);
    }

    getBatteryLevel() {
        if (this._devices.length === 0) return 0;
        
        // Weighted average by capacity would be ideal, but simple average is a start
        // Actually, UPower provides the aggregate system level which is better.
        // We implement this for completeness.
        const levels = this._devices.map(d => d.getBatteryLevel());
        return Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
    }

    getHealth() {
        if (this._devices.length === 0) return null;

        const healths = this._devices.map(d => d.getHealth()).filter(h => h !== null);
        if (healths.length === 0) return null;

        return Math.round(healths.reduce((a, b) => a + b, 0) / healths.length);
    }

    async refreshValues() {
        await Promise.all(this._devices.map(d => d.refreshValues()));
    }

    destroy() {
        this._devices.forEach(d => {
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
});
