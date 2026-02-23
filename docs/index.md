---
title: Hara Hachi Bu
hide:
  - navigation
  - toc
---

<div class="hhb-hero">
  <p class="hhb-hero-kanji">腹八分目</p>
  <h1>Hara Hachi Bu</h1>
  <p class="hhb-hero-tagline">
    Unified Quick Settings control for power profiles and battery charging on GNOME Shell —
    inspired by the Okinawan art of intentional restraint.
  </p>
  <div class="hhb-hero-buttons">
    <a href="installation/" class="md-button md-button--primary">Get Started</a>
    <a href="quick-start/" class="md-button">Quick Start →</a>
  </div>
</div>

A GNOME Shell extension for ThinkPad, Framework, ASUS, and any laptop with standard Linux battery controls. One menu to manage everything: power profiles, charging thresholds, named profiles, auto-switch rules, and scheduled charging windows.

> **Why "Hara Hachi Bu"?** 腹八分目 is an Okinawan practice of eating until you're 80% full — a philosophy of intentional restraint that promotes longevity. This extension applies the same principle to your laptop battery: stop charging before 100% to extend its lifespan.

---

## What It Does

Hara Hachi Bu adds a unified section to your GNOME Quick Settings panel where you can:

- **Switch power profiles** — Performance, Balanced, Power Saver
- **Control battery charging** — limit charge to 60%, 80%, or 100%
- **Activate scenarios** — named combinations like Docked or Travel
- **Automate everything** — rules based on display, power source, lid, or battery level
- **Schedule profiles** — charge to full on weekday mornings, revert automatically
- **Boost charge** — one-click to 100% with automatic revert

## Key Features

| Feature | Description |
|---------|-------------|
| Power Profiles | Performance / Balanced / Power Saver via `power-profiles-daemon` |
| Battery Modes | Full Capacity (95–100%), Balanced (75–80%), Max Lifespan (55–60%) |
| Custom Scenarios | Named combinations of power + battery mode + optional force discharge |
| Rule-Based Auto-Switch | External display, power source, lid state, battery level |
| Scheduled Profiles | Per-day + time range, overnight support, DST-safe |
| Boost Charge | AC-only, auto-reverts on full battery / timeout / AC disconnect |
| Battery Health | Color-coded maximum capacity display |
| Force Discharge | ThinkPad and compatible hardware |
| Multi-Battery | BAT0 through BAT3 supported |

## Quick Install

```bash
# 1. Install from extensions.gnome.org (search "Hara Hachi Bu")
# 2. Then install the required helper script:
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
sudo ./install-helper.sh
```

See [Installation](installation.md) for full details — manual install, polkit setup, and uninstallation.

## Where to Go Next

| Goal | Page |
|------|------|
| New user, first time setup | [Quick Start](quick-start.md) |
| Understand battery modes and the science | [Battery Modes](user-guide/battery-modes.md) |
| Set up Docked / Travel scenarios | [Scenarios](user-guide/profiles.md) |
| Auto-switch based on display or power source | [Auto-Switch Rules](user-guide/rules.md) |
| Schedule charging windows | [Scheduled Profiles](user-guide/schedules.md) |
| Configure thresholds and preferences | [Preferences](preferences.md) |
| Check if your hardware is supported | [Hardware Compatibility](hardware/compatibility.md) |

## Compatibility

- **GNOME Shell**: 46, 47, 48, 49
- **Hardware**: Any laptop exposing `charge_control_end_threshold` in `/sys/class/power_supply/`
- **Power Profiles**: Requires `power-profiles-daemon`
