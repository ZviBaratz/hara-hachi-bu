---
name: upm-dev
description: Use when reviewing code, planning features, refactoring, debugging extension lifecycle issues, adding device support, or checking GNOME/EGO compliance. Covers architecture rules, signal flow, privilege escalation, and cleanup patterns.
---

# Unified Power Manager - Development Skill

Read `CLAUDE.md` first for implementation details. This skill provides architectural rules and review heuristics.

## Architecture Overview

```
extension.js           → Lifecycle (enable/disable)
lib/stateManager.js    → Single Source of Truth for state
lib/*Controller.js     → Hardware abstraction (D-Bus, sysfs)
lib/device/*.js        → Vendor-specific implementations
lib/quickSettingsPanel.js → UI (reads from StateManager only)
```

## Core Rules

### 1. Hardware Abstraction

**Rule:** Hardware-specific logic belongs ONLY in `lib/device/` classes.

**Adding device support:**
1. Create `lib/device/MyDevice.js` extending `BaseDevice`
2. Implement: `initialize()`, `static isSupported(path)`, `getThresholds()`, `setThresholds(start, end)`
3. Register in `DeviceManager.getDevice()`
4. If new sysfs writes needed, update `resources/unified-power-ctl`

### 2. Signal Flow (Unidirectional)

```
UI → StateManager → Controllers → Devices
                ↑__________________________|
                      (signals bubble up)
```

- UI must NOT import DeviceManager or call helper.js directly
- Controllers emit signals; StateManager aggregates and emits `state-changed`
- External changes detected via file monitors/D-Bus, flow up through signals

### 3. Extension Lifecycle

Every resource in `enable()` must be released in `disable()`:

| Resource | Cleanup |
|----------|---------|
| Signals | `obj.disconnectObject(this)` |
| Timeouts | `GLib.Source.remove(id)` |
| File monitors | `monitor.cancel()` |
| Command queue | `Helper.destroyExecCheck()` |

**Async safety:** Check `this._destroyed` after every `await`.

### 4. Privilege Escalation

- All sysfs writes go through `resources/unified-power-ctl` via pkexec
- NEVER pass user-controlled paths to the helper script
- New write operations require updates to both the script and polkit policy

## Code Review Checklist

When reviewing or refactoring, check for:

1. **Blocking I/O** — Use `Helper.readFile()` or `execCheck()`, never sync methods
2. **Hardcoded paths** — Sysfs paths belong in device classes or helper script
3. **Race conditions** — Look for unguarded async gaps; use `_writeInProgress` pattern
4. **Missing cleanup** — Every `connectObject` needs matching `disconnectObject`
5. **Type safety** — Validate sysfs output before arithmetic (`readFileInt` returns `null` on failure)
6. **Event debouncing** — Rapid events (display changes, battery level) need debouncing (see pattern below)

## Debouncing Pattern

Used for rapid events (display changes, battery level):

```javascript
_scheduleEvent() {
    if (this._timeout) GLib.Source.remove(this._timeout);
    this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
        this._timeout = null;
        this._processEvent();
        return GLib.SOURCE_REMOVE;
    });
}
```

## Testing

**When testing UI changes** → Use MockDevice for rapid iteration:

```bash
touch ~/.config/unified-power-manager/use_mock
```

Good for: Quick Settings layout, profile switching logic, preferences UI, state transitions, signal flow.

**When testing hardware interaction** → Use real hardware:

Required for: Device backend validation, privilege escalation testing, sysfs file I/O, file monitor behavior, threshold write ordering, force discharge modes.

**When testing controller logic** → Either works depending on what you're testing:
- StateManager coordination: MockDevice sufficient
- Actual D-Bus/sysfs calls: Real hardware required

Development commands: `make schemas`, `make nested`, `make logs`

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Fails after disable/enable | Resource leak | Audit `destroy()` methods for uncancelled monitors/timeouts |
| UI not updating after mode change | Missing signal emission | Check controller → StateManager signal chain |
| Thresholds not applying | Wrong write order | Check `_END_START` vs `_START_END` in device class |
| Permission denied on threshold write | Polkit missing | Run `sudo ./install-helper.sh` |
| High memory usage over time | Leaked timeouts/monitors | Add cleanup in `destroy()` and check `_destroyed` flag |
| Panel appears then disappears | UI created during lock | Check session mode in `_onSessionModeChanged` |
| Force discharge not working | Unsupported hardware or wrong sysfs path | Verify `charge_behaviour` file exists and accepts mode |