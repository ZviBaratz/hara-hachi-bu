# Adding Support for New Hardware

Hara Hachi Bu uses a modular architecture to support different laptop vendors and battery control mechanisms. This document explains how to add support for a new device.

## Architecture

The extension uses a `DeviceManager` to detect and instantiate the appropriate device driver. All device drivers must inherit from `BaseDevice` and implement the required interface.

- **`lib/device/BaseDevice.js`**: The abstract base class defining the interface.
- **`lib/device/DeviceManager.js`**: The factory that selects the correct driver.
    - `lib/device/GenericSysfsDevice.js`: The default implementation for devices using standard Linux kernel battery interfaces (e.g., ThinkPads, Framework, ASUS). It supports devices with both start/end thresholds, as well as devices with only end thresholds.
      - **Auto-detection**: Automatically checks for `BAT0` and `BAT1` (in that order), using the first one that supports charge thresholds.

## Steps to Add a New Device

1.  **Check if you need a new device file**:
    - If your device exposes `/sys/class/power_supply/BAT0/charge_control_end_threshold`, it is likely already supported by `GenericSysfsDevice.js`.
    - Devices with both `charge_control_start_threshold` and `charge_control_end_threshold` get full threshold control.
    - Devices with only `charge_control_end_threshold` (e.g., some ASUS laptops) are supported with end-only control.
      - **Note**: End-only devices support battery mode auto-detection via end threshold range matching. The mode indicator reflects the current state based on the end threshold value.
    - Only create a new file if your device uses a completely different mechanism (e.g., a specific kernel module with non-standard paths).

2.  **Create a new device file** in `lib/device/` (if needed), e.g., `MyLegacyLaptop.js`.
3.  **Inherit from `BaseDevice`** and implement the required methods:
    - `initialize()`: Check if hardware is compatible. Return `true` if successful.
    - `static isSupported()`: Fast check (synchronous) if this driver applies to the current hardware.
    - `getThresholds()`: Return current start/end values.
    - `setThresholds(start, end)`: Write new values to hardware.
    - `getForceDischarge()` / `setForceDischarge(enabled)`: Optional, if supported.
4.  **Register the device** in `lib/device/DeviceManager.js`:
    - Import your new class.
    - Add a check in `DeviceManager.getDevice()` to return your device. Note: `GenericSysfsDevice` is checked last as a catch-all for standard devices. Insert your specific check before it if needed.

## Example Implementation

```javascript
import { BaseDevice } from './BaseDevice.js';

export const MyLaptop = GObject.registerClass({
    GTypeName: 'HHBMyLaptopDevice',
}, class MyLaptop extends BaseDevice {
    async initialize() {
        // Check for specific files or DMI vendor strings
        // Return true if compatible
    }

    static isSupported() {
        // Return true if this is a MyLaptop
        return false;
    }

    async setThresholds(start, end) {
        // Write to sysfs
        // You may need to extend the 'hhb-power-ctl' helper script
        // if root permissions are required.
    }
});
```

## Extending the Helper Script

If your device requires root privileges to write to sysfs files (which is common for battery thresholds), you should use the existing `hhb-power-ctl` script located in `resources/`.

1.  Modify `resources/hhb-power-ctl` to add a new command case for your hardware.
2.  **Security Warning**: Do not allow arbitrary paths to be passed to the script. Hardcode the paths in the script and select them via a command argument (e.g., `ASUS_LIMIT`, `DELL_MODE`).

## Testing Strategy

To test the UI and logic without access to specific hardware, you can use the **Mock Device**.

### Enabling Mock Mode

1.  Create a marker file in your config directory:
    ```bash
    mkdir -p ~/.config/hara-hachi-bu
    touch ~/.config/hara-hachi-bu/use_mock
    ```
2.  Reload the extension (log out/in or restart GNOME Shell).
3.  The extension will now use an in-memory mock battery controller. All changes will be logged to the system journal (view with `journalctl -f -o cat /usr/bin/gnome-shell`).

### Disabling Mock Mode

Simply remove the marker file:
```bash
rm ~/.config/hara-hachi-bu/use_mock
```
