# Unified Power Manager

A GNOME Shell extension providing unified Quick Settings control for power profiles and battery charging modes.

## Features

- **Power Profiles**: Switch between Performance, Balanced, and Power Saver modes
- **Battery Modes**: Control charging thresholds (Full Capacity, Balanced, Max Lifespan)
- **Profiles**: Pre-configured combinations (Docked, Travel) with auto-detection
- **Force Discharge**: Manual battery discharge control (ThinkPad only)
- **External Change Detection**: UI updates when settings change externally

## Installation

### 1. Install the extension

The extension files should already be in place at:
`~/.local/share/gnome-shell/extensions/unified-power-manager@zvi/`

### 2. Install helper components (requires root)

For battery threshold control, install the helper script:

```bash
sudo ./install-helper.sh
```

Or manually:

```bash
# Install helper script
sudo cp resources/unified-power-ctl /usr/local/bin/
sudo chmod +x /usr/local/bin/unified-power-ctl

# Install polkit rules (modern systems)
sudo cp resources/10-unified-power-manager.rules /etc/polkit-1/rules.d/

# OR for legacy polkit (< 0.106)
sudo cp resources/org.gnome.shell.extensions.unified-power-manager.policy /usr/share/polkit-1/actions/
```

### 3. Enable the extension

```bash
gnome-extensions enable unified-power-manager@zvi
```

Then log out and log back in, or restart GNOME Shell.

## Menu Layout

```
┌──────────────────────────────────────┐
│ [icon] Power Manager                 │
│         Docked                       │ ← Shows active profile
├──────────────────────────────────────┤
│ PROFILE                              │
│ ✓ Docked                             │
│   Travel                             │
├──────────────────────────────────────┤
│ POWER MODE                           │
│ ✓ Performance                        │
│   Balanced                           │
│   Power Saver                        │
├──────────────────────────────────────┤
│ BATTERY MODE                         │
│   Full Capacity (95-100%)            │
│ ✓ Max Lifespan (55-60%)              │
│   Balanced (75-80%)                  │
├──────────────────────────────────────┤
│ Battery: 67% • Charging inhibited    │
├──────────────────────────────────────┤
│ [switch] Force Discharge             │
└──────────────────────────────────────┘
```

## Profile Definitions

| Profile | Power Mode | Battery Mode |
|---------|------------|--------------|
| Docked  | Performance | Max Lifespan (55-60%) |
| Travel  | Balanced | Full Capacity (95-100%) |

Profiles are auto-detected when you manually set matching power and battery modes.

## Requirements

- GNOME Shell 46+
- ThinkPad laptop (for battery threshold control)
- `power-profiles-daemon` (for power profile control)

## Preferences

Open preferences with:
```bash
gnome-extensions prefs unified-power-manager@zvi
```

Configure:
- Threshold values for each battery mode
- Profile power/battery mode combinations
- UI visibility options

## Troubleshooting

### Extension doesn't load
Check for errors in GNOME Shell logs:
```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

### Battery thresholds not changing
1. Verify the helper is installed: `which unified-power-ctl`
2. Check polkit rules are in place
3. Test manually: `pkexec unified-power-ctl BAT0_END_START 60 55`

### Power profiles not working
1. Check power-profiles-daemon is running: `systemctl status power-profiles-daemon`
2. Test with: `powerprofilesctl list`

## License

GPL-3.0-or-later
