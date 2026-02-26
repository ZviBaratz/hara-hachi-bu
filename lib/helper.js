/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
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
let _execDestroyed = false;

/**
 * Validate battery name format
 */
export function validateBatteryName(name) {
    if (!name || typeof name !== 'string') return false;
    // Alphanumeric, underscore, and hyphen (e.g., BAT0, macsmc-battery)
    return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

/**
 * Validate threshold value
 */
export function validateThreshold(value) {
    const intVal = parseInt(value, 10);
    return !isNaN(intVal) && intVal >= 0 && intVal <= 100;
}

/**
 * Validate force discharge mode
 */
export function validateForceDischargeMode(mode) {
    return mode === 'force-discharge' || mode === 'auto';
}

/**
 * Parse charge_behaviour sysfs content to determine if force-discharge is active.
 * Handles both bracketed format "[force-discharge] auto" and plain format "force-discharge".
 */
export function isForceDischargeActive(behaviour) {
    if (!behaviour) return false;
    if (behaviour.includes('[force-discharge]')) return true;
    if (/\bforce-discharge\b/.test(behaviour) && !behaviour.includes('['))
        return behaviour.trim() === 'force-discharge';
    return false;
}

/**
 * Common exit codes for internal command execution
 */
export const exitCode = {
    SUCCESS: 0,
    ERROR: 1,
    NEEDS_UPDATE: 2,
    TIMEOUT: 3,
    PRIVILEGE_REQUIRED: 126,
    COMMAND_NOT_FOUND: 127,
};

/**
 * Check if a file exists synchronously
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
 * Read file contents asynchronously as UTF-8 string
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
 * Read file contents asynchronously and parse as integer
 */
export async function readFileIntAsync(path) {
    const v = await readFileAsync(path);
    if (v !== null) {
        const parsed = parseInt(v, 10);
        return isNaN(parsed) ? null : parsed;
    }
    return null;
}

/**
 * Find a program in the user's PATH
 */
export function findValidProgramInPath(program) {
    return GLib.find_program_in_path(program);
}

/**
 * Execute a command and return the result
 *   On exception, stderr contains the exception message (not subprocess stderr).
 */
export function execCheck(argv, enableTimeout = true) {
    return _execCheckInternal(argv, enableTimeout);
}

/**
 * Internal command execution implementation
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
            console.debug(`Hara Hachi Bu: Command '${argv[0]}' failed: ${detail}`);
        }

        return [status, stdout, stderr];
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return [exitCode.TIMEOUT, null, null];

        console.error(`Hara Hachi Bu: Command execution failed: ${e.message}`);
        return [exitCode.ERROR, null, e.message];
    } finally {
        if (timerId !== null) GLib.Source.remove(timerId);
    }
}

/**
 * Execute a privileged command via pkexec with queue serialization.
 * Commands are queued to prevent concurrent pkexec operations.
 * Queue is bounded to prevent unbounded growth under pathological conditions.
 */
export function runCommandCtl(ctlPath, command, ...args) {
    // Reject if queue is full to prevent unbounded growth
    if (_queueDepth >= MAX_QUEUE_DEPTH) {
        console.warn(`Hara Hachi Bu: Command queue full (${_queueDepth} pending), rejecting command: ${command}`);
        return [exitCode.ERROR, null, 'Command queue full - too many pending operations'];
    }

    const argv = ['pkexec', ctlPath, command, ...args.filter((arg) => arg !== null && arg !== undefined)];

    // Increment queue depth before queuing
    _queueDepth++;

    const task = _ctlQueue
        .catch(() => {}) // Ignore previous command failures
        .then(() => {
            if (_execDestroyed) return [exitCode.ERROR, null, 'Extension disabled'];
            return _execCheckInternal(argv, true);
        })
        .finally(() => {
            // Decrement queue depth when command completes
            if (_queueDepth > 0) _queueDepth--;
        });

    _ctlQueue = task;
    return task;
}

/**
 * Execute a standard command (alias for execCheck)
 */
export function runCommand(argv) {
    return execCheck(argv);
}

/**
 * Clean up command execution resources
 */
export function destroyExecCheck() {
    // Prevent queued commands from executing after extension disable
    _execDestroyed = true;
    _ctlQueue = Promise.resolve();
    _queueDepth = 0;
}

/**
 * Re-enable command execution (called on extension enable)
 */
export function initExecCheck() {
    _execDestroyed = false;
}

// Known AC adapter names to try (in order of commonality)
const AC_ADAPTER_NAMES = ['AC', 'ACAD', 'ADP0', 'ADP1'];

/**
 * Detect AC adapter online state from sysfs.
 * Tries known adapter names first for speed, then enumerates for type=Mains.
 */
export async function getAcOnlineSysfs(sysfsPath, isCancelled = null) {
    // Try known adapter names first (most common)
    for (const name of AC_ADAPTER_NAMES) {
        if (isCancelled && isCancelled()) return null;
        const onlinePath = `${sysfsPath}/${name}/online`;
        // Sequential: each name is tried only if the previous didn't exist
        // eslint-disable-next-line no-await-in-loop
        const online = await readFileAsync(onlinePath);
        if (online !== null) return online.trim() === '1';
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
            // Sequential: each batch must complete before fetching the next
            // eslint-disable-next-line no-await-in-loop
            const fileInfos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, null);
            if (!fileInfos || fileInfos.length === 0) break;

            for (const info of fileInfos) {
                if (isCancelled && isCancelled()) return null;
                const entryName = info.get_name();
                // eslint-disable-next-line no-await-in-loop
                const type = await readFileAsync(`${sysfsPath}/${entryName}/type`);
                if (type && type.trim() === 'Mains') {
                    // eslint-disable-next-line no-await-in-loop
                    const online = await readFileAsync(`${sysfsPath}/${entryName}/online`);
                    if (online !== null) return online.trim() === '1';
                }
            }
        }
    } catch (e) {
        console.debug('Hara Hachi Bu: AC adapter enumeration failed:', e.message);
    }

    return null;
}

/**
 * Get a Gio.Icon from the extension's icon folder, falling back to themed icons
 */
export function getIconFromPath(iconFolder, iconName) {
    const localPath = `${iconFolder}/${iconName}.svg`;
    const file = Gio.File.new_for_path(localPath);
    if (file.query_exists(null)) return Gio.icon_new_for_string(localPath);
    return Gio.ThemedIcon.new(iconName);
}
