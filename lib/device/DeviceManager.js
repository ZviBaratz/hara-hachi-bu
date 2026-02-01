/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ThinkPad } from './ThinkPad.js';
import { MockDevice } from './MockDevice.js';

export class DeviceManager {
    static async getDevice() {
        // Check for mock trigger for testing
        const configDir = GLib.get_user_config_dir();
        const mockTrigger = Gio.File.new_for_path(`${configDir}/unified-power-manager/use_mock`);
        
        if (mockTrigger.query_exists(null)) {
            console.log('Unified Power Manager: Mock device requested via config');
            const device = new MockDevice();
            if (await device.initialize()) {
                return device;
            }
        }

        // Try ThinkPad
        if (ThinkPad.isSupported()) {
            console.log('Unified Power Manager: Detected ThinkPad hardware');
            const device = new ThinkPad();
            if (await device.initialize()) {
                return device;
            }
        }

        // Future: Add GenericDevice here

        console.log('Unified Power Manager: No supported battery control device found');
        return null;
    }
}
