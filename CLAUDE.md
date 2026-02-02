# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unified Power Manager is a GNOME Shell extension that provides unified Quick Settings control for power profiles and battery charging thresholds. It supports any laptop with standard Linux sysfs battery control interfaces (ThinkPad, Framework, ASUS, etc.). It integrates with GNOME Shell's extension system and uses privileged operations via polkit for battery threshold control.

**Key Features:**
- Power profile management (Performance/Balanced/Power Saver) via power-profiles-daemon
- Battery charging threshold control via standard sysfs interface (supports devices with start+end thresholds or end-only)
- Predefined profiles (Docked, Travel) with auto-detection
- Force discharge control (on supported hardware)
- External change detection via file monitoring
- Modular device backend architecture for hardware-specific implementations

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
# Note: The resources/ directory IS included in the zip, but the helper script
# and polkit files require manual installation to system paths.
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

**lib/batteryThresholdController.js** - High-level controller
- Manages battery state monitoring (UPower + sysfs fallback)
- Delegates threshold control to the active device instance
- Smart fallback: If no control device found, auto-detects BAT0/BAT1 for basic monitoring
- Signals: `threshold-changed`, `battery-status-changed`, `force-discharge-changed`

**lib/device/DeviceManager.js** - Device detection and instantiation
- Factory class that detects hardware and returns appropriate device backend
- Auto-detects battery: checks BAT0 first, falls back to BAT1 if not found
- Checks for mock trigger file for testing scenarios
- Falls back through device implementations in priority order

**lib/device/BaseDevice.js** - Abstract device interface
- GObject-based class defining the device API contract
- Signals: 'threshold-changed', 'force-discharge-changed'
- Methods: initialize(), getThresholds(), setThresholds(), getForceDischarge(), setForceDischarge()
- Properties: supportsForceDischarge, needsHelper, hasStartThreshold

**lib/device/GenericSysfsDevice.js** - Standard sysfs battery control
- Implements battery threshold control via standard Linux sysfs paths
- Supports devices with both start+end thresholds (ThinkPad, Framework) or end-only (ASUS)
- Uses privileged helper script via pkexec for writes
- Monitors threshold files for external changes (Gio.FileMonitor)
- Handles threshold write ordering to avoid kernel errors
- Supports force discharge via charge_behaviour sysfs file

**lib/device/MockDevice.js** - Testing device
- In-memory implementation for UI testing without hardware
- Enabled by creating `~/.config/unified-power-manager/use_mock` file

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
- BAT0 Commands: BAT0_END, BAT0_START, BAT0_END_START, BAT0_START_END, FORCE_DISCHARGE_BAT0
- BAT1 Commands: BAT1_END, BAT1_START, BAT1_END_START, BAT1_START_END, FORCE_DISCHARGE_BAT1
- BAT2 Commands: BAT2_END, BAT2_START, BAT2_END_START, BAT2_START_END, FORCE_DISCHARGE_BAT2
- BAT3 Commands: BAT3_END, BAT3_START, BAT3_END_START, BAT3_START_END, FORCE_DISCHARGE_BAT3
- Validates all input (integers 0-100, valid modes)
- Uses `set -eu` for error handling
- Exit codes: 0=success, 1=error (EXIT_NEEDS_UPDATE=2 reserved for future use)

### Critical Implementation Details

**Threshold Write Ordering**
Battery threshold changes must be written in the correct order to avoid kernel errors:
- If increasing thresholds (new start >= current end): write END first, then START
- If decreasing thresholds: write START first, then END
- Implementation: lib/device/GenericSysfsDevice.js setThresholds() method

**Signal Flow**
1. Controller detects change (D-Bus property change or file monitor event)
2. Controller emits specific signal (e.g., 'power-profile-changed')
3. StateManager receives signal, updates internal state
4. StateManager emits unified 'state-changed' signal
5. UI updates via StateManager event handlers

**External Change Detection**
- Power profiles: D-Bus property monitoring via g-properties-changed
- Battery thresholds: Gio.FileMonitor on charge_control_end_threshold with CHANGES_DONE_HINT
- Force discharge: Monitored via UPower Percentage property

**Privilege Escalation**
- Uses pkexec (polkit) for battery threshold writes
- Helper script installed in /usr/local/bin/ or extension resources/
- Polkit rules allow passwordless execution for sudo group in active local sessions
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

