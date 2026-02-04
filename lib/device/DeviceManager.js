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
import * as Helper from '../helper.js';
import * as Constants from '../constants.js';

const {readFile} = Helper;

// Promisify Gio.File methods for async/await usage
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

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

            const supportedDevices = [];

            while (true) {
                const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
                if (!fileInfos || fileInfos.length === 0)
                    break;

                for (const info of fileInfos) {
                    const name = info.get_name();
                    const path = `${Constants.SYSFS_POWER_SUPPLY_PATH}/${name}`;
                    
                    // Filter: Must be a Battery and must be System scope (not a peripheral)
                    const type = (readFile(`${path}/type`) || '').trim();
                    const scope = (readFile(`${path}/scope`) || 'System').trim();

                    if (type === 'Battery' && scope === 'System') {
                        if (GenericSysfsDevice.isSupported(path)) {
                            supportedDevices.push({name, path});
                        }
                    }
                }
            }

            // Sort devices to prefer BAT0, BAT1, etc.
            supportedDevices.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));

            for (const devInfo of supportedDevices) {
                console.log(`Unified Power Manager: Attempting to initialize device ${devInfo.name} at ${devInfo.path}`);
                const device = new GenericSysfsDevice(devInfo.path);
                if (await device.initialize()) {
                    console.log(`Unified Power Manager: Successfully initialized ${devInfo.name}`);
                    return device;
                }
            }
        } catch (e) {
            console.error(`Unified Power Manager: Error enumerating power supplies: ${e}`);
        }

        console.log('Unified Power Manager: No supported battery control device found');
        return null;
    }
}
