/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
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
        this._dbusInitTimeout = null;
        this._powerprofilesctlPath = null;
        this._currentProfile = 'balanced';
        this._availableProfiles = ['balanced'];
        this._initialized = false;
        this._destroyed = false;
    }

    async initialize() {
        // Try D-Bus first
        try {
            await this._initializeDBus();
            if (this._destroyed)
                return false;
            this._initialized = true;
            return true;
        } catch (e) {
            if (this._destroyed)
                return false;
            console.debug(`Unified Power Manager: D-Bus initialization failed: ${e}`);
        }

        // Fallback to powerprofilesctl
        this._powerprofilesctlPath = findValidProgramInPath('powerprofilesctl');
        if (this._powerprofilesctlPath) {
            await this._refreshFromCli();
            if (this._destroyed)
                return false;
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

            this._dbusInitTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, DBUS_TIMEOUT_SECONDS, () => {
                this._dbusInitTimeout = null;
                if (!resolved) {
                    resolved = true;
                    this._proxy = null; // Don't use partially initialized proxy
                    reject(new Error('D-Bus initialization timeout'));
                }
                return GLib.SOURCE_REMOVE;
            });

            this._proxy = new PowerProfilesProxy(
                Gio.DBus.system,
                POWER_PROFILES_BUS_NAME,
                POWER_PROFILES_OBJECT_PATH,
                (proxy, error) => {
                    if (resolved || this._destroyed)
                        return;

                    resolved = true;
                    if (this._dbusInitTimeout) {
                        GLib.Source.remove(this._dbusInitTimeout);
                        this._dbusInitTimeout = null;
                    }

                    if (error) {
                        reject(error);
                        return;
                    }

                    if (this._destroyed) {
                        reject(new Error('Controller destroyed during initialization'));
                        return;
                    }

                    this._currentProfile = proxy.ActiveProfile || 'balanced';
                    this._parseProfiles(proxy.Profiles);

                    proxy.connectObject('g-properties-changed', (p, changed) => {
                        if (this._destroyed)
                            return;
                        const changedProps = changed.deep_unpack();
                        if ('ActiveProfile' in changedProps) {
                            const newProfile = changedProps.ActiveProfile.deep_unpack();
                            if (newProfile !== this._currentProfile) {
                                this._currentProfile = newProfile;
                                this.emit('power-profile-changed', this._currentProfile);
                            }
                        }
                    }, this);

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
        if (!this._powerprofilesctlPath || this._destroyed)
            return;

        const [status, stdout, stderr] = await runCommand([this._powerprofilesctlPath, 'get']);
        if (this._destroyed)
            return;
        if (status === 0 && stdout) {
            this._currentProfile = stdout.trim();
        } else if (stderr) {
            console.error(`Unified Power Manager: powerprofilesctl get failed: ${stderr.trim()}`);
        }

        // Get available profiles
        const [listStatus, listStdout, listStderr] = await runCommand([this._powerprofilesctlPath, 'list']);
        if (this._destroyed)
            return;
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
        } else if (listStderr) {
            console.error(`Unified Power Manager: powerprofilesctl list failed: ${listStderr.trim()}`);
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
        if (!this._availableProfiles.includes(profile) || this._destroyed)
            return false;

        if (this._proxy) {
            const previousProfile = this._currentProfile;
            try {
                // Update _currentProfile BEFORE D-Bus assignment so the
                // g-properties-changed handler sees no change and skips its emission
                this._currentProfile = profile;
                this._proxy.ActiveProfile = profile;
                if (this._destroyed)
                    return false;
                this.emit('power-profile-changed', profile);
                return true;
            } catch (e) {
                // Rollback on error before falling through to CLI path
                this._currentProfile = previousProfile;
                if (this._destroyed)
                    return false;
                console.debug(`Unified Power Manager: D-Bus setProfile failed, trying CLI fallback: ${e.message}`);
            }
        }

        if (this._powerprofilesctlPath) {
            const [status, stdout, stderr] = await runCommand([this._powerprofilesctlPath, 'set', profile]);
            if (this._destroyed)
                return false;
            if (status === 0) {
                this._currentProfile = profile;
                this.emit('power-profile-changed', profile);
                return true;
            } else if (stderr) {
                console.error(`Unified Power Manager: powerprofilesctl failed: ${stderr.trim()}`);
            }
        }

        return false;
    }

    destroy() {
        this._destroyed = true;
        if (this._dbusInitTimeout) {
            GLib.Source.remove(this._dbusInitTimeout);
            this._dbusInitTimeout = null;
        }
        if (this._proxy) {
            this._proxy.disconnectObject(this);
        }
        this._proxy = null;
        this._initialized = false;
    }
});
