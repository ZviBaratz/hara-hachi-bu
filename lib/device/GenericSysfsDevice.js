/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {BaseDevice} from './BaseDevice.js';
import * as Helper from '../helper.js';
import * as Constants from '../constants.js';

const {
    exitCode,
    fileExists,
    readFileAsync,
    readFileIntAsync,
    runCommandCtl,
    findValidProgramInPath,
    validateBatteryName,
    validateThreshold,
    validateForceDischargeMode,
    isForceDischargeActive,
} = Helper;

// Exponential backoff delays (ms) for verifying force discharge state after write (~3.15s total)
const FORCE_DISCHARGE_VERIFY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

export const GenericSysfsDevice = GObject.registerClass(
    {
        GTypeName: 'HhbGenericSysfsDevice',
    },
    class GenericSysfsDevice extends BaseDevice {
        /**
         * @param {string} batteryPath - The full path to the battery sysfs directory (e.g., '/sys/class/power_supply/BAT0')
         */
        constructor(batteryPath) {
            super();

            // Validate path prefix (defense-in-depth: helper script also validates server-side)
            const expectedPrefix = `${Constants.SYSFS_POWER_SUPPLY_PATH}/`;
            if (!batteryPath.startsWith(expectedPrefix))
                throw new Error(`Invalid battery path: expected ${expectedPrefix} prefix, got ${batteryPath}`);

            this._sysfsPath = batteryPath;
            const batteryName = batteryPath.split('/').pop();

            // Validate battery name immediately (fail fast on invalid input)
            if (!validateBatteryName(batteryName)) throw new Error(`Invalid battery name: ${batteryName}`);

            this.batteryName = batteryName;

            this.name = `Generic Sysfs Device (${this.batteryName})`;

            // Initialize paths - detected in initialize()
            this.endPath = null;
            this.startPath = null;
            this.endFilename = null;
            this.startFilename = null;

            this.capacityPath = `${batteryPath}/${Constants.CAPACITY_FILE}`;
            this.forceDischargePath = `${batteryPath}/${Constants.BEHAVIOUR_FILE}`;

            // Health related paths
            this.energyFullDesignPath = `${batteryPath}/${Constants.ENERGY_FULL_DESIGN_FILE}`;
            this.energyFullPath = `${batteryPath}/${Constants.ENERGY_FULL_FILE}`;
            this.chargeFullDesignPath = `${batteryPath}/${Constants.CHARGE_FULL_DESIGN_FILE}`;
            this.chargeFullPath = `${batteryPath}/${Constants.CHARGE_FULL_FILE}`;

            this.ctlPath = null;
            this.endLimitValue = -1;
            this.startLimitValue = -1;
            this._monitorLevel = null;
            this._monitorForceDischarge = null;
            this._supportsForceDischarge = false;
            this._forceDischargeEnabled = false;
            this._missingHelper = false;
            this._health = null;
            this._batteryLevel = null;
            this._forceDischargeVerifyTimeout = null;
            this._forceDischargeVerifyResolve = null;
            this._settingForceDischarge = false;
            this._destroyed = false;
        }

        async initialize() {
            // Detect supported threshold files
            for (const filename of Constants.THRESHOLD_END_FILES) {
                const path = `${this._sysfsPath}/${filename}`;
                if (fileExists(path)) {
                    this.endPath = path;
                    this.endFilename = filename;
                    break;
                }
            }

            // We require at least the end threshold for support
            if (!this.endPath) return false;

            // Check start threshold support
            for (const filename of Constants.THRESHOLD_START_FILES) {
                const path = `${this._sysfsPath}/${filename}`;
                if (fileExists(path)) {
                    this.startPath = path;
                    this.startFilename = filename;
                    break;
                }
            }

            this._hasStartThreshold = this.startPath !== null;

            // Find the helper script
            this.ctlPath = findValidProgramInPath(Constants.HELPER_BIN_NAME);

            // Fallback: Check /usr/local/bin explicitly if not in PATH
            // The polkit policy hardcodes /usr/local/bin/hhb-power-ctl as the authorized
            // exec path. A helper found elsewhere may still work but could prompt for a password.
            if (!this.ctlPath && fileExists(`/usr/local/bin/${Constants.HELPER_BIN_NAME}`))
                this.ctlPath = `/usr/local/bin/${Constants.HELPER_BIN_NAME}`;

            if (!this.ctlPath) {
                console.warn(
                    `Hara Hachi Bu: ${Constants.HELPER_BIN_NAME} helper not found, battery control will be read-only`
                );
                this._missingHelper = true;
            } else {
                this._missingHelper = false;
            }

            // Check force discharge support
            this._supportsForceDischarge = fileExists(this.forceDischargePath);

            // Read current values
            await this.refreshValues();

            // Set up file monitoring for external changes
            this._initializeMonitoring();

            return true;
        }

        /**
         * Check if a specific battery is supported
         * @param {string} batteryPath - e.g. '/sys/class/power_supply/BAT0'
         */
        static isSupported(batteryPath) {
            // Check if standard Linux battery threshold files exist
            // We require at least end thresholds for minimal support
            for (const filename of Constants.THRESHOLD_END_FILES) {
                if (fileExists(`${batteryPath}/${filename}`)) return true;
            }

            return false;
        }

        _initializeMonitoring() {
            if (!this._monitorLevel) {
                try {
                    // Monitor end threshold for external changes
                    const endThresholdFile = Gio.File.new_for_path(this.endPath);
                    this._monitorLevel = endThresholdFile.monitor_file(Gio.FileMonitorFlags.NONE, null);

                    this._connectMonitorSignal();
                } catch (e) {
                    console.error(`Hara Hachi Bu: Failed to initialize threshold monitor: ${e.message}`);
                }
            }

            if (this._supportsForceDischarge && !this._monitorForceDischarge) {
                try {
                    // Monitor force discharge file
                    const fdFile = Gio.File.new_for_path(this.forceDischargePath);
                    this._monitorForceDischarge = fdFile.monitor_file(Gio.FileMonitorFlags.NONE, null);

                    this._connectForceDischargeMonitor();
                } catch (e) {
                    console.error(`Hara Hachi Bu: Failed to initialize force discharge monitor: ${e.message}`);
                }
            }
        }

        _connectMonitorSignal() {
            if (!this._monitorLevel) return;

            // Use connectObject to bind the signal to this instance's lifecycle
            this._monitorLevel.connectObject(
                'changed',
                (obj, theFile, otherFile, eventType) => {
                    if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) this._onThresholdChangedFromMonitor();
                },
                this
            );
        }

        async _onThresholdChangedFromMonitor() {
            try {
                const newEnd = await readFileIntAsync(this.endPath);
                if (this._destroyed) return;

                let newStart = this.startLimitValue;

                if (this._hasStartThreshold) {
                    newStart = await readFileIntAsync(this.startPath);
                    if (this._destroyed) return;
                }

                if (newEnd === null) {
                    console.debug(`Hara Hachi Bu: File monitor fired but could not read ${this.endPath}`);
                    return;
                }
                if (newEnd !== this.endLimitValue || (this._hasStartThreshold && newStart !== this.startLimitValue)) {
                    this.endLimitValue = newEnd;
                    if (this._hasStartThreshold && newStart !== null) this.startLimitValue = newStart;

                    this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
                }
            } catch (e) {
                if (!this._destroyed) console.error(`Hara Hachi Bu: File monitor error: ${e.message}`);
            }
        }

        _disconnectMonitorSignal() {
            if (this._monitorLevel) this._monitorLevel.disconnectObject(this);
        }

        _connectForceDischargeMonitor() {
            if (!this._monitorForceDischarge) return;

            this._monitorForceDischarge.connectObject(
                'changed',
                (obj, theFile, otherFile, eventType) => {
                    if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                        this._checkForceDischargeState().catch((e) => {
                            if (!this._destroyed)
                                console.error(`Hara Hachi Bu: Force discharge monitor error: ${e.message}`);
                        });
                    }
                },
                this
            );
        }

        _disconnectForceDischargeMonitor() {
            if (this._monitorForceDischarge) this._monitorForceDischarge.disconnectObject(this);
        }

        async _checkForceDischargeState() {
            const behaviour = await readFileAsync(this.forceDischargePath);
            if (this._destroyed || !behaviour) return;

            const newState = isForceDischargeActive(behaviour);

            if (this._forceDischargeEnabled !== newState) {
                this._forceDischargeEnabled = newState;
                this.emit('force-discharge-changed', newState);
            }
        }

        getThresholds() {
            return {
                start: this.startLimitValue,
                end: this.endLimitValue,
            };
        }

        /**
         * Set battery charging thresholds with correct write ordering.
         * @param {number} startValue - Start threshold (0-100), ignored if device has no start threshold
         * @param {number} endValue - End threshold (0-100)
         * @returns {Promise<boolean>} - Success status
         * @private
         */
        async setThresholds(startValue, endValue) {
            if (this._missingHelper) return false;

            // Ensure inputs are treated as integers
            const start = parseInt(startValue, 10);
            const end = parseInt(endValue, 10);

            // Validate thresholds (battery name already validated in constructor)
            if (!validateThreshold(start) || !validateThreshold(end)) {
                console.error(`Hara Hachi Bu: Invalid threshold values: start=${start}, end=${end}`);
                return false;
            }

            if (this._hasStartThreshold && start >= end) return false;

            // Temporarily disconnect monitor to avoid self-triggering
            this._disconnectMonitorSignal();

            let status, stderr;
            let signalEmitted = false;

            try {
                if (this._hasStartThreshold) {
                    // Read current values from disk to ensure safe write order
                    // If read fails, fall back to cached values
                    const currentEnd = (await readFileIntAsync(this.endPath)) ?? this.endLimitValue;

                    // Determine the correct order for writing thresholds
                    // If increasing, write END first; if decreasing, write START first
                    // Use current end threshold from disk as the reference
                    const cmd = start >= currentEnd ? `${this.batteryName}_END_START` : `${this.batteryName}_START_END`;
                    [status, , stderr] = await runCommandCtl(this.ctlPath, cmd, `${end}`, `${start}`);
                } else {
                    // Only set end threshold
                    [status, , stderr] = await runCommandCtl(this.ctlPath, `${this.batteryName}_END`, `${end}`);
                }

                // Check if destroyed during await
                if (this._destroyed) return false;

                if (status === exitCode.SUCCESS) {
                    // Re-read values to confirm
                    this.endLimitValue = (await readFileIntAsync(this.endPath)) ?? end;
                    if (this._hasStartThreshold)
                        this.startLimitValue = (await readFileIntAsync(this.startPath)) ?? start;

                    this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
                    signalEmitted = true;
                    return true;
                } else if (status === exitCode.PRIVILEGE_REQUIRED) {
                    console.error(
                        'Hara Hachi Bu: Privilege required - polkit rules may not be configured. Run install-helper.sh'
                    );
                } else if (status === exitCode.COMMAND_NOT_FOUND) {
                    console.error(`Hara Hachi Bu: Helper script not found at ${this.ctlPath}. Run install-helper.sh`);
                } else if (stderr) {
                    console.error(`Hara Hachi Bu: Failed to set thresholds: ${stderr.trim()}`);
                }

                return false;
            } finally {
                if (!this._destroyed) {
                    // Reconnect monitor
                    this._connectMonitorSignal();

                    // Re-sync state to catch any external changes during the operation
                    // Skip if we already emitted a signal in the try block
                    // Note: Do NOT use `return` in finally — it overrides the try block's return value
                    if (!signalEmitted && !this._destroyed) {
                        const currentEnd = await readFileIntAsync(this.endPath);

                        if (!this._destroyed) {
                            let currentStart = this.startLimitValue;
                            if (this._hasStartThreshold) currentStart = await readFileIntAsync(this.startPath);

                            // If values on disk differ from our internal state, update and notify
                            if (
                                !this._destroyed &&
                                currentEnd !== null &&
                                (currentEnd !== this.endLimitValue ||
                                    (this._hasStartThreshold &&
                                        currentStart !== null &&
                                        currentStart !== this.startLimitValue))
                            ) {
                                this.endLimitValue = currentEnd;
                                if (this._hasStartThreshold && currentStart !== null)
                                    this.startLimitValue = currentStart;

                                this.emit('threshold-changed', this.startLimitValue, this.endLimitValue);
                            }
                        }
                    }
                }
            }
        }

        getForceDischarge() {
            return this._forceDischargeEnabled;
        }

        async setForceDischarge(enabled) {
            if (!this._supportsForceDischarge || this._missingHelper) return false;

            if (this._settingForceDischarge) {
                console.debug('Hara Hachi Bu: setForceDischarge already in progress, skipping');
                return false;
            }

            this._settingForceDischarge = true;

            // Temporarily disconnect monitor to avoid self-triggering
            this._disconnectForceDischargeMonitor();

            try {
                const mode = enabled ? 'force-discharge' : 'auto';

                if (!validateForceDischargeMode(mode)) {
                    console.error(`Hara Hachi Bu: Invalid force discharge mode '${mode}'`);
                    return false;
                }

                const [status, , stderr] = await runCommandCtl(
                    this.ctlPath,
                    `FORCE_DISCHARGE_${this.batteryName}`,
                    mode
                );

                if (this._destroyed) return false;

                if (status === exitCode.SUCCESS) {
                    // Verify state change with polling (exponential backoff)
                    for (let i = 0; i < FORCE_DISCHARGE_VERIFY_DELAYS_MS.length; i++) {
                        if (this._destroyed) return false;

                        // Wait (backoff): each delay must complete before the next verification
                        // eslint-disable-next-line no-await-in-loop
                        await new Promise((resolve) => {
                            this._forceDischargeVerifyResolve = resolve;
                            this._forceDischargeVerifyTimeout = GLib.timeout_add(
                                GLib.PRIORITY_DEFAULT,
                                FORCE_DISCHARGE_VERIFY_DELAYS_MS[i],
                                () => {
                                    this._forceDischargeVerifyTimeout = null;
                                    this._forceDischargeVerifyResolve = null;
                                    resolve();
                                    return GLib.SOURCE_REMOVE;
                                }
                            );
                        });

                        if (this._destroyed) return false;

                        // eslint-disable-next-line no-await-in-loop
                        const behaviour = await readFileAsync(this.forceDischargePath);
                        if (this._destroyed) return false;
                        if (!behaviour) continue;

                        const verified = enabled
                            ? isForceDischargeActive(behaviour)
                            : !isForceDischargeActive(behaviour);

                        if (verified) {
                            this._forceDischargeEnabled = enabled;
                            this.emit('force-discharge-changed', enabled);
                            return true;
                        }
                    }

                    console.warn(
                        'Hara Hachi Bu: Force discharge write succeeded but verification failed. Reverting state.'
                    );
                    await this.refreshValues(); // Re-read actual state from disk
                    this.emit('force-discharge-changed', this._forceDischargeEnabled);
                    return false;
                } else if (status === exitCode.PRIVILEGE_REQUIRED) {
                    console.error(
                        'Hara Hachi Bu: Privilege required for force discharge — polkit rules may not be configured'
                    );
                } else if (status === exitCode.COMMAND_NOT_FOUND) {
                    console.error(`Hara Hachi Bu: Helper script not found at ${this.ctlPath}. Run install-helper.sh`);
                } else if (stderr) {
                    console.error(`Hara Hachi Bu: Failed to set force discharge: ${stderr.trim()}`);
                }

                return false;
            } finally {
                this._settingForceDischarge = false;
                if (!this._destroyed) {
                    this._connectForceDischargeMonitor();
                    // Re-sync state
                    await this._checkForceDischargeState();
                }
            }
        }

        get needsHelper() {
            return this._missingHelper;
        }

        get supportsForceDischarge() {
            return this._supportsForceDischarge;
        }

        get hasStartThreshold() {
            return this._hasStartThreshold;
        }

        getBatteryLevel() {
            return this._batteryLevel ?? 0;
        }

        /**
         * Get battery health percentage (0-100)
         * @returns {number|null}
         */
        getHealth() {
            return this._health;
        }

        async refreshValues() {
            if (this._destroyed) return;

            this.endLimitValue = (await readFileIntAsync(this.endPath)) ?? 100;

            if (this._hasStartThreshold) this.startLimitValue = (await readFileIntAsync(this.startPath)) ?? 95;
            else this.startLimitValue = -1;

            // Cache battery level
            this._batteryLevel = (await readFileIntAsync(this.capacityPath)) ?? this._batteryLevel;

            // Calculate health
            const energyFull = await readFileIntAsync(this.energyFullPath);
            const energyFullDesign = await readFileIntAsync(this.energyFullDesignPath);

            if (energyFull !== null && energyFullDesign !== null && energyFullDesign > 0) {
                const health = Math.round((energyFull / energyFullDesign) * 100);
                this._health = Math.min(100, Math.max(0, health));
            } else {
                const chargeFull = await readFileIntAsync(this.chargeFullPath);
                const chargeFullDesign = await readFileIntAsync(this.chargeFullDesignPath);

                if (chargeFull !== null && chargeFullDesign !== null && chargeFullDesign > 0) {
                    const health = Math.round((chargeFull / chargeFullDesign) * 100);
                    this._health = Math.min(100, Math.max(0, health));
                } else {
                    this._health = null;
                }
            }

            if (this._destroyed) return;

            if (this._supportsForceDischarge) await this._checkForceDischargeState();
        }

        destroy() {
            this._destroyed = true;
            if (this._forceDischargeVerifyTimeout) {
                GLib.Source.remove(this._forceDischargeVerifyTimeout);
                this._forceDischargeVerifyTimeout = null;
            }
            // Unblock any pending setForceDischarge await
            if (this._forceDischargeVerifyResolve) {
                this._forceDischargeVerifyResolve();
                this._forceDischargeVerifyResolve = null;
            }
            if (this._monitorLevel) {
                this._monitorLevel.disconnectObject(this);
                this._monitorLevel.cancel();
                this._monitorLevel = null;
            }
            if (this._monitorForceDischarge) {
                this._monitorForceDischarge.disconnectObject(this);
                this._monitorForceDischarge.cancel();
                this._monitorForceDischarge = null;
            }
        }
    }
);
