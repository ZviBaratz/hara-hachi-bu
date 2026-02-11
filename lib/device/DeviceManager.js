/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { GenericSysfsDevice } from './GenericSysfsDevice.js';
import { MockDevice } from './MockDevice.js';
import { CompositeDevice } from './CompositeDevice.js';
import * as Helper from '../helper.js';
import * as Constants from '../constants.js';

const {readFileAsync} = Helper;

export class DeviceManager {
    static async getDevice() {
        // Check for mock trigger for testing
        const configDir = GLib.get_user_config_dir();
        const mockTrigger = Gio.File.new_for_path(`${configDir}/unified-power-manager/use_mock`);
        
        if (mockTrigger.query_exists(null)) {
            console.debug('Unified Power Manager: Mock device requested via config');
            const device = new MockDevice();
            if (await device.initialize()) {
                return device;
            }
            console.warn('Unified Power Manager: Mock device requested but initialization failed, falling through to real devices');
        }

        // Try Generic Sysfs (Standard Linux Battery Class)
        // Iterate over all power supplies to find all supported batteries
        const initializedDevices = [];
        try {
            const powerSupplyDir = Gio.File.new_for_path(Constants.SYSFS_POWER_SUPPLY_PATH);
            if (!powerSupplyDir.query_exists(null)) {
                console.warn(`Unified Power Manager: ${Constants.SYSFS_POWER_SUPPLY_PATH} does not exist`);
                return null;
            }

            const enumerator = await powerSupplyDir.enumerate_children_async(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null
            );

            const supportedDevicesInfos = [];

            while (true) {
                const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
                if (!fileInfos || fileInfos.length === 0)
                    break;

                for (const info of fileInfos) {
                    const name = info.get_name();
                    const path = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${name}`;
                    
                    // Filter: Must be a Battery and must be System scope (not a peripheral)
                    const type = (await readFileAsync(`${path}/type`) || '').trim();
                    const scope = (await readFileAsync(`${path}/scope`) || 'System').trim();

                    if (type === 'Battery' && scope === 'System') {
                        // Check if battery is present (physically installed)
                        const present = (await readFileAsync(`${path}/present`));
                        if (present !== null && present.trim() === '0') {
                            console.debug(`Unified Power Manager: Skipping removed battery ${name}`);
                            continue;
                        }

                        if (GenericSysfsDevice.isSupported(path)) {
                            supportedDevicesInfos.push({name, path});
                        }
                    }
                }
            }

            // Sort devices to prefer BAT0, BAT1, etc.
            supportedDevicesInfos.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));

            if (supportedDevicesInfos.length > 0) {
                console.debug(`Unified Power Manager: Found ${supportedDevicesInfos.length} supported battery device(s): ${supportedDevicesInfos.map(d => d.name).join(', ')}`);
            } else {
                console.debug('Unified Power Manager: No supported battery devices found (standard sysfs)');
                return null;
            }

            for (const devInfo of supportedDevicesInfos) {
                let device = null;
                try {
                    console.debug(`Unified Power Manager: Attempting to initialize device ${devInfo.name} at ${devInfo.path}`);
                    device = new GenericSysfsDevice(devInfo.path);
                    if (await device.initialize()) {
                        console.debug(`Unified Power Manager: Successfully initialized ${devInfo.name}`);
                        initializedDevices.push(device);
                        device = null; // ownership transferred
                    } else {
                        console.debug(`Unified Power Manager: Failed to initialize ${devInfo.name} (no supported threshold files)`);
                    }
                } catch (devError) {
                    console.error(`Unified Power Manager: Error initializing device ${devInfo.name}: ${devError}`);
                } finally {
                    device?.destroy();
                }
            }

            if (initializedDevices.length === 1) {
                return initializedDevices[0];
            } else if (initializedDevices.length > 1) {
                return new CompositeDevice(initializedDevices);
            }
        } catch (e) {
            // Clean up any initialized devices on outer-scope exception
            for (const dev of initializedDevices) {
                try {
                    dev.destroy();
                } catch (destroyError) {
                    console.error(`Unified Power Manager: Error destroying device during cleanup: ${destroyError}`);
                }
            }
            console.error(`Unified Power Manager: Error enumerating power supplies: ${e}`);
        }

        console.debug('Unified Power Manager: No supported battery control device found');
        return null;
    }
}
