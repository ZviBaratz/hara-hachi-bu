# Scheduled Profiles

A schedule adds a time window to a profile. When the current time falls within the window, the schedule counts as active — contributing to whether the profile activates automatically.

## Setting Up a Schedule

![Schedule editor in Preferences → Scenarios](../assets/preferences-scenarios.gif)

In **Preferences → Scenarios**, select a profile and enable the **Schedule** toggle. Configure:

- **Days** — select individual days (Mon–Sun) or use quick-select buttons: Weekdays, Weekends, All
- **Start time** — when the schedule window opens (24-hour format)
- **End time** — when the schedule window closes (24-hour format)

## Overnight Schedules

Setting start time **after** end time creates an overnight window. For example, `23:00–07:00` means:

- From 23:00 to midnight: check today's day selection
- From midnight to 07:00: check yesterday's day selection

This lets you create a "charge overnight" schedule that spans the day boundary correctly: a Monday–Friday `23:00–07:00` schedule activates on Monday night (23:00) through Tuesday morning (07:00), on Tuesday night through Wednesday morning, and so on.

## Specificity and Rules {#specificity}

A schedule adds **+1 to profile specificity** when it is currently active. This means:

| Profile | Rules | Schedule Active | Effective Specificity |
|---------|-------|-----------------|----------------------|
| Docked | 2 rules | No | 2 |
| Morning Charge | 1 rule | Yes | 2 |
| Overnight | No rules | Yes | 1 |

A schedule-only profile (no rules) reaches specificity 1 when active — enough to match if no rule-based profile is competing.

## Conflict Detection

The extension checks for conflicts when you save a profile's schedule:

| Situation | Outcome |
|-----------|---------|
| Same rules, one scheduled / one not | **No conflict** — scheduled profile wins during its window |
| Same rules, both scheduled, non-overlapping times | **No conflict** |
| Same rules, both scheduled, overlapping times | **Conflict** — adjust time ranges to fix |
| Same rules, both unscheduled | **Conflict** — add a schedule or extra rule |

## Example: Morning Charge

Charge to Full Capacity on weekday mornings and revert automatically.

1. Create a profile named **Morning Charge**
2. Set battery mode to Full Capacity, power mode to Balanced
3. Enable **Auto-managed**
4. Enable **Schedule**: Weekdays, 05:30–08:00

The extension activates the profile at 05:30 on weekdays and deactivates it at 08:00, reverting to whichever profile is appropriate for the current conditions (e.g., Docked or Travel based on rules).

## DST and Clock Drift

During daylight saving time transitions, a schedule boundary may fire up to one hour late. The extension self-corrects within the hour — no manual action needed.

The schedule timer is capped at one hour internally to guard against both DST shifts and clock drift.

## Suspend and Resume

When the system suspends and resumes (sleep/wake), the extension re-evaluates all schedule timers immediately. A schedule that became active or inactive during sleep is applied correctly on wake.
