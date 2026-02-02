/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const EXEC_TIMEOUT_SECONDS = 5;
const MAX_QUEUE_DEPTH = 10;

// Command queue to serialize privileged write operations
let _ctlQueue = Promise.resolve();
let _queueDepth = 0;

export const exitCode = {
    SUCCESS: 0,
    ERROR: 1,
    NEEDS_UPDATE: 2,
    TIMEOUT: 3,
    PRIVILEGE_REQUIRED: 126,
};

export function fileExists(path) {
    try {
        const f = Gio.File.new_for_path(path);
        return f.query_exists(null);
    } catch {
        return false;
    }
}

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

export function readFileInt(path) {
    try {
        const v = readFile(path);
        if (v)
            return parseInt(v);
        else
            return null;
    } catch {
        return null;
    }
}

export function readFileUri(path) {
    try {
        const f = Gio.File.new_for_uri(path);
        const [, contents] = f.load_contents(null);
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(contents);
    } catch {
        return null;
    }
}

export function findValidProgramInPath(program) {
    return GLib.find_program_in_path(program);
}

/**
 * Execute a command and return the result
 * Uses a queue to serialize execution of commands.
 * @param {string[]} argv - Command arguments
 * @param {boolean} enableTimeout - Whether to enable timeout (default: true)
 * @returns {Promise<[number, string|null, string|null]>} - [exitCode, stdout, stderr]
 */
export async function execCheck(argv, enableTimeout = true) {
    return _execCheckInternal(argv, enableTimeout);
}

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

        if (status !== 0 && stderr && stderr.length > 0) {
             console.debug(`Unified Power Manager: Command '${argv[0]}' failed with stderr: ${stderr.trim()}`);
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
 * @param {string} command - Command to execute
 * @param {...string} args - Command arguments
 * @returns {Promise<[number, string|null, string|null]>} - [exitCode, stdout, stderr]
 */
export async function runCommandCtl(ctlPath, command, ...args) {
    // Reject if queue is full to prevent unbounded growth
    if (_queueDepth >= MAX_QUEUE_DEPTH) {
        console.warn(`Unified Power Manager: Command queue full (${_queueDepth} pending), rejecting command: ${command}`);
        return [exitCode.ERROR, null, 'Command queue full - too many pending operations'];
    }

    const argv = ['pkexec', ctlPath, command, ...args.filter(arg => arg)];

    // Increment queue depth before queuing
    _queueDepth++;

    const task = _ctlQueue
        .catch(() => {}) // Ignore previous command failures
        .then(() => _execCheckInternal(argv, true))
        .finally(() => {
            // Decrement queue depth when command completes
            _queueDepth--;
        });

    _ctlQueue = task;
    return task;
}

export async function runCommand(argv) {
    const result = await execCheck(argv);
    return result;
}

export function destroyExecCheck() {
    // Reset the command queue to prevent stale commands from persisting
    // across extension enable/disable cycles
    _ctlQueue = Promise.resolve();
    _queueDepth = 0;
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
