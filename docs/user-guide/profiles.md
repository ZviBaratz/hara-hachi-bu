# Profiles

A **profile** (also called a _scenario_) is a named combination of power mode, battery mode, and optional force discharge setting. Activating a profile applies all settings at once.

## Built-in Profiles

Two profiles are included by default:

| Profile    | Power Mode  | Battery Mode  | Force Discharge | Auto-Switch Rule                           |
| ---------- | ----------- | ------------- | --------------- | ------------------------------------------ |
| **Docked** | Performance | Max Lifespan  | On              | External display connected AND on AC power |
| **Travel** | Balanced    | Full Capacity | Off             | On battery power                           |

These are fully customizable. You can edit or delete them in Preferences → Scenarios. If you delete them, a **Restore Default Scenarios** button appears to recreate them.

## Custom Profiles

Create your own profiles in **Preferences → Scenarios**. Each profile combines:

- **Name** — a label shown in Quick Settings and preferences
- **Icon** — one of the standard GNOME symbolic icons
- **Power mode** — Performance, Balanced, or Power Saver
- **Battery mode** — Full Capacity, Balanced, or Max Lifespan
- **Force discharge** — On, Off, or Unspecified (leave unchanged)
- **Auto-switch rules** — optional conditions that activate the profile automatically
- **Schedule** — optional time window for automatic activation

### Creating a Profile

![Preferences Scenarios page](../assets/preferences-scenarios.gif)

1. Open Preferences → Scenarios
2. Click the **+** button
3. Set the name, power mode, and battery mode
4. Optionally add rules or a schedule
5. Enable **Auto-managed** to activate the profile automatically when its rules match

### Exporting and Importing

Profiles can be exported to a JSON file and imported on another machine. Use the **Export** and **Import** buttons at the top of the Scenarios page.

## Activating a Profile

Click any profile button in Quick Settings to activate it immediately. This applies the profile's power mode, battery mode, and force discharge settings.

!!! note
Manually activating a profile while auto-management is enabled will **pause** auto-management. The next state change (display connected/disconnected, power source switch, lid open/close) will re-evaluate rules and resume auto-management. See [Manual Override](manual-override.md).

## Boost Charge

The **Boost Charge** toggle in Quick Settings provides a one-click way to temporarily charge to 100%.

**When to use it**: you're about to travel and want a full charge, but your normal profile uses Max Lifespan. Instead of manually switching modes (and forgetting to switch back), use Boost Charge — it reverts automatically.

### How It Works

1. Toggle Boost Charge in Quick Settings (AC power required)
2. The extension sets thresholds to 95–100% (or 0–100% on end-only devices)
3. Auto-management is paused
4. Charging proceeds normally to 100%

### Automatic Revert

Boost Charge deactivates automatically when any of these occur:

- Battery reaches 100%
- Safety timeout expires (default: 2 hours, configurable in Preferences → General)
- AC power is disconnected
- You manually change the battery mode

On deactivation, auto-management resumes and selects the appropriate profile for current conditions.

!!! tip
The primary stop trigger is the battery reaching 100%. The safety timeout is a fallback in case something prevents the battery-full signal from arriving.
