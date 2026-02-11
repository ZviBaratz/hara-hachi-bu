/*
 * Hara Hachi Bu - GNOME Shell Extension
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
        const mockTrigger = Gio.File.new_for_path(`${configDir}/hara-hachi-bu/use_mock`);
        
        if (mockTrigger.query_exists(null)) {
            console.debug('Hara Hachi Bu: Mock device requested via config');
            const device = new MockDevice();
            if (await device.initialize()) {
                return device;
            }
            console.warn('Hara Hachi Bu: Mock device requested but initialization failed, falling through to real devices');
        }

        // Try Generic Sysfs (Standard Linux Battery Class)
        // Iterate over all power supplies to find all supported batteries
        const initializedDevices = [];
        try {
            const powerSupplyDir = Gio.File.new_for_path(Constants.SYSFS_POWER_SUPPLY_PATH);
            if (!powerSupplyDir.query_exists(null)) {
                console.warn(`Hara Hachi Bu: ${Constants.SYSFS_POWER_SUPPLY_PATH} does not exist`);
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
                            console.debug(`Hara Hachi Bu: Skipping removed battery ${name}`);
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
                console.debug(`Hara Hachi Bu: Found ${supportedDevicesInfos.length} supported battery device(s): ${supportedDevicesInfos.map(d => d.name).join(', ')}`);
            } else {
                console.debug('Hara Hachi Bu: No supported battery devices found (standard sysfs)');
                return null;
            }

            for (const devInfo of supportedDevicesInfos) {
                let device = null;
                try {
                    console.debug(`Hara Hachi Bu: Attempting to initialize device ${devInfo.name} at ${devInfo.path}`);
                    device = new GenericSysfsDevice(devInfo.path);
                    if (await device.initialize()) {
                        console.debug(`Hara Hachi Bu: Successfully initialized ${devInfo.name}`);
                        initializedDevices.push(device);
                        device = null; // ownership transferred
                    } else {
                        console.debug(`Hara Hachi Bu: Failed to initialize ${devInfo.name} (no supported threshold files)`);
                    }
                } catch (devError) {
                    console.error(`Hara Hachi Bu: Error initializing device ${devInfo.name}: ${devError}`);
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
                    console.error(`Hara Hachi Bu: Error destroying device during cleanup: ${destroyError}`);
                }
            }
            console.error(`Hara Hachi Bu: Error enumerating power supplies: ${e}`);
        }

        console.debug('Hara Hachi Bu: No supported battery control device found');
        return null;
    }
}
