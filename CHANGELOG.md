# Changelog

All notable changes to Hara Hachi Bu are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Conventional Commits](https://www.conventionalcommits.org/).

## [1.0.0] — 2026-02-23

First public release of Hara Hachi Bu, a GNOME Shell extension for unified Quick Settings control of power profiles and battery charging thresholds.

### Features

- **Power Profile Management**: Unified Quick Settings control for Performance, Balanced, and Power Saver profiles via power-profiles-daemon
- **Battery Charging Thresholds**: Configure start and end charging thresholds for supported laptops (ThinkPad, Framework, ASUS, etc.)
- **Predefined Profiles**: Built-in "Docked" and "Travel" profiles with automatic detection based on display and power source
- **Rule-Based Automatic Switching**: Create custom profiles with rules that auto-apply based on system parameters (external display, AC power, lid state, battery level)
- **Battery Level Rules**: Activate profiles when battery level rises above or falls below a threshold percentage. Includes ±2% hysteresis to prevent rapid switching at the boundary
- **Force Discharge**: Enable force discharge mode on supported hardware to manage battery health
- **Multi-Battery Support**: Support for systems with multiple batteries (BAT0, BAT1, BAT2, BAT3)
- **End-Only Device Support**: Works on devices with only end-charge threshold (no start threshold)
- **Battery Health Monitoring**: Display battery capacity and charging status in Quick Settings
- **External Change Detection**: Monitors external modifications to thresholds and power profiles
- **Preferences UI**: Configure battery modes, manage custom profiles, control visibility settings. Rule editor uses a SpinButton for numeric parameters (battery level)
- **Profile Export/Import**: Export profiles to a JSON file and import them on another machine via the Scenarios preferences page
- **Polkit Integration**: Secure privileged operations for battery threshold writes via pkexec

### Security

- Input validation and sanitization in privileged helper script with strict command whitelisting
- Polkit policy enforcement for battery threshold control operations
- Path canonicalization with realpath to prevent directory traversal attacks
- sysfs filename validation to restrict writes to approved battery control files
- Privileged helper script with strict error handling and exit codes
- Mutex protection for concurrent command execution to prevent race conditions

### Bug Fixes

- Fixed force discharge safety cutoff for profile-applied force discharge mode
- Fixed stale battery status display when force discharging
- Corrected signal accumulation in Quick Settings menu rebuild cycle
- Fixed invisible delete button in profile list
- Fixed profile switch and resume UI not updating with auto-switch enabled
- Fixed intermediate state during parallel profile/battery mode application
- Fixed end-only device detection and auto-discharge stop condition
- Corrected threshold write ordering to avoid kernel errors (END before START when increasing)
- Fixed zero-value battery level readings being treated as null
- Added destroyed guards to prevent callbacks on destroyed objects during extension reload
- Fixed D-Bus property changes not emitting signals for power profile updates
- Fixed UPower proxy initialization race condition in battery monitoring
- Fixed AC adapter detection to support non-standard adapter names
- Fixed duplicate signal emissions in power mode changes
- Fixed CSS class scoping to prevent style pollution to other extensions/UI
- Fixed dropdown accessibility properties in preferences (API compatibility)
- Fixed error label clearing in preferences when user edits fields
- Fixed loading state transitions and subtitle messages
- Corrected UTF-8 encoding and i18n format strings for translatable reordering

### Hardware Compatibility

- Auto-detection of battery devices from sysfs (supports multiple batteries)
- Graceful degradation for systems without battery threshold support
- Support for devices with start+end thresholds (ThinkPad, Framework) or end-only (ASUS)
- Support for force discharge via charge_behaviour file
- Power profile support via power-profiles-daemon on any distribution

### Usability Improvements

- Quick Settings menu with radio buttons for profiles, power modes, and battery modes
- Battery status display with capacity percentage and charging status
- Profile override mechanism with manual suspension and auto-resume timeout
- Loading states during async profile/mode application
- Clipboard feedback animation when copying helper installation command
- Threshold format display adapted for end-only devices (shows end threshold only)
- Prominent error notifications for misconfigured profiles
- Enhanced profile validation with clear error messages
- Boost charge countdown timer displayed in Quick Settings panel during active boost
- Battery mode "Moderate" renamed to "Balanced" for clarity

### Code Quality

- Async safety patterns with destroyed flags to prevent memory leaks
- Resource lifecycle management with proper cleanup of timeouts, signals, and monitors
- Comprehensive error handling in file operations, D-Bus communication, and async chains
- Module-level cache invalidation to ensure data consistency
- Ownership transfer patterns for object initialization with error recovery
- Try/catch protection for file monitors, rule evaluation, and dialog handlers
- Conditional signal connections to prevent duplicate handlers
- Defensive programming practices throughout initialization chains

### Documentation

- CONTRIBUTING.md with development commands and commit conventions
- CLAUDE.md with project architecture, critical implementation details, and async safety patterns
- Inline JSDoc comments for public methods and complex logic
- Hardware compatibility notes for ThinkPad, Framework, ASUS, and standard Linux sysfs devices
- Helper script and polkit installation instructions
- Testing guide with MockDevice for UI testing without hardware

### Translations

- Support for i18n via gettext with N\_() markers for compile-time extraction
- Proper translation handling for dual-context modules (extension + preferences)
- Translated error messages and user-facing strings
- RTL-safe styling in preferences and Quick Settings UI

[1.0.0]: https://github.com/ZviBaratz/hara-hachi-bu/releases/tag/v1.0.0
