# Quick Start

Get up and running in five minutes.

## Step 1: Install the Extension

**Option A — extensions.gnome.org (recommended)**

Search for "Hara Hachi Bu" on [extensions.gnome.org](https://extensions.gnome.org/) and click Install.

**Option B — Manual**

```bash
git clone https://github.com/ZviBaratz/hara-hachi-bu.git \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
glib-compile-schemas \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz/schemas/
gnome-extensions enable hara-hachi-bu@ZviBaratz
```

Log out and log back in to activate the extension (required on Wayland).

## Step 2: Install the Helper Script

Battery threshold control requires a privileged helper. Run this once:

```bash
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
sudo ./install-helper.sh
```

!!! note
Without the helper script, you can still use power profiles — but battery threshold control (the core feature) will not work.

## Step 3: Open Quick Settings

Click the system tray area in the top-right corner of your screen to open Quick Settings. You should see a new section with:

- A row of profile buttons (Docked, Travel, and any custom profiles)
- Power mode selector (Performance / Balanced / Power Saver)
- Battery mode selector (Full Capacity / Balanced / Max Lifespan)
- Battery health and status information

![Quick Settings panel](assets/quick-settings.gif)

## Step 4: Try a Profile

If you're at a desk with an external display connected, click **Docked**. The extension will:

1. Switch to Performance power mode
2. Set battery charging to Max Lifespan (55–60%)
3. Enable force discharge if your hardware supports it

Going on a trip? Click **Travel** to switch to Balanced power mode and Full Capacity charging (up to 100%).

!!! tip
The Docked and Travel profiles have built-in auto-switch rules. If auto-management is enabled, the extension activates the right profile automatically based on whether an external display is connected and whether you're on AC power.

## Step 5: Configure Your Thresholds

Open Preferences to customize the charging percentages for each mode:

```bash
gnome-extensions prefs hara-hachi-bu@ZviBaratz
```

In the **Thresholds** tab, you'll see sliders (or spinners) for each battery mode:

| Mode          | Default Range | What to adjust                         |
| ------------- | ------------- | -------------------------------------- |
| Full Capacity | 95–100%       | Raise start if you want a wider window |
| Balanced      | 75–80%        | Good default for most users            |
| Max Lifespan  | 55–60%        | Lower end if you're always at a desk   |

## What's Next?

- **Custom profiles** — Create your own in Preferences → Scenarios. See [Profiles](user-guide/profiles.md).
- **Auto-switching** — Set rules so profiles activate automatically. See [Auto-Switch Rules](user-guide/rules.md).
- **Scheduled charging** — Charge to full only on weekday mornings. See [Scheduled Profiles](user-guide/schedules.md).
- **Boost charge** — Need 100% for a one-off trip? See [Profiles](user-guide/profiles.md#boost-charge).
