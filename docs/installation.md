# Installation

## From extensions.gnome.org

Search for **"Hara Hachi Bu"** on [extensions.gnome.org](https://extensions.gnome.org/) and click **Install**.

!!! important
After installing the extension, you must also install the helper script to enable battery threshold control. See [Helper Script Installation](#helper-script-installation) below.

## Manual Installation

```bash
# Clone to the extensions directory
git clone https://github.com/ZviBaratz/hara-hachi-bu.git \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz

# Compile GSettings schemas
glib-compile-schemas \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz/schemas/

# Enable the extension
gnome-extensions enable hara-hachi-bu@ZviBaratz
```

Then log out and log back in (Wayland), or restart GNOME Shell with Alt+F2 → type `r` → Enter (X11 only).

## Helper Script Installation

Battery threshold control requires root privileges. GNOME extensions cannot install system files automatically, so you need to run a one-time install command.

### Recommended one-liner

```bash
EXT_DIR=~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
pkexec sh -c '
  install -D -m 755 "$0/resources/hhb-power-ctl" /usr/local/bin/hhb-power-ctl &&
  install -D -m 644 "$0/resources/10-hara-hachi-bu.rules" /etc/polkit-1/rules.d/10-hara-hachi-bu.rules &&
  install -D -m 644 "$0/resources/org.gnome.shell.extensions.hara-hachi-bu.policy" /usr/share/polkit-1/actions/org.gnome.shell.extensions.hara-hachi-bu.policy
' "$EXT_DIR"
```

The Quick Settings panel will offer to copy an equivalent command to your clipboard when it detects the helper is missing.

What each file does:

- `hhb-power-ctl` — the privileged helper invoked via `pkexec` to write battery thresholds.
- `10-hara-hachi-bu.rules` — polkit rules (≥ 0.106) that let the active local session run the helper without a password prompt.
- `org.gnome.shell.extensions.hara-hachi-bu.policy` — polkit policy action that maps the helper path to an action ID.

### Step-by-step (equivalent)

```bash
# Install the helper script
sudo install -D -m 755 \
    resources/hhb-power-ctl \
    /usr/local/bin/hhb-power-ctl

# Install polkit rules (polkit >= 0.106)
sudo install -D -m 644 \
    resources/10-hara-hachi-bu.rules \
    /etc/polkit-1/rules.d/10-hara-hachi-bu.rules

# Install polkit policy action (always required)
sudo install -D -m 644 \
    resources/org.gnome.shell.extensions.hara-hachi-bu.policy \
    /usr/share/polkit-1/actions/org.gnome.shell.extensions.hara-hachi-bu.policy
```

### Verify Installation

After installing, open the extension's **Preferences → About** tab to confirm the helper status shows as installed and polkit is configured.

You can also test manually:

```bash
pkexec hhb-power-ctl BAT0_END_START 60 55
```

## Uninstallation

To remove the helper script and polkit rules:

```bash
pkexec sh -c 'rm -f /usr/local/bin/hhb-power-ctl /etc/polkit-1/rules.d/10-hara-hachi-bu.rules /usr/share/polkit-1/actions/org.gnome.shell.extensions.hara-hachi-bu.policy'
```

To remove the extension itself, disable it and delete the directory:

```bash
gnome-extensions disable hara-hachi-bu@ZviBaratz
rm -rf ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
```
