# Unified Power Manager

[![CI](https://github.com/ZviBaratz/unified-power-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ZviBaratz/unified-power-manager/actions/workflows/ci.yml)
[![License: GPL-3.0+](https://img.shields.io/badge/License-GPL%203.0+-blue.svg)](LICENSE)
[![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%20%7C%2047%20%7C%2048-blue)](metadata.json)

A GNOME Shell extension providing unified Quick Settings control for power profiles and battery charging modes on supported laptops (ThinkPad, Framework, ASUS, etc.).

## Features

- **Power Profiles**: Switch between Performance, Balanced, and Power Saver modes
- **Battery Modes**: Control charging thresholds (Full Capacity, Balanced, Max Lifespan)
- **Profiles**: Pre-configured combinations (Docked, Travel) with auto-detection
- **Force Discharge**: Manual battery discharge control (ThinkPad only)
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

Use **Max Lifespan** when working at a desk, and switch to **Full Capacity** before traveling — or let the built-in **Docked** and **Travel** profiles handle it automatically.

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

1. Visit [Unified Power Manager on extensions.gnome.org](https://extensions.gnome.org/extension/unified-power-manager/) or search for "Unified Power Manager"
2. Click "Install"
3. **Important:** After installation, you must install the helper script to enable battery threshold control (see below).

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
- Only accepts specific commands (BAT0_END, BAT0_START, BAT1_END, BAT1_START, etc.)
- Validates all threshold values (must be integers 0-100)
- Uses `set -eu` to fail fast on errors
- Only writes to specific sysfs paths

## Menu Layout

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
```

## Profile Definitions

| Profile | Power Mode | Battery Mode |
|---------|------------|--------------|
| Docked  | Performance | Max Lifespan (55-60%) |
| Travel  | Balanced | Full Capacity (95-100%) |

Profiles are auto-detected when you manually set matching power and battery modes.

## Preferences

Open preferences with:
```bash
gnome-extensions prefs unified-power-manager@baratzz
```

Configure:
- Threshold values for each battery mode
- Profile power/battery mode combinations
- UI visibility options (indicator, force discharge toggle)

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
