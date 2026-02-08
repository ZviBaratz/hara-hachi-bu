/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Promisify Gio methods for async/await usage
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const EXEC_TIMEOUT_SECONDS = 5;
const MAX_QUEUE_DEPTH = 3;

// Command queue to serialize privileged write operations
let _ctlQueue = Promise.resolve();
let _queueDepth = 0;

/**
 * Validate battery name format
 * @param {string} name - Battery name (e.g. BAT0)
 * @returns {boolean}
 */
export function validateBatteryName(name) {
    if (!name || typeof name !== 'string') return false;
    // Strict alphanumeric + underscore (common sysfs naming)
    return /^[a-zA-Z0-9_]+$/.test(name);
}

/**
 * Validate threshold value
 * @param {number|string} value - Threshold percentage
 * @returns {boolean}
 */
export function validateThreshold(value) {
    const intVal = parseInt(value, 10);
    return !isNaN(intVal) && intVal >= 0 && intVal <= 100;
}

/**
 * Validate force discharge mode
 * @param {string} mode - Mode string
 * @returns {boolean}
 */
export function validateForceDischargeMode(mode) {
    return mode === 'force-discharge' || mode === 'auto';
}

/**
 * Common exit codes for internal command execution
 * @enum {number}
 */
export const exitCode = {
    SUCCESS: 0,
    ERROR: 1,
    NEEDS_UPDATE: 2,
    TIMEOUT: 3,
    PRIVILEGE_REQUIRED: 126,
};

/**
 * Check if a file exists synchronously
 * @param {string} path - Absolute path to the file
 * @returns {boolean} - True if file exists
 */
export function fileExists(path) {
    try {
        const f = Gio.File.new_for_path(path);
        return f.query_exists(null);
    } catch {
        return false;
    }
}

/**
 * Read file contents synchronously as UTF-8 string
 * @param {string} path - Absolute path to the file
 * @returns {string|null} - File contents or null if failed
 */
export function readFile(path) {
    try {
        const f = Gio.File.new_for_path(path);
        const [, contents] = f.load_contents(null);
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(contents).trim();
    } catch {
        return null;
    }
}

/**
 * Read file contents asynchronously as UTF-8 string
 * @param {string} path - Absolute path to the file
 * @returns {Promise<string|null>} - File contents or null if failed
 */
export async function readFileAsync(path) {
    try {
        const f = Gio.File.new_for_path(path);
        const [contents] = await f.load_contents_async(null);
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(contents).trim();
    } catch {
        return null;
    }
}

/**
 * Read file contents synchronously and parse as integer
 * @param {string} path - Absolute path to the file
 * @returns {number|null} - Parsed integer or null if failed
 */
