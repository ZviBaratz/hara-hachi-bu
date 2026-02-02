/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { GenericSysfsDevice } from './GenericSysfsDevice.js';
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

        // Try Generic Sysfs (Standard Linux Battery Class)
        // Iterate over all power supplies to find a supported battery
        try {
            const powerSupplyDir = Gio.File.new_for_path('/sys/class/power_supply');
            const enumerator = await powerSupplyDir.enumerate_children_async(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null
            );

            while (true) {
                const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
                if (!fileInfos || fileInfos.length === 0)
                    break;

                for (const info of fileInfos) {
                    const name = info.get_name();
                    const path = `/sys/class/power_supply/${name}`;
                    
                    if (GenericSysfsDevice.isSupported(path)) {
                        console.log(`Unified Power Manager: Detected standard sysfs battery control for ${name}`);
                        const device = new GenericSysfsDevice(path);
                        if (await device.initialize()) {
                            return device;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`Unified Power Manager: Error enumerating power supplies: ${e}. Falling back to default list.`);
            
            // Fallback to defaults
            const batteries = ['BAT0', 'BAT1'];
            for (const battery of batteries) {
                const path = `/sys/class/power_supply/${battery}`;
                if (GenericSysfsDevice.isSupported(path)) {
                    console.log(`Unified Power Manager: Detected standard sysfs battery control for ${battery} (fallback)`);
                    const device = new GenericSysfsDevice(path);
                    if (await device.initialize()) {
                        return device;
                    }
                }
            }
        }

        // Future: Add other vendor-specific devices here if they don't follow the standard sysfs path

        console.log('Unified Power Manager: No supported battery control device found');
        return null;
    }
}