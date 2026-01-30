# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unified Power Manager is a GNOME Shell extension for ThinkPad laptops that provides unified Quick Settings control for power profiles and battery charging thresholds. It integrates with GNOME Shell's extension system and uses privileged operations via polkit for battery threshold control.

**Key Features:**
- Power profile management (Performance/Balanced/Power Saver) via power-profiles-daemon
- Battery charging threshold control (ThinkPad-specific via sysfs)
- Predefined profiles (Docked, Travel) with auto-detection
- Force discharge control for ThinkPads
- External change detection via file monitoring

## Development Commands

### Build and Test
```bash
# Compile GSettings schemas (required after schema changes)
glib-compile-schemas schemas/

# Enable the extension
gnome-extensions enable unified-power-manager@zvi

# Disable the extension
gnome-extensions disable unified-power-manager@zvi

# Restart GNOME Shell to reload extension (X11 only)
# Alt+F2, type 'r', press Enter

# View extension logs
journalctl -f -o cat /usr/bin/gnome-shell

# Open preferences UI
gnome-extensions prefs unified-power-manager@zvi
```

### Package for Distribution
```bash
# Create release zip for extensions.gnome.org
./package.sh

# Output: unified-power-manager@zvi.zip
# Note: Does NOT include resources/ directory (requires manual installation)
```

### Helper Script Installation
```bash
# Install privileged helper script and polkit rules (for battery threshold control)
sudo ./install-helper.sh

# Manual installation
sudo cp resources/unified-power-ctl /usr/local/bin/
sudo chmod +x /usr/local/bin/unified-power-ctl
sudo cp resources/10-unified-power-manager.rules /etc/polkit-1/rules.d/
```

### Testing Battery Thresholds
```bash
# Test helper script manually
pkexec unified-power-ctl BAT0_END_START 60 55

# Check current thresholds
cat /sys/class/power_supply/BAT0/charge_control_end_threshold
cat /sys/class/power_supply/BAT0/charge_control_start_threshold

# Check battery status
cat /sys/class/power_supply/BAT0/status
cat /sys/class/power_supply/BAT0/capacity
```

## Architecture

### Core Components

**extension.js** - Main entry point
- Extends GNOME Shell Extension class
- Manages lifecycle (enable/disable/session changes)
- Coordinates initialization of controllers and UI
- Handles built-in power profile indicator visibility
- Performs profile migration on first load

**lib/stateManager.js** - Central state coordinator
- Maintains current power mode, battery mode, and profile state
- Connects controller signals to emit unified state changes
- Handles all state mutations (setPowerMode, setBatteryMode, setProfile)
- Auto-detects profiles based on mode combinations
- Provides unified API for UI layer

**lib/powerProfileController.js** - Power profile management
- Communicates with power-profiles-daemon via D-Bus or CLI fallback
- Monitors ActiveProfile property changes for external updates
- Supports three modes: performance, balanced, power-saver
- Emits 'power-profile-changed' signal

**lib/batteryThresholdController.js** - Battery threshold management
- ThinkPad-specific: reads/writes to sysfs charge_control_* files
- Uses privileged helper script via pkexec for writes
- Monitors threshold files for external changes (Gio.FileMonitor)
- Handles threshold write ordering to avoid kernel errors
- Supports force discharge via charge_behaviour sysfs file
- Emits 'threshold-changed' and 'force-discharge-changed' signals

**lib/profileMatcher.js** - Profile detection and management
- Defines battery modes (full-capacity, balanced, max-lifespan) with threshold ranges
- Detects active profile from current power/battery mode combination
- Manages custom profiles (create/update/delete/validate)
- Stores profiles in JSON format in GSettings 'custom-profiles'
- Handles migration from old profile-docked/profile-travel format
- Validates profile IDs (must match /^[a-z0-9_-]+$/)

**lib/quickSettingsPanel.js** - Quick Settings UI integration
- Creates menu in GNOME Shell Quick Settings panel
- Radio button groups for profiles, power modes, battery modes
- Toggle for force discharge
- Battery status display

