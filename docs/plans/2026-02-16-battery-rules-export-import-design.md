# Design: Battery-Level Rules & Profile Export/Import

Date: 2026-02-16

## Feature 1: Battery-Level Rules

### Problem

Users cannot create rules based on battery percentage (e.g., "when battery drops below 20%, switch to Power Saver"). Existing parameters are binary (connected/not_connected, ac/battery). Battery level is continuous (0-100) and needs threshold operators.

### Design

**New parameter in constants.js:**

```javascript
battery_level: {
    name: 'battery_level',
    label: N_('Battery Level'),
    type: 'numeric',
    range: [0, 100],
    unit: '%',
}
```

**New operators:**

```javascript
below: {
    name: 'below',
    label: N_('is below'),
    evaluate: (actual, expected) => actual < expected,
    evaluateWithHysteresis: (actual, expected, isCurrentlyActive) =>
        isCurrentlyActive ? actual < expected + 2 : actual < expected,
},
above: {
    name: 'above',
    label: N_('is above'),
    evaluate: (actual, expected) => actual > expected,
    evaluateWithHysteresis: (actual, expected, isCurrentlyActive) =>
        isCurrentlyActive ? actual > expected - 2 : actual > expected,
},
```

**Hysteresis (+-2% dead zone):**

- Prevents rapid toggling at threshold boundary
- Applied only to the currently active profile
- Example: "below 20%" activates at 19%, stays active until 22%
- Implemented via `evaluateWithHysteresis` on the operator

**ParameterDetector changes:**

- Already monitors UPower proxy for battery percentage
- Add `battery_level` to emitted parameter state (integer 0-100)
- Emit via existing `parameter-changed` signal

**RuleEvaluator changes:**

- `evaluateRule()` checks operator for `evaluateWithHysteresis` variant
- Passes `isCurrentlyActive` flag (true when rule belongs to the currently active profile)
- `findMatchingProfile()` receives current active profile ID from StateManager

**StateManager changes:**

- Pass current active profile ID to `findMatchingProfile()` during rule evaluation

**Prefs UI changes:**

- When parameter is `battery_level`, replace value dropdown with `Gtk.SpinButton` (0-100, step 1, suffix "%")
- Show only `below`/`above` operators for numeric parameters
- Show only `is`/`is_not` operators for binary parameters

**Operator compatibility matrix:**
| Parameter type | Available operators |
|---|---|
| Binary (existing) | `is`, `is_not` |
| Numeric (`battery_level`) | `below`, `above` |

### Files to modify

- `lib/constants.js` — new parameter + operators
- `lib/parameterDetector.js` — emit battery_level
- `lib/ruleEvaluator.js` — hysteresis evaluation, accept active profile ID
- `lib/stateManager.js` — pass active profile ID to evaluator
- `prefs.js` — SpinButton for numeric rule values, operator filtering
- `schemas/org.gnome.shell.extensions.hara-hachi-bu.gschema.xml` — no changes (rules stored in profile JSON)

---

## Feature 2: Profile Export/Import

### Problem

Users cannot back up or share their profile configurations. No way to transfer settings between machines.

### Design

**JSON format:**

```json
{
  "version": 1,
  "exported": "2026-02-16T12:00:00Z",
  "profiles": [
    {
      "id": "docked",
      "name": "Docked",
      "powerMode": "performance",
      "batteryMode": "max-lifespan",
      "rules": [...],
      "schedule": null
    }
  ]
}
```

**Export flow:**

1. "Export All" button in Scenarios preferences page header
2. Opens `Gtk.FileDialog` save dialog
3. Suggested filename: `hara-hachi-bu-scenarios.json`
4. Writes all profiles (builtin + custom) as JSON
5. Shows toast/inline confirmation on success

**Import flow:**

1. "Import" button next to Export in Scenarios header
2. Opens `Gtk.FileDialog` open dialog (filter: `*.json`)
3. Reads and validates JSON:
    - Check `version` field
    - Run each profile through `ProfileMatcher.validateProfile()`
    - Skip profiles with IDs that already exist
4. Shows summary dialog: "Importing N profiles (M skipped: already exist)"
5. User confirms, profiles are added to GSettings
6. UI refreshes to show new profiles

**Edge cases:**

- Invalid JSON: show error message
- Missing required fields: skip individual bad profiles, import the rest
- Duplicate IDs: skip (don't overwrite)
- Empty import (all duplicates): show "No new profiles to import"

### Files to modify

- `prefs.js` — Export/Import buttons, file dialogs, validation, merge logic

---

## Decisions made during brainstorming

1. **Rule type**: Single threshold (below/above), not range
2. **Hysteresis**: Built-in +-2% dead zone at operator level
3. **Export scope**: All profiles in one file (not per-profile)
4. **Import conflict**: Skip duplicates (don't overwrite)
