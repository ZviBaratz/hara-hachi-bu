/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const EXEC_TIMEOUT_SECONDS = 5;

let execCheckRunning = false;
let execCheckTimerId = null;
let execCheckCancellable = null;

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
    const validPaths = [
        '/usr/local/sbin/',
        '/usr/local/bin/',
        '/usr/sbin/',
        '/usr/bin/',
        '/opt/',
        '/run/wrapper/bin/',
        '/run/current-system/sw/bin/',
        '/etc/profiles/per-user/',
    ];
    const path = GLib.find_program_in_path(program);
    if (path === null)
        return null;
    for (const basePath of validPaths) {
        if (path.startsWith(basePath))
            return path;
    }

    const validSymlinkedPath = `/home/${GLib.get_user_name()}/.nix-profile/bin/`;
    if (path.startsWith(validSymlinkedPath)) {
        const symlinkPath = GLib.file_read_link(path);
        if (symlinkPath.startsWith('/nix/store/') && symlinkPath.endsWith(`/${program}`))
            return symlinkPath;
    }

    return null;
}

/**
 * Execute a command and return the result
 * Note: This function uses a mutex to prevent concurrent execution.
 * If called while another command is running, returns ERROR immediately.
 * @param {string[]} argv - Command arguments
 * @param {boolean} enableTimeout - Whether to enable timeout (default: true)
 * @returns {Promise<[number, string|null]>} - [exitCode, stdout]
 */
export async function execCheck(argv, enableTimeout = true) {
    if (execCheckRunning)
        return [exitCode.ERROR, null];

    execCheckRunning = true;

    try {
        execCheckCancellable = new Gio.Cancellable();
        const flags = Gio.SubprocessFlags.STDOUT_PIPE |
                 Gio.SubprocessFlags.STDERR_PIPE;
        const proc = new Gio.Subprocess({
            argv,
            flags,
        });
        proc.init(null);

        // Guard to prevent race condition between timeout and process completion
        let resolved = false;
        const output = await new Promise(resolve => {
            const safeResolve = result => {
                if (resolved)
                    return;
                resolved = true;
                resolve(result);
            };

            if (enableTimeout) {
                execCheckTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EXEC_TIMEOUT_SECONDS, () => {
                    execCheckCancellable.cancel();
                    safeResolve([exitCode.TIMEOUT, null]);
                    execCheckTimerId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }
            proc.communicate_utf8_async(null, execCheckCancellable, (obj, res) => {
                try {
                    if (execCheckCancellable === null || execCheckCancellable.is_cancelled())
                        return;

                    const [, stdout] = obj.communicate_utf8_finish(res);
                    const status = obj.get_exit_status();
                    if (execCheckTimerId !== null) {
                        GLib.Source.remove(execCheckTimerId);
                        execCheckTimerId = null;
                    }
                    safeResolve([status, stdout]);
                } catch {
                    safeResolve([exitCode.ERROR, null]);
                }
            });
        });
        return output;
    } catch {
        return [exitCode.ERROR, null];
    } finally {
        execCheckRunning = false;
        execCheckCancellable = null;
    }
}

export async function runCommandCtl(ctlPath, command, ...args) {
    const argv = ['pkexec', ctlPath, command, ...args.filter(arg => arg)];
    const result = await execCheck(argv);
    return result;
}

export async function runCommand(argv) {
    const result = await execCheck(argv);
    return result;
}

export function destroyExecCheck() {
    if (execCheckTimerId !== null) {
        GLib.Source.remove(execCheckTimerId);
        execCheckTimerId = null;
    }
    if (execCheckCancellable !== null && !execCheckCancellable.is_cancelled()) {
        execCheckCancellable.cancel();
        execCheckCancellable = null;
    }
    execCheckRunning = false;
}