**lib/helper.js** - Utility functions
- File operations (fileExists, readFile, readFileInt)
- Command execution with mutex and timeout (execCheck)
- pkexec wrapper for privileged operations (runCommandCtl)
- PATH validation for security (findValidProgramInPath)

**prefs.js** - Preferences UI (GTK4/Adwaita)
- Battery mode threshold configuration
- Profile customization
- UI visibility settings

**resources/unified-power-ctl** - Privileged helper script
- Bash script that accepts validated commands for sysfs writes
- Commands: BAT0_END, BAT0_START, BAT0_END_START, BAT0_START_END, FORCE_DISCHARGE_BAT0
- Validates all input (integers 0-100, valid modes)
- Uses `set -eu` for error handling

### Critical Implementation Details

**Threshold Write Ordering**
Battery threshold changes must be written in the correct order to avoid kernel errors:
- If increasing thresholds (new start >= current end): write END first, then START
- If decreasing thresholds: write START first, then END
- Implementation: batteryThresholdController.js:190-192

**Signal Flow**
1. Controller detects change (D-Bus property change or file monitor event)
2. Controller emits specific signal (e.g., 'power-profile-changed')
3. StateManager receives signal, updates internal state
4. StateManager emits unified 'state-changed' signal
5. UI updates via StateManager event handlers

**External Change Detection**
- Power profiles: D-Bus property monitoring via g-properties-changed
- Battery thresholds: Gio.FileMonitor on BAT0_END_PATH with CHANGES_DONE_HINT
- Force discharge: Monitored via UPower Percentage property

**Privilege Escalation**
- Uses pkexec (polkit) for battery threshold writes
- Helper script installed in /usr/local/bin/ or extension resources/
- Polkit rules allow passwordless execution for wheel group in active local sessions
- Security: helper script validates all inputs, only writes to specific sysfs paths

**Session Management**
- Extension destroys UI during lock screen (unlock-dialog mode)
- Recreates UI when returning to user session
- Prevents panel operations during locked state

**Profile Migration**
- On first load, migrateProfilesToCustomFormat converts old profile-docked/profile-travel settings
- New format: JSON array in 'custom-profiles' with {id, name, powerMode, batteryMode, icon, builtin}
- Builtin profiles (docked, travel) cannot be deleted, only modified

## GSettings Schema

Location: `schemas/org.gnome.shell.extensions.unified-power-manager.gschema.xml`

Key settings:
- `custom-profiles`: JSON array of profile definitions
- `current-power-mode`: Current active power mode
- `current-battery-mode`: Current active battery mode
- `threshold-*-start/end`: Battery mode threshold values
- `force-discharge-enabled`: Force discharge toggle state
- `hide-builtin-power-profile`: Hide GNOME's built-in power profile indicator

## Hardware Compatibility

**Power Profiles**: Works on any system with power-profiles-daemon

**Battery Thresholds**: ThinkPad-specific requirements:
- thinkpad_acpi kernel module loaded
- /sys/devices/platform/thinkpad_acpi exists
- /sys/class/power_supply/BAT0/charge_control_start_threshold exists
- /sys/class/power_supply/BAT0/charge_control_end_threshold exists

**Force Discharge**: Requires /sys/class/power_supply/BAT0/charge_behaviour support

## Error Handling Patterns

- Controllers return boolean success/failure for operations
- StateManager shows user notifications via Main.notify() on errors
- Helper script uses exit codes (0=success, 1=error, 2=needs_update, 3=timeout)
- execCheck implements mutex to prevent concurrent command execution
- All async operations use try/catch and return safe defaults on failure

## Testing Considerations

- Extension must work without battery threshold support (non-ThinkPad systems)
- Power profile daemon may not be available (graceful degradation)
- Helper script may not be installed (show appropriate error)
- polkit rules may not be configured (operation fails with permission error)
- Handle external changes to thresholds and profiles correctly
