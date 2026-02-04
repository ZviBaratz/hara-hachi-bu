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
import { CompositeDevice } from './CompositeDevice.js';
import * as Helper from '../helper.js';
import * as Constants from '../constants.js';

const {readFileAsync} = Helper;

// Promisify Gio.File methods for async/await usage
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

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
        }

        // Try Generic Sysfs (Standard Linux Battery Class)
        // Iterate over all power supplies to find all supported batteries
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

            const initializedDevices = [];
            for (const devInfo of supportedDevicesInfos) {
                console.debug(`Unified Power Manager: Attempting to initialize device ${devInfo.name} at ${devInfo.path}`);
                const device = new GenericSysfsDevice(devInfo.path);
                if (await device.initialize()) {
                    console.debug(`Unified Power Manager: Successfully initialized ${devInfo.name}`);
                    initializedDevices.push(device);
                }
            }

            if (initializedDevices.length === 1) {
                return initializedDevices[0];
            } else if (initializedDevices.length > 1) {
                return new CompositeDevice(initializedDevices);
            }
        } catch (e) {
            console.error(`Unified Power Manager: Error enumerating power supplies: ${e}`);
        }

        console.log('Unified Power Manager: No supported battery control device found');
        return null;
    }
}
