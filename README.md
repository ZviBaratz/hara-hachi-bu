# Unified Power Manager

A GNOME Shell extension providing unified Quick Settings control for power profiles and battery charging modes on ThinkPad laptops.

## Features

- **Power Profiles**: Switch between Performance, Balanced, and Power Saver modes
- **Battery Modes**: Control charging thresholds (Full Capacity, Balanced, Max Lifespan)
- **Profiles**: Pre-configured combinations (Docked, Travel) with auto-detection
- **Force Discharge**: Manual battery discharge control (ThinkPad only)
- **External Change Detection**: UI updates when settings change externally

## Compatibility

- **GNOME Shell**: 46, 47, 48
- **Hardware**: Lenovo ThinkPad laptops with battery threshold support
- **Power Profiles**: Requires `power-profiles-daemon`

## Installation

### From extensions.gnome.org

1. Visit [Unified Power Manager](https://extensions.gnome.org/extension/unified-power-manager/) on EGO
2. Click "Install"
3. **Important:** After installation, you must install the helper script to enable battery threshold control (see below).

### Manual Installation

```bash
# Clone or download to extensions directory
git clone https://github.com/zvi/unified-power-manager.git \
    ~/.local/share/gnome-shell/extensions/unified-power-manager@zvi

# Compile schemas
glib-compile-schemas ~/.local/share/gnome-shell/extensions/unified-power-manager@zvi/schemas/

# Enable the extension
gnome-extensions enable unified-power-manager@zvi
```

Then log out and log back in, or restart GNOME Shell (Alt+F2, type `r`, press Enter on X11).

### Helper Script Installation (Required for Battery Control)

Battery threshold control requires root privileges. Because GNOME Extensions cannot install system files automatically, you must run a one-time setup script.

1. Open a terminal
2. Navigate to the extension directory:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/unified-power-manager@zvi
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

## Security Model

This extension uses polkit for privilege escalation when modifying battery thresholds.

### Polkit Rules (Modern)

The rules file (`10-unified-power-manager.rules`) allows users in the `wheel` group to run the helper script without password prompts, but **only** for:
- Local sessions (not remote/SSH)
- Active sessions (currently logged in)

This is intentional for UX - constantly prompting for password when changing power modes would be disruptive. The trade-off is that any process running as your user in an active local session can change battery thresholds.

### Polkit Policy (Legacy)

The policy file allows active local users to run the helper without authentication (`<allow_active>yes</allow_active>`). Remote and inactive sessions require admin authentication.

### Helper Script Security

The `unified-power-ctl` script:
- Only accepts specific commands (BAT0_END, BAT0_START, etc.)
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
gnome-extensions prefs unified-power-manager@zvi
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
3. Test manually: `pkexec unified-power-ctl BAT0_END_START 60 55`
4. Check if your ThinkPad supports thresholds: `ls /sys/class/power_supply/BAT0/charge_control_*`

### Power profiles not working

1. Check power-profiles-daemon is running: `systemctl status power-profiles-daemon`
2. Test with: `powerprofilesctl list`

### Non-ThinkPad laptops

Battery threshold control only works on ThinkPad laptops with the `thinkpad_acpi` kernel module. Power profile switching works on any system with `power-profiles-daemon`.

## Building from Source

```bash
# Create release package
./package.sh

# The zip file can be uploaded to extensions.gnome.org
```

## License

GPL-3.0-or-later

## Contributing

Issues and pull requests welcome at https://github.com/zvi/unified-power-manager
