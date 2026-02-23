# Auto-Switch Rules

Rules let profiles activate automatically based on system state. When conditions match, the extension applies the profile without any manual action.

## Parameters

Each rule checks one system parameter:

| Parameter | Description | Values |
|-----------|-------------|--------|
| `external_display` | Whether an external monitor is connected | `connected` / `not_connected` |
| `power_source` | Whether the laptop is on AC or battery | `ac` / `battery` |
| `lid` | Whether the lid is open or closed | `open` / `closed` |
| `battery_level` | Current battery percentage | Number (0–100) |

## Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `is` | Exact match | `power_source is ac` |
| `is_not` | Negation | `power_source is_not battery` |
| `above` | Greater than (battery level) | `battery_level above 20` |
| `below` | Less than (battery level) | `battery_level below 20` |

Battery level rules include a ±2% hysteresis to prevent rapid switching at the threshold boundary.

## How Rules Work

A profile activates when **all** of its rules match simultaneously. A profile with no rules never activates automatically (it must be activated manually).

### Specificity

When multiple profiles have matching rules, the one with the **most conditions** wins — this is called *most-specific-wins*.

Examples:

| Profile | Rules | Specificity |
|---------|-------|-------------|
| Docked | external_display is connected AND power_source is ac | 2 |
| Travel | power_source is battery | 1 |
| Quiet Work | (no rules) | 0 |

If an external display is connected and you're on AC, Docked (specificity 2) wins over Travel (specificity 1), even though Travel's rule also matches.

Scheduled profiles gain +1 specificity when their schedule is currently active. See [Scheduled Profiles](schedules.md#specificity) for details.

## Conflict Detection

The extension prevents conflicting configurations at save time:

- **Same rules, both unscheduled** → conflict (differentiate with an extra rule or add a schedule)
- **Same rules, one scheduled / one not** → no conflict (scheduled profile wins during its window)
- **Same rules, both scheduled, non-overlapping times** → no conflict
- **Same rules, both scheduled, overlapping times** → conflict

When a conflict is detected, the Preferences UI shows an error and blocks saving until it's resolved.

## Setting Up Rules

1. Open Preferences → Scenarios
2. Select a profile (or create one)
3. In the **Rules** section, click **+** to add a condition
4. Choose a parameter, operator, and value
5. Repeat for additional conditions (all must match)
6. Enable **Auto-managed** to activate automatic switching

## Example: Docked Profile

The built-in Docked profile uses two rules:

```
external_display is connected
power_source is ac
```

Both must be true. If the external display is connected but you're on battery, the Docked profile does not activate — the Travel profile (with `power_source is battery`) activates instead.

## Example: Low Battery Alert Profile

Create a profile named "Low Battery" with Power Saver mode and these rules:

```
battery_level below 20
power_source is battery
```

The extension switches to Power Saver automatically when the battery drops below 20% on battery power.
