/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * PowerProfileController manages system power profiles via D-Bus or CLI.
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Helper from './helper.js';

const {findValidProgramInPath, runCommand} = Helper;

const POWER_PROFILES_BUS_NAME = 'org.freedesktop.UPower.PowerProfiles';
const POWER_PROFILES_OBJECT_PATH = '/org/freedesktop/UPower/PowerProfiles';

const PowerProfilesIface = `
<node>
  <interface name="org.freedesktop.UPower.PowerProfiles">
    <property name="ActiveProfile" type="s" access="readwrite"/>
    <property name="Profiles" type="aa{sv}" access="read"/>
    <property name="PerformanceDegraded" type="s" access="read"/>
    <property name="PerformanceInhibited" type="s" access="read"/>
  </interface>
</node>`;

export const PowerProfileController = GObject.registerClass({
    Signals: {
        'power-profile-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class PowerProfileController extends GObject.Object {
    constructor() {
        super();
        this._proxy = null;
        this._proxySignalId = null;
        this._powerprofilesctlPath = null;
        this._currentProfile = 'balanced';
        this._availableProfiles = ['balanced'];
        this._initialized = false;
    }

    async initialize() {
        // Try D-Bus first
        try {
            await this._initializeDBus();
            this._initialized = true;
            return true;
        } catch (e) {
            console.log(`Unified Power Manager: D-Bus initialization failed: ${e}`);
        }

        // Fallback to powerprofilesctl
        this._powerprofilesctlPath = findValidProgramInPath('powerprofilesctl');
        if (this._powerprofilesctlPath) {
            await this._refreshFromCli();
            this._initialized = true;
            return true;
        }

        console.log('Unified Power Manager: No power profile control available');
        return false;
    }

    async _initializeDBus() {
        const PowerProfilesProxy = Gio.DBusProxy.makeProxyWrapper(PowerProfilesIface);
        const DBUS_TIMEOUT_SECONDS = 10;

        return new Promise((resolve, reject) => {
            let resolved = false;

            const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DBUS_TIMEOUT_SECONDS, () => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('D-Bus initialization timeout'));
                }
                return GLib.SOURCE_REMOVE;
            });

            this._proxy = new PowerProfilesProxy(
                Gio.DBus.system,
                POWER_PROFILES_BUS_NAME,
                POWER_PROFILES_OBJECT_PATH,
                (proxy, error) => {
                    if (resolved)
                        return;

                    resolved = true;
                    GLib.Source.remove(timeoutId);

                    if (error) {
                        reject(error);
                        return;
                    }

                    this._currentProfile = proxy.ActiveProfile || 'balanced';
                    this._parseProfiles(proxy.Profiles);

                    this._proxySignalId = proxy.connect('g-properties-changed', (p, changed) => {
                        const changedProps = changed.deep_unpack();
                        if ('ActiveProfile' in changedProps) {
                            const newProfile = changedProps.ActiveProfile.deep_unpack();
                            if (newProfile !== this._currentProfile) {
                                this._currentProfile = newProfile;
                                this.emit('power-profile-changed', this._currentProfile);
                            }
                        }
                    });

                    resolve();
                }
            );
        });
    }

    _parseProfiles(profiles) {
        if (!profiles)
            return;

        this._availableProfiles = [];
        for (const profile of profiles) {
            const unpacked = profile.deep_unpack ? profile.deep_unpack() : profile;
            if (unpacked.Profile) {
                const profileName = unpacked.Profile.deep_unpack ?
                    unpacked.Profile.deep_unpack() : unpacked.Profile;
                this._availableProfiles.push(profileName);
            }
        }

        if (this._availableProfiles.length === 0)
            this._availableProfiles = ['balanced'];
    }

    async _refreshFromCli() {
        if (!this._powerprofilesctlPath)
            return;

        const [status, stdout] = await runCommand([this._powerprofilesctlPath, 'get']);
        if (status === 0 && stdout) {
            this._currentProfile = stdout.trim();
        }

        // Get available profiles
        const [listStatus, listStdout] = await runCommand([this._powerprofilesctlPath, 'list']);
        if (listStatus === 0 && listStdout) {
            this._availableProfiles = [];
            const lines = listStdout.split('\n');
            for (const line of lines) {
                const match = line.match(/^\s*\*?\s*(performance|balanced|power-saver)/);
                if (match) {
                    if (!this._availableProfiles.includes(match[1]))
                        this._availableProfiles.push(match[1]);
                }
            }
            if (this._availableProfiles.length === 0)
                this._availableProfiles = ['balanced'];
        }
    }

    get currentProfile() {
        return this._currentProfile;
    }

    get availableProfiles() {
        return this._availableProfiles;
    }

    get isAvailable() {
        return this._initialized;
    }

    async setProfile(profile) {
        if (!this._availableProfiles.includes(profile))
            return false;

        if (this._proxy) {
            try {
                this._proxy.ActiveProfile = profile;
                this._currentProfile = profile;
                // Emit signal immediately for D-Bus path since the property-changed
                // callback may have delay or may not fire if value is same
                this.emit('power-profile-changed', profile);
                return true;
            } catch (e) {
                console.log(`Unified Power Manager: D-Bus setProfile failed, trying CLI fallback: ${e.message}`);
            }
        }

        if (this._powerprofilesctlPath) {
            const [status] = await runCommand([this._powerprofilesctlPath, 'set', profile]);
            if (status === 0) {
                this._currentProfile = profile;
                this.emit('power-profile-changed', profile);
                return true;
            }
        }

        return false;
    }

    destroy() {
        if (this._proxySignalId && this._proxy) {
            this._proxy.disconnect(this._proxySignalId);
            this._proxySignalId = null;
        }
        this._proxy = null;
        this._initialized = false;
    }
});
