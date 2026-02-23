# Manual Override

When auto-management is enabled, the extension automatically activates the best-matching profile based on your rules. But you can always take manual control.

## How It Works

If you manually change the power mode, battery mode, or activate a profile while auto-management is active, **auto-management pauses**. The extension respects your manual choice and does not switch profiles behind your back.

The Quick Settings panel shows a **Resume** button when auto-management is paused.

## Resuming Auto-Management

Auto-management resumes in two ways:

**1. Automatic resume on state change**

When a monitored parameter changes — an external display is connected or disconnected, the power source switches, or the lid opens or closes — the extension re-evaluates rules and resumes auto-management if the setting is enabled.

This is the default behavior. It means you can temporarily override and then resume automatically just by plugging in or unplugging the laptop.

**2. Manual resume**

Click the **Resume** button in the Quick Settings panel to immediately re-evaluate rules and resume auto-management.

## Configuring Resume Behavior

In **Preferences → General → Automatic Scenario Switching**, you can toggle whether auto-management resumes on state changes. If disabled, you must click Resume manually.

## Boost Charge and Auto-Management

The [Boost Charge](profiles.md#boost-charge) toggle has special handling:

- Activating Boost Charge pauses auto-management
- Deactivating Boost Charge (manually or automatically) resumes auto-management
- Auto-management then selects the appropriate profile for current conditions — no need to manually pick one

## Battery Level Rules

Battery level rules include a ±2% hysteresis. If a rule triggers at 20%, the profile won't immediately switch back at 19% — it waits for a 2% margin. This prevents rapid toggling at the boundary.
