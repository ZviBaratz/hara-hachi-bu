# Unified Power Manager

[![CI](https://github.com/ZviBaratz/unified-power-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ZviBaratz/unified-power-manager/actions/workflows/ci.yml)
[![License: GPL-3.0+](https://img.shields.io/badge/License-GPL%203.0+-blue.svg)](LICENSE)
[![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%20%7C%2047%20%7C%2048-blue)](metadata.json)

A GNOME Shell extension providing unified Quick Settings control for power profiles and battery charging modes on supported laptops (ThinkPad, Framework, ASUS, etc.).

![Quick Settings panel screenshot](screenshots/quick-settings.png)

## Features

- **Power Profiles**: Switch between Performance, Balanced, and Power Saver modes
- **Battery Modes**: Control charging thresholds (Full Capacity, Balanced, Max Lifespan)
- **Custom Profiles**: Combine power mode, battery mode, and force discharge into named profiles
- **Rule-Based Auto-Switching**: Automatically activate profiles based on external display, power source, or lid state
- **Scheduled Profiles**: Time-based profile activation with per-day and time range control (e.g., charge to 100% weekday mornings)
- **Boost Charge**: One-click temporary charge to 100% with automatic revert on full battery, timeout, or AC disconnect
- **Battery Health Monitoring**: Color-coded maximum capacity display (Good/Fair/Poor)
- **Force Discharge**: Manual battery discharge control (on supported hardware)
- **Auto-Management**: Pauses on manual override, resumes on system state changes
- **External Change Detection**: UI updates when settings change externally

## Why Manage Battery Charging?

Lithium-ion batteries degrade faster when kept at high charge levels. Limiting the maximum charge — even slightly — can dramatically extend battery lifespan.

### Battery Science

Data from [Battery University][bu-808]:

| Peak Charge Voltage | Approx. Capacity | Cycle Life |
|---|---|---|
| 4.20 V (100%) | Full | 300–500 cycles |
| 4.10 V (~75%) | ~85% | 600–1,000 cycles |
| 4.00 V (~60%) | ~75% | 850–1,500 cycles |

Every 0.10 V reduction in peak charge voltage roughly doubles cycle life.

Depth of discharge matters too: cycling 100% of capacity yields ~300 cycles (NMC chemistry), while cycling only 40% yields ~1,000 cycles.

Storage conditions have a similar effect. A battery stored at 40% charge and 25°C retains 96% capacity after one year. At full charge and the same temperature, only 80% remains. At 40°C and full charge, capacity drops to 65%.

### Environmental Impact

Battery manufacturing produces 54–115 kg CO₂-eq per kWh of capacity, depending on chemistry and sourcing ([Nature Communications, 2024][nature-battery]). Around 80% of a notebook's total lifetime greenhouse gas emissions come from manufacturing, not use ([TCO Certified][tco]). Extending a laptop from 3 to 6 years of service roughly halves its annualized carbon footprint.

Globally, 62 million tonnes of e-waste were generated in 2022, with less than a quarter (22.3%) properly collected and recycled — leaving an estimated US $62 billion in recoverable materials unaccounted for ([UN Global E-Waste Monitor, 2024][ewaste]).

### Economic Impact

Laptop battery replacements cost $50–200 when available, but a degraded battery often prompts full laptop replacement ($300–850+). Charging within the 40–80% range can extend usable battery life from ~300–500 cycles (~2 years of daily cycling) to ~1,000–1,500+ cycles (~4–5 years).

### How This Extension Helps

| Battery Mode | Charge Range | Optimized For |
|---|---|---|
| Full Capacity | 95–100% | Maximum runtime when needed |
| Balanced | 75–80% | Good runtime with improved longevity |
| Max Lifespan | 55–60% | Maximum battery longevity |

Use **Max Lifespan** when working at a desk, and switch to **Full Capacity** before traveling — or let the built-in **Docked** and **Travel** profiles handle it automatically. For predictable schedules, set a **Scheduled Profile** to charge to full capacity on weekday mornings before you unplug. For ad-hoc needs, use the **Boost Charge** toggle.

[bu-808]: https://batteryuniversity.com/article/bu-808-how-to-prolong-lithium-based-batteries
[nature-battery]: https://www.nature.com/articles/s41467-024-54634-y
[tco]: https://tcocertified.com/news/using-a-notebook-computer-for-three-more-years-can-cut-emissions-in-half/
[ewaste]: https://ewastemonitor.info/the-global-e-waste-monitor-2024/

## Compatibility

- **GNOME Shell**: 46, 47, 48
- **Hardware**: Laptops with battery charge threshold support via standard Linux sysfs (e.g., ThinkPad, Framework, some ASUS/Dell)
- **Power Profiles**: Requires `power-profiles-daemon`

## Installation

### From extensions.gnome.org

Search for "Unified Power Manager" on [extensions.gnome.org](https://extensions.gnome.org/) and click "Install".

**Important:** After installation, you must install the helper script to enable battery threshold control (see below).

### Manual Installation

```bash
# Clone or download to extensions directory
git clone https://github.com/ZviBaratz/unified-power-manager.git \
    ~/.local/share/gnome-shell/extensions/unified-power-manager@baratzz

# Compile schemas
glib-compile-schemas ~/.local/share/gnome-shell/extensions/unified-power-manager@baratzz/schemas/

# Enable the extension
gnome-extensions enable unified-power-manager@baratzz
```

Then log out and log back in, or restart GNOME Shell (Alt+F2, type `r`, press Enter on X11).

### Helper Script Installation (Required for Battery Control)

Battery threshold control requires root privileges. Because GNOME Extensions cannot install system files automatically, you must run a one-time setup script.

1. Open a terminal
2. Navigate to the extension directory:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/unified-power-manager@baratzz
   ```
3. Run the installer:
   ```bash
   sudo ./install-helper.sh
   ```

Or manually:

```bash
# Install helper script
sudo cp resources/unified-power-ctl /usr/local/bin/
sudo chmod +x /usr/local/bin/unified-power-ctl

# Install polkit rules (modern systems with polkit >= 0.106)
sudo cp resources/10-unified-power-manager.rules /etc/polkit-1/rules.d/

# OR for legacy polkit (< 0.106)
sudo cp resources/org.gnome.shell.extensions.unified-power-manager.policy /usr/share/polkit-1/actions/
```

### Uninstallation

To remove the helper script and polkit rules:

```bash
cd ~/.local/share/gnome-shell/extensions/unified-power-manager@baratzz
sudo ./install-helper.sh --uninstall
```

## Security Model

This extension uses polkit for privilege escalation when modifying battery thresholds.

### Polkit Rules (Modern)

The rules file (`10-unified-power-manager.rules`) allows users in the `sudo` group to run the helper script without password prompts, but **only** for:
- Local sessions (not remote/SSH)
- Active sessions (currently logged in)

This is intentional for UX - constantly prompting for password when changing power modes would be disruptive. The trade-off is that any process running as your user in an active local session can change battery thresholds.

### Polkit Policy (Legacy)

The policy file allows active local users to run the helper without authentication (`<allow_active>yes</allow_active>`). Remote and inactive sessions require admin authentication.

### Helper Script Security

The `unified-power-ctl` script:
- Only accepts specific commands (BAT0 through BAT3: END, START, END_START, START_END, FORCE_DISCHARGE)
- Validates all threshold values (must be integers 0-100)
- Uses `set -eu` to fail fast on errors
- Only writes to specific sysfs paths

## Profiles & Auto-Switching

### Built-in Profiles

| Profile | Power Mode | Battery Mode | Force Discharge | Auto-Switch Rule |
|---------|-----------|--------------|-----------------|------------------|
| Docked  | Performance | Max Lifespan | On | External display connected |
| Travel  | Balanced | Full Capacity | Off | On battery power |

### Custom Profiles

Create custom profiles in Preferences → Profiles. Each profile combines:
- Power mode (Performance / Balanced / Power Saver)
- Battery mode (Full Capacity / Balanced / Max Lifespan)
- Force discharge (On / Off / Unspecified)
- Optional auto-switch rules

### Auto-Switch Rules

Rules use system parameters to activate profiles automatically:

| Parameter | Values |
|-----------|--------|
| External Display | Connected / Not Connected |
| Power Source | AC Power / Battery |
| Lid State | Open / Closed |

Profiles can have multiple conditions (all must match). When multiple profiles match, the most specific one wins (most conditions).

### Scheduled Profiles

Profiles can include an optional time schedule for automatic activation during specific time windows:

- **Day selection**: Choose individual days (Mon–Sun), or use quick-select buttons (Weekdays, Weekends, All)
- **Time range**: Set start and end times in 24-hour format
- **Overnight schedules**: Setting start time after end time (e.g., 23:00–07:00) creates an overnight window
- **Combined with rules**: A profile can have both rules and a schedule — both must match for it to activate
- **Schedule-only profiles**: A profile with only a schedule (no rules) activates purely based on time

Schedule adds +1 to profile specificity, so a profile with 2 rules + active schedule (specificity 3) beats a profile with only 2 rules (specificity 2).

**Example: Morning Charge**

Create a profile named "Morning Charge" with battery mode set to Full Capacity, enable auto-managed, and set a schedule for Weekdays 05:30–08:00. The extension charges to full overnight and reverts to your normal docked profile after 8am.

### Boost Charge

The **Boost Charge** toggle in the Quick Settings menu provides a one-click way to temporarily charge to 100%:

- Available only on AC power
- Temporarily overrides battery thresholds to 95–100% (or 100% for end-only devices)
- Pauses auto-management during boost
- Automatically deactivates when:
  - Battery reaches 100%
  - Safety timeout expires (configurable, default 4 hours)
  - AC power is disconnected
  - You manually change the battery mode
- On deactivation, auto-management resumes and selects the appropriate profile for current conditions

### Manual Override

When you manually change settings while auto-switching is active, auto-management pauses. It resumes when:
- A monitored parameter changes (display connected, power source switches, lid opens/closes)
- You click "Resume" in the Quick Settings menu

### Menu Layout

```
+--------------------------------------+
| [icon] Power Manager                 |
|         Docked                       | <- Shows active profile
+--------------------------------------+
| PROFILE                              |
| * Docked                             |
|   Travel                             |
+--------------------------------------+
| POWER MODE                           |
| * Performance                        |
|   Balanced                           |
|   Power Saver                        |
+--------------------------------------+
| BATTERY MODE                         |
|   Full Capacity (95-100%)            |
| * Max Lifespan (55-60%)              |
|   Balanced (75-80%)                  |
+--------------------------------------+
| Battery: 67% - Charging inhibited    |
+--------------------------------------+
| [switch] Force Discharge             |
+--------------------------------------+
| [switch] Boost Charge                |
+--------------------------------------+
```

## Creating Time-Based Profile Variants

You can create time-based variants of existing profiles that apply during specific windows, without triggering rule conflicts:

**Example: Docked + Morning Charging**

1. **Base profile — "Docked"**
   - Rules: External Display connected + AC Power
   - Settings: Performance, Max Lifespan (60%), Force Discharge On
   - Schedule: None (always active when rules match)

2. **Time variant — "Morning Charging"**
   - Rules: Same as Docked (External Display + AC Power)
   - Settings: Performance, Full Capacity (100%), Force Discharge Off
   - Schedule: Mon–Fri 07:00–09:00

**Result:** During weekday mornings the laptop charges to full so it's ready to unplug. Outside those hours the base Docked profile keeps the battery at 60%.

**How it works:**

- When two profiles share identical rules, a scheduled variant is automatically considered more specific than the unscheduled base.
- During the schedule window the variant wins; outside it the base profile applies as usual.
- No manual specificity calculations are needed — just add the same rules plus a schedule.

**Conflict prevention rules:**

- Same rules + one has a schedule, one does not → **No conflict** (scheduled wins during its window)
- Same rules + both scheduled with non-overlapping times → **No conflict**
- Same rules + both scheduled with overlapping times → **Conflict** (adjust time ranges to fix)
- Same rules + both unscheduled → **Conflict** (differentiate with rules or add a schedule)

## Preferences

Open preferences with:
```bash
gnome-extensions prefs unified-power-manager@baratzz
```

### General
- **UI**: Show/hide system indicator, force discharge toggle, built-in power profile indicator
- **Battery Health**: Enable health display with configurable severity threshold
- **Auto-Management**: Toggle auto-switch and resume-on-state-change behavior

### Thresholds
Configure start/stop charging percentages for each battery mode. Adapts to your hardware — devices with only an end threshold show a simplified view.

### Profiles
Create, edit, and delete profiles. Each profile combines a power mode, battery mode, and optional auto-switch rules. Built-in profiles (Docked, Travel) can be customized but not deleted. Profiles can also include a time schedule for automatic activation during specific windows.

### Boost Charge
Configure the safety timeout for boost charge (1–12 hours, default 4).

### About
Shows extension version, helper script installation status, polkit configuration, and detected battery hardware.

## Troubleshooting

### Extension doesn't load

Check for errors in GNOME Shell logs:
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Battery thresholds not changing

1. Verify the helper is installed: `which unified-power-ctl`
2. Check polkit rules are in place: `ls /etc/polkit-1/rules.d/`
3. Test manually: `pkexec unified-power-ctl BAT0_END_START 60 55` (or `BAT1_END_START` for BAT1)
4. Check if your laptop supports thresholds: `ls /sys/class/power_supply/BAT*/charge_control_*`

### Device Support

Battery threshold control works on any laptop that exposes standard charge control attributes in `/sys/class/power_supply/`. The extension automatically enumerates all batteries and supports multi-battery systems (BAT0 through BAT3 and beyond) with synchronized thresholds.

At minimum, `charge_control_end_threshold` is required; `charge_control_start_threshold` is optional (some devices like ASUS only support end threshold). This is common on ThinkPads (via `thinkpad_acpi`), Framework laptops, ASUS, and others running modern kernels.

### Power profiles not working

1. Verify `power-profiles-daemon` is installed and running: `systemctl status power-profiles-daemon`
2. Check available profiles: `powerprofilesctl list`
3. If the daemon is not installed, install it with your package manager (e.g., `sudo apt install power-profiles-daemon`)

## Building from Source

```bash
# Create release package
./package.sh

# The zip file can be uploaded to extensions.gnome.org
```

## License

GPL-3.0-or-later

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions,
and pull request guidelines.

Issues and pull requests welcome at https://github.com/ZviBaratz/unified-power-manager
