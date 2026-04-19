<p align="center">
  <img src="assets/hara-hachi-bu.png" alt="Hara Hachi Bu" width="360">
</p>

<h1 align="center">Hara Hachi Bu</h1>

<p align="center">
  <a href="https://github.com/ZviBaratz/hara-hachi-bu/actions/workflows/ci.yml"><img src="https://github.com/ZviBaratz/hara-hachi-bu/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL%203.0+-blue.svg" alt="License: GPL-3.0+"></a>
  <a href="metadata.json"><img src="https://img.shields.io/badge/GNOME%20Shell-46%20%7C%2047%20%7C%2048%20%7C%2049-blue" alt="GNOME Shell 46+"></a>
</p>

A GNOME Shell extension providing unified Quick Settings control for power profiles and battery charging modes on supported laptops (ThinkPad, Framework, ASUS, etc.).

> **Why "Hara Hachi Bu"?** 腹八分目 (_hara hachi bu_) is an Okinawan practice of eating until you're 80% full — a philosophy of intentional restraint that promotes longevity. This extension applies the same principle to your laptop battery.

## Features

- **Power Profiles**: Switch between Performance, Balanced, and Power Saver modes
- **Battery Modes**: Control charging thresholds (Full Capacity, Balanced, Max Lifespan)
- **Custom Profiles**: Combine power mode, battery mode, and force discharge into named scenarios
- **Rule-Based Auto-Switching**: Activate profiles automatically based on external display, power source, or lid state
- **Scheduled Profiles**: Time-based profile activation with per-day and time range control
- **Boost Charge**: One-click temporary charge to 100% with automatic revert
- **Battery Health Monitoring**: Color-coded maximum capacity display
- **Force Discharge**: Manual battery discharge control (on supported hardware)

## Installation

```bash
# Install from extensions.gnome.org (search "Hara Hachi Bu"), then install
# the privileged helper so polkit can authorize battery threshold writes:
EXT_DIR=~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
pkexec sh -c '
  install -D -m 755 "$0/resources/hhb-power-ctl" /usr/local/bin/hhb-power-ctl &&
  install -D -m 644 "$0/resources/10-hara-hachi-bu.rules" /etc/polkit-1/rules.d/10-hara-hachi-bu.rules &&
  install -D -m 644 "$0/resources/org.gnome.shell.extensions.hara-hachi-bu.policy" /usr/share/polkit-1/actions/org.gnome.shell.extensions.hara-hachi-bu.policy
' "$EXT_DIR"
```

This is a one-time setup. The Quick Settings panel will offer to copy this command to your clipboard when it detects the helper is missing.

**Manual installation:**

```bash
git clone https://github.com/ZviBaratz/hara-hachi-bu.git \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
glib-compile-schemas \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz/schemas/
gnome-extensions enable hara-hachi-bu@ZviBaratz
```

## Documentation

📚 **Full documentation at [ZviBaratz.github.io/hara-hachi-bu](https://ZviBaratz.github.io/hara-hachi-bu)**

Covers installation, quick start, battery modes, profiles, auto-switch rules, scheduled profiles, preferences, hardware compatibility, troubleshooting, and more.

## Compatibility

- **GNOME Shell**: 46, 47, 48, 49
- **Hardware**: Laptops with battery charge threshold support via standard Linux sysfs (ThinkPad, Framework, ASUS, and others)
- **Power Profiles**: Requires `power-profiles-daemon`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and pull request guidelines.

Issues and pull requests welcome at https://github.com/ZviBaratz/hara-hachi-bu

## License

GPL-3.0-or-later — see [LICENSE](LICENSE)

## Security

See [SECURITY.md](SECURITY.md) for the security model and how to report vulnerabilities.
