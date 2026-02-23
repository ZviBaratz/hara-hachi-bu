# Hardware Compatibility

## Overview

Hara Hachi Bu works with any laptop that exposes battery charge control via the standard Linux sysfs interface. No vendor-specific drivers or kernel patches required.

## Minimum Requirements

| Feature | Requirement |
|---------|-------------|
| Battery threshold control | `charge_control_end_threshold` in `/sys/class/power_supply/BAT*/` |
| Full threshold control (start + end) | Also requires `charge_control_start_threshold` |
| Force discharge | `charge_behaviour` in `/sys/class/power_supply/BAT*/` |
| Power profiles | `power-profiles-daemon` installed and running |

## Device Detection

The extension automatically enumerates batteries in `/sys/class/power_supply/`. If enumeration fails, it falls back to checking BAT0, BAT1, BAT2, BAT3 in order. The first battery with `charge_control_end_threshold` is used as the primary control device.

Multi-battery systems (BAT0 through BAT3) are fully supported with synchronized thresholds.

## Known Compatible Hardware

### Full Support (start + end threshold)

- **ThinkPad** — via `thinkpad_acpi` kernel module (all modern models)
- **Framework** — via standard kernel interfaces
- **Some Dell models** — depends on kernel version and model

### End-Only Support

- **ASUS** — many models expose only `charge_control_end_threshold`; end-only devices are fully supported including battery mode auto-detection based on the end threshold value

!!! note
    End-only devices display a simplified view in Preferences → Thresholds (no start threshold slider).

## Checking Your Hardware

```bash
# Check for threshold support
ls /sys/class/power_supply/BAT0/charge_control_*

# Typical output on ThinkPad / Framework:
# /sys/class/power_supply/BAT0/charge_control_end_threshold
# /sys/class/power_supply/BAT0/charge_control_start_threshold

# ASUS (end-only):
# /sys/class/power_supply/BAT0/charge_control_end_threshold

# Check force discharge support
ls /sys/class/power_supply/BAT0/charge_behaviour
```

## AC Adapter Detection

The extension automatically detects the AC adapter by checking these known names in order: `AC`, `ACAD`, `ADP0`, `ADP1`. The first available adapter is used for power source detection.

## Power Profiles

Power profile switching requires `power-profiles-daemon`. Check if it's installed and running:

```bash
systemctl status power-profiles-daemon
powerprofilesctl list
```

If not installed:

```bash
# Debian/Ubuntu
sudo apt install power-profiles-daemon

# Fedora
sudo dnf install power-profiles-daemon
```

## Adding Support for New Hardware

The extension uses a modular device backend architecture. If your device uses a completely different mechanism (not standard sysfs paths), you can add a new backend.

### When You Don't Need a New Backend

If your device exposes `/sys/class/power_supply/BAT0/charge_control_end_threshold`, it is already supported by the built-in `GenericSysfsDevice` implementation.

### Creating a New Backend

1. Create a new file in `lib/device/` (e.g., `MyLaptopDevice.js`)
2. Inherit from `BaseDevice` and implement the required methods:

```javascript
import { BaseDevice } from './BaseDevice.js';

export const MyLaptopDevice = GObject.registerClass({
    GTypeName: 'HHBMyLaptopDevice',
}, class MyLaptopDevice extends BaseDevice {
    async initialize() {
        // Check for specific files or DMI strings
        // Return true if compatible
    }

    static isSupported() {
        // Synchronous check — return true if this is a MyLaptop
        return false;
    }

    async setThresholds(start, end) {
        // Write to sysfs
        // Use hhb-power-ctl if root permissions are required
    }
});
```

3. Register your device in `lib/device/DeviceManager.js` before the `GenericSysfsDevice` catch-all.

### Extending the Helper Script

If root privileges are needed, extend `resources/hhb-power-ctl`:

1. Add a new command case for your hardware
2. **Security note**: Hardcode the sysfs paths in the script — do not pass arbitrary paths as arguments

See [Contributing](../contributing.md) for how to submit the new backend.

## Mock Mode (Testing Without Hardware)

To test the UI without real battery hardware:

```bash
mkdir -p ~/.config/hara-hachi-bu
touch ~/.config/hara-hachi-bu/use_mock
```

Reload the extension. All threshold changes will be simulated in-memory and logged to the journal. Remove the file to return to real hardware.
