---
name: Hardware Compatibility Report
about: Report whether your laptop works with Unified Power Manager
labels: hardware
---

## Laptop Information

- **Manufacturer and model:**
- **Kernel version** (`uname -r`):

## Battery Sysfs

```bash
# Run these commands and paste the output:
ls /sys/class/power_supply/BAT*/charge_control_*
cat /sys/class/power_supply/BAT*/charge_behaviour  # if it exists
ls /sys/class/power_supply/ | grep -v BAT
```

## Power Profiles

```bash
powerprofilesctl list
```

## Helper Script Test

```bash
# Test if the helper script works (sets threshold to 80, then revert):
pkexec unified-power-ctl BAT0_END 80
echo $?
cat /sys/class/power_supply/BAT0/charge_control_end_threshold
```

## Results

- **Threshold control works:** yes / no / partially
- **Force discharge works:** yes / no / not supported
- **Power profiles work:** yes / no

## Additional Notes

Any other observations about hardware compatibility.
