# Preferences

Open the preferences window:

```bash
gnome-extensions prefs hara-hachi-bu@ZviBaratz
```

Or find it in GNOME Extensions app → Hara Hachi Bu → Settings.

![Preferences window — General tab](assets/preferences.png)

## General

### User Interface

- **Show system indicator** — toggle the extension's panel indicator visibility
- **Show force discharge toggle** — show/hide the force discharge option in Quick Settings
- **Hide built-in power profile indicator** — remove GNOME's default power profile indicator from the panel (reduces clutter since this extension replaces its functionality)
- **Battery health display** — show maximum capacity as a color-coded percentage; configure the thresholds for Good/Fair/Poor ratings

### Battery Management

- **Automatic discharge to threshold** — when the battery is above the current threshold on AC, enable force discharge to bring it down (ThinkPad and compatible hardware only)
- **Boost charge timeout** — safety timeout for boost charge (1–12 hours, default 2 hours). The primary stop trigger is the battery reaching 100%; this is a fallback.

### Automatic Scenario Switching

- **Enable auto-switching** — turn on/off rule-based automatic profile activation
- **Resume on state change** — when auto-management is paused (after a manual override), automatically resume when a parameter changes (display, power source, lid)

## Thresholds {#thresholds}

Configure the charging percentage range for each battery mode.

On devices with both start and end threshold support (ThinkPad, Framework), you set both the start (when charging begins) and end (maximum charge) values.

On devices with only end threshold support (some ASUS models), only the maximum charge is configurable.

Default ranges:

| Mode | Start | End |
|------|-------|-----|
| Full Capacity | 95% | 100% |
| Balanced | 75% | 80% |
| Max Lifespan | 55% | 60% |

!!! tip
    The start threshold should always be at least 5% below the end threshold. If you set them too close together, the battery won't start charging until it drops very low.

## Scenarios

Create, edit, and delete profiles (scenarios). Each scenario combines:

- A name and icon
- Power mode and battery mode
- Optional force discharge setting
- Optional auto-switch rules
- Optional schedule

Built-in scenarios (Docked, Travel) can be customized or deleted. If you delete all built-in scenarios, a **Restore Default Scenarios** button appears.

### Export and Import

Use the **Export** and **Import** buttons at the top of the Scenarios page to save your profiles to a JSON file or load them from one. Useful for syncing configuration between machines.

## About

Displays:

- Extension version
- Helper script installation status and path
- Polkit configuration status
- Detected battery hardware (battery name, capacity, sysfs capabilities)

Use this tab to verify the extension is correctly set up on your system.