export function readFileInt(path) {
    try {
        const v = readFile(path);
        if (v) {
            const parsed = parseInt(v, 10);
            return isNaN(parsed) ? null : parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Read file contents asynchronously and parse as integer
 * @param {string} path - Absolute path to the file
 * @returns {Promise<number|null>} - Parsed integer or null if failed
 */
export async function readFileIntAsync(path) {
    const v = await readFileAsync(path);
    if (v) {
        const parsed = parseInt(v, 10);
        return isNaN(parsed) ? null : parsed;
    }
    return null;
}

/**
 * Find a program in the user's PATH
 * @param {string} program - Program name (e.g., 'ls')
 * @returns {string|null} - Absolute path to program or null if not found
 */
export function findValidProgramInPath(program) {
    return GLib.find_program_in_path(program);
}

/**
 * Execute a command and return the result
 * @param {string[]} argv - Command arguments
 * @param {boolean} enableTimeout - Whether to enable timeout (default: true)
 * @returns {Promise<[number, string|null, string|null]>} - [exitCode, stdout, stderr].
 *   On exception, stderr contains the exception message (not subprocess stderr).
 */
export async function execCheck(argv, enableTimeout = true) {
    return _execCheckInternal(argv, enableTimeout);
}

/**
 * Internal command execution implementation
 * @private
 * @param {string[]} argv - Command arguments
 * @param {boolean} enableTimeout - Whether to enable timeout
 * @returns {Promise<[number, string|null, string|null]>} - [exitCode, stdout, stderr]
 */
async function _execCheckInternal(argv, enableTimeout) {
    const cancellable = new Gio.Cancellable();
    let timerId = null;

    try {
        const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
        const proc = new Gio.Subprocess({
            argv,
            flags,
        });
        proc.init(null);

        if (enableTimeout) {
            timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EXEC_TIMEOUT_SECONDS, () => {
                cancellable.cancel();
                timerId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
        const status = proc.get_exit_status();

        if (status !== 0) {
            const detail = stderr?.trim() || `exit code ${status}`;
            console.debug(`Unified Power Manager: Command '${argv[0]}' failed: ${detail}`);
        }

        return [status, stdout, stderr];
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            return [exitCode.TIMEOUT, null, null];
        }
        console.error(`Unified Power Manager: Command execution failed: ${e.message}`);
        return [exitCode.ERROR, null, e.message];
    } finally {
        if (timerId !== null) {
            GLib.Source.remove(timerId);
        }
    }
}

/**
 * Execute a privileged command via pkexec with queue serialization.
 * Commands are queued to prevent concurrent pkexec operations.
 * Queue is bounded to prevent unbounded growth under pathological conditions.
 *
 * @param {string} ctlPath - Path to helper script
 * @param {string} command - Command string to pass to helper
 * @param {...string} args - Additional arguments for the helper
 * @returns {Promise<[number, string|null, string|null]>} - [exitCode, stdout, stderr]
 */
export async function runCommandCtl(ctlPath, command, ...args) {
    // Reject if queue is full to prevent unbounded growth
    if (_queueDepth >= MAX_QUEUE_DEPTH) {
        console.warn(`Unified Power Manager: Command queue full (${_queueDepth} pending), rejecting command: ${command}`);
        return [exitCode.ERROR, null, 'Command queue full - too many pending operations'];
    }

    const argv = ['pkexec', ctlPath, command, ...args.filter(arg => arg !== null && arg !== undefined)];

    // Increment queue depth before queuing
    _queueDepth++;

    const task = _ctlQueue
        .catch(() => {}) // Ignore previous command failures
        .then(() => _execCheckInternal(argv, true))
        .finally(() => {
            // Decrement queue depth when command completes
            if (_queueDepth > 0) _queueDepth--;
        });

    _ctlQueue = task;
    return task;
}

/**
 * Execute a standard command (alias for execCheck)
 * @param {string[]} argv - Command arguments
 * @returns {Promise<[number, string|null, string|null]>} - [exitCode, stdout, stderr]
 */
export async function runCommand(argv) {
    return execCheck(argv);
}

/**
 * Clean up command execution resources
 */
export function destroyExecCheck() {
    // Reset the command queue to prevent stale commands from persisting
    // across extension enable/disable cycles
    _ctlQueue = Promise.resolve();
    _queueDepth = 0;
}

// Known AC adapter names to try (in order of commonality)
const AC_ADAPTER_NAMES = ['AC', 'ACAD', 'ADP0', 'ADP1'];

/**
 * Detect AC adapter online state from sysfs.
 * Tries known adapter names first for speed, then enumerates for type=Mains.
 *
 * @param {string} sysfsPath - Path to /sys/class/power_supply
 * @param {Function} [isCancelled] - Optional callback returning true if caller is destroyed
 * @returns {Promise<boolean|null>} true if AC online, false if on battery, null if unknown
 */
export async function getAcOnlineSysfs(sysfsPath, isCancelled = null) {
    // Try known adapter names first (most common)
    for (const name of AC_ADAPTER_NAMES) {
        if (isCancelled && isCancelled()) return null;
        const onlinePath = `${sysfsPath}/${name}/online`;
        const online = await readFileAsync(onlinePath);
        if (online !== null) {
            return online.trim() === '1';
        }
    }

    // Fallback: enumerate power supplies looking for type=Mains
    try {
        const psDir = Gio.File.new_for_path(sysfsPath);
        const enumerator = await psDir.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null
        );

        while (true) {
            if (isCancelled && isCancelled()) return null;
            const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
            if (!fileInfos || fileInfos.length === 0) break;

            for (const info of fileInfos) {
                if (isCancelled && isCancelled()) return null;
                const entryName = info.get_name();
                const type = await readFileAsync(`${sysfsPath}/${entryName}/type`);
                if (type && type.trim() === 'Mains') {
                    const online = await readFileAsync(`${sysfsPath}/${entryName}/online`);
                    if (online !== null) {
                        return online.trim() === '1';
                    }
                }
            }
        }
    } catch {
        // Enumeration may fail on some systems; fall through
    }

    return null;
}

/**
 * Get a Gio.Icon from the extension's icon folder, falling back to themed icons
 * @param {string} iconFolder - Path to the extension's icon folder
 * @param {string} iconName - Name of the icon (without .svg extension)
 * @returns {Gio.Icon} - Icon object
 */
export function getIconFromPath(iconFolder, iconName) {
    const localPath = `${iconFolder}/${iconName}.svg`;
    const file = Gio.File.new_for_path(localPath);
    if (file.query_exists(null))
        return Gio.icon_new_for_string(localPath);
    return Gio.ThemedIcon.new(iconName);
}