**Battery Thresholds**: Works on laptops with standard Linux sysfs battery control:
- Auto-detects battery: checks BAT0 first, falls back to BAT1
- Minimum requirement: charge_control_end_threshold exists for the detected battery
- Full support (start+end): Also requires charge_control_start_threshold
- Known compatible: ThinkPad (thinkpad_acpi), Framework, ASUS, and others with standard kernel interfaces

**Force Discharge**: Requires charge_behaviour support for the detected battery (typically ThinkPad)

## Recent Improvements (Commit 517cd2b)

### Critical Bug Fixes

**PowerProfileController Signal Emission**
- Fixed missing signal emission after D-Bus profile assignment
- Ensures UI updates immediately after profile changes via D-Bus

**UPower Proxy Race Condition**
- BatteryThresholdController now initializes `_onBattery` from sysfs to prevent race condition
- Resolves issues where battery status was unavailable during early initialization

**Command Queue Reset**
- Helper now resets global command queue on extension disable
- Prevents stale commands from executing after extension reload

**Battery Health Calculation**
- Fixed energy_* and charge_* metric mixing in GenericSysfsDevice
- Health percentage now calculated correctly for all battery types

**Force Discharge Parsing**
- Improved parsing with robust fallback handling for various charge_behaviour formats
- Better compatibility across different kernel/hardware implementations

**Display Event Debouncing**
- StateManager now debounces display events (500ms) to prevent race conditions
- Fixes issues with rapid display on/off cycles triggering duplicate operations

### Hardware Support Enhancements

**Multi-Battery Systems**
- unified-power-ctl now supports BAT2 and BAT3 in addition to BAT0 and BAT1
- Commands: BAT2_END, BAT2_START, BAT2_END_START, BAT2_START_END, FORCE_DISCHARGE_BAT2
- Commands: BAT3_END, BAT3_START, BAT3_END_START, BAT3_START_END, FORCE_DISCHARGE_BAT3
- Full support for systems with 3-4 batteries

**End-Only Device Support**
- ProfileMatcher now supports battery mode detection on devices with only end threshold
- Previously, devices like ASUS laptops couldn't auto-detect battery modes
- Uses end threshold value and range matching for mode detection

**Polkit Installation Validation**
- install-helper.sh now checks if polkit rules were installed successfully
- Shows warnings if polkit installation fails (e.g., polkit not installed or custom location)

### Error Handling and Diagnostics

**Stderr Logging**
- execCheck() now returns stderr in result tuple `[status, stdout, stderr]`
- Better diagnostic information when commands fail
- Used in GenericSysfsDevice and PowerProfileController for troubleshooting

**User Notifications**
- StateManager now notifies users when auto-switch profiles are misconfigured
- Displays helpful error messages for partial profile application failures
- Improves discoverability of configuration issues

**Enhanced Profile Validation**
- ProfileMatcher validates icon field in custom profiles
- Enforces builtin flag for system profiles
- Trims whitespace from profile names during validation

### UX Improvements

**Clipboard Feedback Animation**
- QuickSettingsPanel shows visual feedback when copying install command
- Label temporarily changes to "Copied! Paste in terminal" with success styling
- Provides immediate confirmation without waiting for notification

**Loading States**
- Quick Settings now shows loading messages during profile/mode application
- Subtitle displays "Applying [profile name]..." or "Setting [mode]..."
- Prevents confusion during async operations

**Profile ID Preview**
- Preferences UI now shows live preview of profile ID during creation
- Helps users understand how profile names are converted to IDs
- Prevents surprises with auto-generated IDs

## Error Handling Patterns

- Controllers return boolean success/failure for operations
- StateManager shows user notifications via Main.notify() on errors
- Helper script uses exit codes (0=success, 1=error, 2=needs_update, 3=timeout)
- execCheck implements mutex to prevent concurrent command execution
- All async operations use try/catch and return safe defaults on failure

## Testing Considerations

- Extension must work without battery threshold support (unsupported hardware)
- Extension must handle devices with only end threshold (no start threshold)
  - End-only devices now support battery mode auto-detection via end threshold range matching
- Power profile daemon may not be available (graceful degradation)
- Helper script may not be installed (show appropriate error, read-only mode)
- polkit rules may not be configured (operation fails with permission error)
- Handle external changes to thresholds and profiles correctly
- Use MockDevice for UI testing: create `~/.config/unified-power-manager/use_mock` file
- Test multi-battery systems (BAT2, BAT3 support added in commit 517cd2b)
