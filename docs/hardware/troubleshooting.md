# Troubleshooting

## Extension Doesn't Load

Check for errors in the GNOME Shell journal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Filter for extension-specific messages:

```bash
journalctl -o cat /usr/bin/gnome-shell --since "5 minutes ago" | grep -i hara-hachi-bu
```

Common causes:

- **Schema not compiled** — run `glib-compile-schemas ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz/schemas/`
- **GNOME Shell version mismatch** — check `metadata.json` for supported versions
- **JavaScript error** — the log will show the exact line

## Battery Thresholds Not Changing

Work through these checks in order:

**1. Verify the helper is installed**

```bash
which hhb-power-ctl
```

If not found, run the installer:

```bash
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
sudo ./install-helper.sh
```

**2. Check polkit rules**

```bash
ls /etc/polkit-1/rules.d/10-hara-hachi-bu.rules
```

If missing, reinstall the helper script. See [Installation](../installation.md).

**3. Test the helper manually**

```bash
pkexec hhb-power-ctl BAT0_END_START 60 55
```

For BAT1: use `BAT1_END_START`. If this fails, check the error message — it will indicate whether the issue is permissions, the sysfs path, or the helper script itself.

**4. Check hardware support**

```bash
ls /sys/class/power_supply/BAT0/charge_control_*
```

If no files are shown, your laptop's kernel driver does not expose battery threshold control. See [Hardware Compatibility](compatibility.md).

## Preferences → About Shows "Helper Not Found"

The helper script is not installed or not in PATH. Install it:

```bash
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
sudo ./install-helper.sh
```

If the installer reports a polkit warning, your system may use a non-standard polkit location. Check the install output for details.

## Power Profiles Not Working

**1. Check if `power-profiles-daemon` is running**

```bash
systemctl status power-profiles-daemon
```

**2. List available profiles**

```bash
powerprofilesctl list
```

**3. Install if missing**

```bash
# Debian/Ubuntu
sudo apt install power-profiles-daemon

# Fedora
sudo dnf install power-profiles-daemon
```

If `power-profiles-daemon` is not installed, the extension falls back to a CLI-based approach. Check the journal for fallback messages.

## Extension Resets Settings on Reload

Settings are stored in GSettings under `org.gnome.shell.extensions.hara-hachi-bu`. They persist across extension reloads and GNOME Shell restarts.

If settings appear to reset, check:

```bash
dconf read /org/gnome/shell/extensions/hara-hachi-bu/custom-profiles
```

If this returns an empty value, the schema may not be compiled correctly.

## Force Discharge Doesn't Work

Force discharge requires `charge_behaviour` support in your laptop's kernel driver. This is available on ThinkPad and a few other models.

Check:

```bash
cat /sys/class/power_supply/BAT0/charge_behaviour
```

If the file doesn't exist, your hardware doesn't support force discharge. The toggle will not appear in Quick Settings on unsupported hardware.

## Profiles Not Switching Automatically

If auto-switching isn't working as expected:

1. **Check that auto-management is enabled** — Preferences → General → Automatic Scenario Switching
2. **Check that profiles are marked Auto-managed** — Preferences → Scenarios → select the profile → enable Auto-managed
3. **Check that rules are correct** — verify the parameter, operator, and value for each rule
4. **Check for conflicts** — two profiles with identical rules at the same specificity will conflict; the extension will warn you in Preferences
5. **Check the journal** — the extension logs auto-switch decisions with the matching profile name

## Quick Settings Panel Doesn't Appear

If the extension is enabled but the Quick Settings section is missing:

1. Disable and re-enable the extension:
   ```bash
   gnome-extensions disable hara-hachi-bu@ZviBaratz
   gnome-extensions enable hara-hachi-bu@ZviBaratz
   ```
2. Log out and log back in (especially on Wayland — JS changes require a full session restart)
3. Check the journal for initialization errors
