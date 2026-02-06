/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GObject from 'gi://GObject';
import { BaseDevice } from './BaseDevice.js';

export const MockDevice = GObject.registerClass({
    GTypeName: 'UPMMockDevice',
}, class MockDevice extends BaseDevice {
    constructor() {
        super();
        this.name = 'MockDevice';
        this.startLimitValue = 60;
        this.endLimitValue = 80;
        this._forceDischargeEnabled = false;
        this._batteryLevel = 50;
        this._health = 98;
        this._onBattery = false;
    }

    async initialize() {
        console.log('Unified Power Manager: Initializing Mock Device');
        return true;
    }

    static isSupported() {
        // By default false, unless we are in a special debug mode which we can't easily detect here
        // The DeviceManager will handle when to use this.
        return false;
    }

    getThresholds() {
        return {
            start: this.startLimitValue,
            end: this.endLimitValue
        };
    }

    get hasStartThreshold() {
        return true;
    }

    get supportsForceDischarge() {
        return true;
    }

    get health() {
        return this._health;
    }

    get onBattery() {
        return this._onBattery;
    }

    getHealth() {
        return this._health;
    }

    async setThresholds(start, end) {
        console.log(`MockDevice: Setting thresholds to ${start}-${end}`);
        if (start < 0 || end > 100 || start >= end) {
             console.log('MockDevice: Invalid thresholds');
             return false;
        }
        
        this.startLimitValue = start;
        this.endLimitValue = end;
        this.emit('threshold-changed', start, end);
        return true;
    }

    getForceDischarge() {
        return this._forceDischargeEnabled;
    }

    async setForceDischarge(enabled) {
        console.log(`MockDevice: Setting force discharge to ${enabled}`);
        this._forceDischargeEnabled = enabled;
        this.emit('force-discharge-changed', enabled);
        return true;
    }

    getBatteryLevel() {
        return this._batteryLevel;
    }

    // Test helper to simulate external changes
    simulateExternalChange(start, end) {
        this.startLimitValue = start;
        this.endLimitValue = end;
        this.emit('threshold-changed', start, end);
    }

    simulatePowerSourceChange(onBattery) {
        this._onBattery = onBattery;
        // In real life, BatteryThresholdController emits this signal when UPower proxy detects change
        // MockDevice doesn't have the proxy, so we emit it directly if the controller uses it.
        // Actually, BatteryThresholdController listens to UPower, not the device for this.
        // So Mocking this on Device doesn't help much unless the controller is also mocked.
    }
});
