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

Battery threshold control requires root privileges. GNOME extensions cannot install system files automatically, so you need to run a one-time setup script.

### Automated (recommended)

```bash
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
sudo ./install-helper.sh
```

The script copies `hhb-power-ctl` to `/usr/local/bin/` and installs the appropriate polkit rules for your system.

### Manual

```bash
# Install the helper script
sudo cp resources/hhb-power-ctl /usr/local/bin/
sudo chmod +x /usr/local/bin/hhb-power-ctl

# Install polkit rules (modern polkit >= 0.106)
sudo cp resources/10-hara-hachi-bu.rules /etc/polkit-1/rules.d/

# OR for legacy polkit (< 0.106)
sudo cp resources/org.gnome.shell.extensions.hara-hachi-bu.policy \
    /usr/share/polkit-1/actions/
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
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
sudo ./install-helper.sh --uninstall
```

To remove the extension itself, disable it and delete the directory:

```bash
gnome-extensions disable hara-hachi-bu@ZviBaratz
rm -rf ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
```
