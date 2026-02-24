# Battery-Level Rules & Profile Export/Import — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add battery-level-based rule conditions with hysteresis, and profile export/import to the Scenarios prefs page.

**Architecture:** Battery level flows from BatteryThresholdController → StateManager → ParameterDetector (via setter) → rule evaluation via existing `parameter-changed` signal. Numeric operators use `evaluateWithHysteresis` for the currently active profile. Export/import uses `Gtk.FileDialog` and `ProfileMatcher.validateProfile()`.

**Tech Stack:** GJS, GObject, GTK4/Adwaita, UPower D-Bus, Gio.File

---

### Task 1: Add battery_level parameter and numeric operators to constants.js

**Files:**

- Modify: `lib/constants.js:80-122` (PARAMETERS and OPERATORS objects)

**Step 1: Add `type` field to existing operators**

In `lib/constants.js`, add `type: 'binary'` to both `is` and `is_not` operators. This explicit typing enables operator filtering in the prefs UI.

```javascript
// Rule Operators
export const OPERATORS = {
    is: {
        name: 'is',
        label: N_('is'),
        type: 'binary',
        evaluate: (actual, expected) => actual === expected,
    },
    is_not: {
        name: 'is_not',
        label: N_('is not'),
        type: 'binary',
        evaluate: (actual, expected) => actual !== expected,
    },
};
```

**Step 2: Add `below` and `above` operators**

Append to the OPERATORS object, after `is_not`:

```javascript
    below: {
        name: 'below',
        // Translators: Operator for numeric comparison, e.g. "Battery Level is below 20%"
        label: N_('is below'),
        type: 'numeric',
        evaluate: (actual, expected) => Number(actual) < Number(expected),
        evaluateWithHysteresis: (actual, expected, isCurrentlyActive) =>
            isCurrentlyActive
                ? Number(actual) < Number(expected) + 2
                : Number(actual) < Number(expected),
    },
    above: {
        name: 'above',
        // Translators: Operator for numeric comparison, e.g. "Battery Level is above 80%"
        label: N_('is above'),
        type: 'numeric',
        evaluate: (actual, expected) => Number(actual) > Number(expected),
        evaluateWithHysteresis: (actual, expected, isCurrentlyActive) =>
            isCurrentlyActive
                ? Number(actual) > Number(expected) - 2
                : Number(actual) > Number(expected),
    },
```

**Step 3: Add `battery_level` parameter**

Append to the PARAMETERS object, after `lid_state`:

```javascript
    battery_level: {
        name: 'battery_level',
        label: N_('Battery Level'),
        type: 'numeric',
        range: [0, 100],
        unit: '%',
    },
```

Note: Existing parameters (`external_display`, `power_source`, `lid_state`) have no `type` field — they default to `'binary'` implicitly (checked as `paramDef.type || 'binary'` in consuming code).

**Step 4: Commit**

```bash
git add lib/constants.js
git commit -m "feat(rules): add battery_level parameter and numeric operators"
```

---

### Task 2: Update ruleEvaluator.js for numeric evaluation, validation, and conflict detection

**Files:**

- Modify: `lib/ruleEvaluator.js` (evaluateCondition, findMatchingProfile, validateCondition, constraintsCanCoexist)

**Step 1: Update `evaluateCondition` to support hysteresis**

Add an `isCurrentlyActive` parameter. When the operator has `evaluateWithHysteresis` and the flag is true, use it instead of `evaluate`:

```javascript
export function evaluateCondition(condition, currentParams, isCurrentlyActive = false) {
    try {
        const {param, op, value} = condition;
        const currentValue = currentParams[param];

        if (currentValue === undefined || currentValue === null) {
            return false;
        }

        const operator = OPERATORS[op];
        if (!operator) {
            console.warn(`Hara Hachi Bu: Unknown operator "${op}"`);
            return false;
        }

        if (isCurrentlyActive && operator.evaluateWithHysteresis)
            return operator.evaluateWithHysteresis(currentValue, value, true);

        return operator.evaluate(currentValue, value);
    } catch (e) {
        console.error(`Hara Hachi Bu: Error evaluating condition: ${e.message}`);
        return false;
    }
}
```

**Step 2: Update `evaluateRules` to pass `isCurrentlyActive`**

```javascript
export function evaluateRules(rules, currentParams, isCurrentlyActive = false) {
    if (!rules || rules.length === 0) {
        return false;
    }

    for (const condition of rules) {
        if (!evaluateCondition(condition, currentParams, isCurrentlyActive)) {
            return false;
        }
    }

    return true;
}
```

**Step 3: Update `findMatchingProfile` to accept `activeProfileId`**

Add parameter and thread it through to `evaluateRules`:

```javascript
export function findMatchingProfile(profiles, currentParams, activeProfileId = null) {
    try {
        let bestMatch = null;
        let bestSpecificity = -1;

        for (const profile of profiles) {
            const hasRules = profile.rules?.length > 0;
            const hasSchedule = profile.schedule?.enabled;

            if (!hasRules && !hasSchedule)
                continue;

            if (hasSchedule && !ScheduleUtils.isScheduleActive(profile.schedule))
                continue;

            const isCurrentlyActive = activeProfileId !== null && profile.id === activeProfileId;
            const rulesMatch = hasRules
                ? evaluateRules(profile.rules, currentParams, isCurrentlyActive)
                : true;
            if (!rulesMatch)
                continue;

            // ... rest unchanged (specificity, tiebreaker logic) ...
```

Only the `const isCurrentlyActive` line and the `evaluateRules` call change. Everything after `if (!rulesMatch)` stays the same.

**Step 4: Update `validateCondition` for numeric parameters**

Replace the value validation block at the end of `validateCondition`:

```javascript
const paramDef = PARAMETERS[param];
if (!paramDef) {
    return {valid: false, error: _('Unknown parameter: %s').format(param)};
}

// Validate operator compatibility with parameter type
const paramType = paramDef.type || 'binary';
const operator = OPERATORS[op];
if (operator.type && operator.type !== paramType) {
    return {valid: false, error: _('Operator "%s" cannot be used with parameter "%s"').format(op, param)};
}

// Validate value based on parameter type
if (paramType === 'numeric') {
    const numVal = Number(value);
    if (isNaN(numVal) || !Number.isInteger(numVal)) {
        return {valid: false, error: _('Value must be a whole number for "%s"').format(param)};
    }
    if (numVal < paramDef.range[0] || numVal > paramDef.range[1]) {
        return {
            valid: false,
            error: _('Value must be between %d and %d for "%s"').format(paramDef.range[0], paramDef.range[1], param),
        };
    }
} else {
    if (!paramDef.values.includes(value)) {
        return {valid: false, error: _('Invalid value "%s" for parameter "%s"').format(value, param)};
    }
}

return {valid: true, error: null};
```

**Step 5: Update `constraintsCanCoexist` for numeric operators**

Add numeric operator handling. This function returns `true` if both constraint lists can be satisfied simultaneously (i.e., they could conflict):

```javascript
function constraintsCanCoexist(constraints1, constraints2, param) {
    for (const c1 of constraints1) {
        for (const c2 of constraints2) {
            // Binary operator pairs (existing logic)
            if (c1.op === 'is' && c2.op === 'is') {
                if (c1.value === c2.value) return true;
            } else if (c1.op === 'is' && c2.op === 'is_not') {
                if (c1.value !== c2.value) return true;
            } else if (c1.op === 'is_not' && c2.op === 'is') {
                if (c1.value !== c2.value) return true;
            } else if (c1.op === 'is_not' && c2.op === 'is_not') {
                const paramDef = PARAMETERS[param];
                if (paramDef && paramDef.values) {
                    const forbidden = new Set([c1.value, c2.value]);
                    if (paramDef.values.every((v) => forbidden.has(v))) return false;
                }
                return true;
                // Numeric operator pairs
            } else if (c1.op === 'below' && c2.op === 'below') {
                return true; // Both match for values below min(X, Y)
            } else if (c1.op === 'above' && c2.op === 'above') {
                return true; // Both match for values above max(X, Y)
            } else if (c1.op === 'below' && c2.op === 'above') {
                // below X AND above Y: possible if X > Y
                return Number(c1.value) > Number(c2.value);
            } else if (c1.op === 'above' && c2.op === 'below') {
                // above X AND below Y: possible if Y > X
                return Number(c2.value) > Number(c1.value);
            } else {
                // Mixed binary/numeric on same param — shouldn't happen
                // but assume coexistence (conservative)
                return true;
            }
        }
    }

    return false;
}
```

**Step 6: Commit**

```bash
git add lib/ruleEvaluator.js
git commit -m "feat(rules): support numeric evaluation with hysteresis and conflict detection"
```

---

### Task 3: Update ParameterDetector and StateManager for battery level monitoring

**Files:**

- Modify: `lib/parameterDetector.js:29-42` (constructor), `:248-271` (getValue, getAllValues)
- Modify: `lib/stateManager.js:392-427` (\_evaluateAndApplyRules), `:193-235` (battery-status-changed handler)

**Step 1: Add battery level tracking to ParameterDetector**

In `ParameterDetector` constructor, add `_batteryLevel`:

```javascript
    constructor() {
        super();
        this._monitorManager = null;
        this._upowerProxy = null;
        this._debounceTimeoutId = null;
        this._proxyInitTimeout = null;
        this._initialized = false;

        // Current parameter values
        this._externalDisplayConnected = false;
        this._onBattery = false;
        this._lidClosed = false;
        this._batteryLevel = '-1'; // String; -1 = unknown
        this._destroyed = false;
    }
```

**Step 2: Add `setBatteryLevel` method to ParameterDetector**

Add after the `externalDisplayCount` getter (before `destroy()`):

```javascript
    /**
     * Update battery level from external source (StateManager).
     * Emits 'parameter-changed' if value changed.
     * @param {number} level - Battery percentage (0-100)
     */
    setBatteryLevel(level) {
        const strLevel = String(Math.round(level));
        if (this._batteryLevel !== strLevel) {
            this._batteryLevel = strLevel;
            this.emit('parameter-changed', 'battery_level', strLevel);
        }
    }
```

**Step 3: Update `getValue` and `getAllValues` to include battery_level**

```javascript
    getValue(paramName) {
        switch (paramName) {
        case 'external_display':
            return this._externalDisplayConnected ? 'connected' : 'not_connected';
        case 'power_source':
            return this._onBattery ? 'battery' : 'ac';
        case 'lid_state':
            return this._lidClosed ? 'closed' : 'open';
        case 'battery_level':
            return this._batteryLevel;
        default:
            return null;
        }
    }

    getAllValues() {
        return {
            external_display: this.getValue('external_display'),
            power_source: this.getValue('power_source'),
            lid_state: this.getValue('lid_state'),
            battery_level: this.getValue('battery_level'),
        };
    }
```

**Step 4: Forward battery level from StateManager to ParameterDetector**

In `lib/stateManager.js`, in the `battery-status-changed` handler (inside the `this._batteryController.connectObject` block), add the `setBatteryLevel` call:

```javascript
                'battery-status-changed', () => {
                    // Update battery level in parameter detector for rule evaluation
                    if (this._parameterDetector) {
                        this._parameterDetector.setBatteryLevel(
                            this._batteryController.batteryLevel
                        );
                    }

                    // Auto-revert boost charge when battery is full.
                    // (existing boost charge logic unchanged)
                    if (this._boostChargeActive) {
                        // ... existing code ...
                    }
                    this.emit('state-changed');
                },
```

**Step 5: Pass `activeProfileId` in `_evaluateAndApplyRules`**

In the `_evaluateAndApplyRules` method, change the `findMatchingProfile` call:

```javascript
const matchingProfile = RuleEvaluator.findMatchingProfile(profiles, currentParams, this._currentProfile);
```

**Step 6: Update notification message for numeric rules**

In `_applyProfile` method (stateManager.js), update the rule description builder to handle numeric parameters:

```javascript
                if (profile.rules && profile.rules.length > 0) {
                    const ruleDescs = profile.rules.map(rule => {
                        const param = Constants.PARAMETERS[rule.param];
                        const opDef = Constants.OPERATORS[rule.op];
                        if (!param || !opDef) return null;

                        let valueLabel;
                        if (param.type === 'numeric')
                            valueLabel = `${rule.value}${param.unit || ''}`;
                        else
                            valueLabel = param.valueLabels?.[rule.value] ? _(param.valueLabels[rule.value]) : rule.value;

                        return `${_(param.label)} ${_(opDef.label)} ${valueLabel}`;
                    }).filter(Boolean);
```

**Step 7: Initialize battery level in ParameterDetector after controllers ready**

In `StateManager.initialize()`, after `_initializeParameterDetector()` completes and before initial rule evaluation, seed the battery level:

```javascript
await this._initializeParameterDetector();
if (this._destroyed) return;

// Seed battery level in parameter detector
if (this._batteryController && this._parameterDetector)
    this._parameterDetector.setBatteryLevel(this._batteryController.batteryLevel);
```

**Step 8: Commit**

```bash
git add lib/parameterDetector.js lib/stateManager.js
git commit -m "feat(rules): wire battery level through parameter detector for rule evaluation"
```

---

### Task 4: Update prefs.js rule editor for numeric parameters

**Files:**

- Modify: `prefs.js:819-966` (addRuleRow function in \_showProfileDialog)

The rule editor currently has three dropdowns: parameter, operator, value. For numeric parameters, the operator dropdown must show only `below`/`above`, and the value widget must be a SpinButton instead of a dropdown.

**Step 1: Change rule row helper arrays to be dynamic**

Replace the static `opKeys`/`opLabels` arrays at the top of the rules section (around line 820):

```javascript
// Rule row builder helper arrays
const paramKeys = Object.values(PARAMETERS).map((p) => p.name);
const paramLabels = Object.values(PARAMETERS).map((p) => _(p.label));

// Operator helpers: build per-type operator lists
const getOperatorsForParam = (paramName) => {
    const paramDef = PARAMETERS[paramName];
    const paramType = paramDef?.type || 'binary';
    return Object.values(OPERATORS).filter((o) => (o.type || 'binary') === paramType);
};
```

**Step 2: Rewrite `addRuleRow` for dynamic operators and value widget**

Replace the entire `addRuleRow` function. Key changes:

1. Operator dropdown rebuilds when parameter changes
2. Value widget toggles between dropdown and SpinButton
3. Getters return correct values from whichever widget is active

```javascript
const addRuleRow = (rule = null) => {
    const rowBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_start: 12,
        margin_end: 12,
        margin_top: 3,
        margin_bottom: 3,
        accessible_role: Gtk.AccessibleRole.GROUP,
    });

    // --- Parameter dropdown ---
    const paramDrop = new Gtk.DropDown({
        model: Gtk.StringList.new(paramLabels),
        selected: rule ? Math.max(0, paramKeys.indexOf(rule.param)) : 0,
        tooltip_text: _('Condition parameter'),
    });
    paramDrop.hexpand = true;
    rowBox.append(paramDrop);

    // --- Operator dropdown (dynamic model) ---
    let currentOpKeys = [];
    let currentOpLabels = [];
    const opDrop = new Gtk.DropDown({
        model: Gtk.StringList.new([]),
        tooltip_text: _('Condition operator'),
    });
    rowBox.append(opDrop);

    // --- Value widget: dropdown for binary, SpinButton for numeric ---
    let valueKeys = [];
    let valueLabelsArr = [];

    const valueDrop = new Gtk.DropDown({
        model: Gtk.StringList.new([]),
        tooltip_text: _('Condition value'),
    });
    valueDrop.hexpand = true;
    rowBox.append(valueDrop);

    const valueSpinBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 4,
    });
    valueSpinBox.hexpand = true;
    const valueSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1,
            page_increment: 5,
        }),
        numeric: true,
        value: rule ? Number(rule.value) || 50 : 50,
        tooltip_text: _('Threshold value'),
    });
    valueSpin.hexpand = true;
    const unitLabel = new Gtk.Label({
        label: '%',
        valign: Gtk.Align.CENTER,
    });
    valueSpinBox.append(valueSpin);
    valueSpinBox.append(unitLabel);
    rowBox.append(valueSpinBox);

    // --- Update functions ---
    const updateOperatorModel = () => {
        const paramName = paramKeys[paramDrop.selected];
        const ops = getOperatorsForParam(paramName);
        currentOpKeys = ops.map((o) => o.name);
        currentOpLabels = ops.map((o) => _(o.label));
        opDrop.model = Gtk.StringList.new(currentOpLabels);

        // Restore selection if possible
        if (rule && rule.param === paramName) {
            const idx = currentOpKeys.indexOf(rule.op);
            opDrop.selected = idx >= 0 ? idx : 0;
        } else {
            opDrop.selected = 0;
        }
    };

    const updateValueWidget = () => {
        const paramName = paramKeys[paramDrop.selected];
        const paramDef = PARAMETERS[paramName];
        const paramType = paramDef?.type || 'binary';

        if (paramType === 'numeric') {
            valueDrop.visible = false;
            valueSpinBox.visible = true;
            // Update range from param definition
            if (paramDef.range) {
                valueSpin.adjustment.lower = paramDef.range[0];
                valueSpin.adjustment.upper = paramDef.range[1];
            }
            // Set unit label
            unitLabel.label = paramDef.unit || '';
            // Restore value for numeric
            if (rule && rule.param === paramName) {
                valueSpin.value = Number(rule.value) || 50;
            }
        } else {
            valueDrop.visible = true;
            valueSpinBox.visible = false;
            // Populate value dropdown
            if (paramDef) {
                valueKeys = [...paramDef.values];
                valueLabelsArr = paramDef.values.map((v) => _(paramDef.valueLabels[v]));
            } else {
                valueKeys = [];
                valueLabelsArr = [];
            }
            valueDrop.model = Gtk.StringList.new(valueLabelsArr);
            if (rule && rule.param === paramName) {
                const idx = valueKeys.indexOf(rule.value);
                valueDrop.selected = idx >= 0 ? idx : 0;
            } else {
                valueDrop.selected = 0;
            }
        }
    };

    // Initial setup
    updateOperatorModel();
    updateValueWidget();

    // React to parameter change
    paramDrop.connect('notify::selected', () => {
        updateOperatorModel();
        updateValueWidget();
        onFieldChanged?.();
    });

    // Move up button
    const moveUpBtn = new Gtk.Button({
        icon_name: 'go-up-symbolic',
        css_classes: ['flat', 'circular'],
        tooltip_text: _('Move condition up'),
    });
    moveUpBtn.connect('clicked', () => {
        const idx = ruleRows.indexOf(rowData);
        if (idx > 0) {
            [ruleRows[idx - 1], ruleRows[idx]] = [ruleRows[idx], ruleRows[idx - 1]];
            rebuildRuleDisplay();
            onFieldChanged?.();
        }
    });
    rowBox.append(moveUpBtn);

    // Move down button
    const moveDownBtn = new Gtk.Button({
        icon_name: 'go-down-symbolic',
        css_classes: ['flat', 'circular'],
        tooltip_text: _('Move condition down'),
    });
    moveDownBtn.connect('clicked', () => {
        const idx = ruleRows.indexOf(rowData);
        if (idx >= 0 && idx < ruleRows.length - 1) {
            [ruleRows[idx], ruleRows[idx + 1]] = [ruleRows[idx + 1], ruleRows[idx]];
            rebuildRuleDisplay();
            onFieldChanged?.();
        }
    });
    rowBox.append(moveDownBtn);

    // Remove button
    const removeBtn = new Gtk.Button({
        icon_name: 'list-remove-symbolic',
        css_classes: ['flat', 'circular'],
        tooltip_text: _('Remove condition'),
    });
    removeBtn.connect('clicked', () => {
        const index = ruleRows.indexOf(rowData);
        if (index > -1) {
            ruleRows.splice(index, 1);
            rulesGroup.remove(rowBox);
            updateMoveButtonSensitivity();
            onFieldChanged?.();
        }
    });
    rowBox.append(removeBtn);

    // Accessible name helper
    const updateAccessibleName = () => {
        const n = ruleRows.indexOf(rowData) + 1;
        const pLabel = paramLabels[paramDrop.selected] ?? '';
        const oLabel = currentOpLabels[opDrop.selected] ?? '';

        const paramName = paramKeys[paramDrop.selected];
        const paramDef = PARAMETERS[paramName];
        const paramType = paramDef?.type || 'binary';
        let vLabel;
        if (paramType === 'numeric') vLabel = `${Math.round(valueSpin.value)}${paramDef.unit || ''}`;
        else vLabel = valueLabelsArr[valueDrop.selected] ?? '';

        rowBox.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [_('Condition %d: %s %s %s').format(n, pLabel, oLabel, vLabel)]
        );
    };

    const rowData = {
        box: rowBox,
        getParam: () => paramKeys[paramDrop.selected],
        getOp: () => currentOpKeys[opDrop.selected],
        getValue: () => {
            const paramName = paramKeys[paramDrop.selected];
            const paramDef = PARAMETERS[paramName];
            const paramType = paramDef?.type || 'binary';
            if (paramType === 'numeric') return String(Math.round(valueSpin.value));
            return valueKeys[valueDrop.selected] ?? null;
        },
        updateAccessibleName,
        moveUpBtn,
        moveDownBtn,
    };
    ruleRows.push(rowData);
    rulesGroup.add(rowBox);

    // Set initial accessible name and update on changes
    updateAccessibleName();
    paramDrop.connect('notify::selected', updateAccessibleName);
    opDrop.connect('notify::selected', updateAccessibleName);
    valueDrop.connect('notify::selected', updateAccessibleName);
    valueSpin.connect('value-changed', () => {
        updateAccessibleName();
        onFieldChanged?.();
    });
};
```

**Step 3: Commit**

```bash
git add prefs.js
git commit -m "feat(prefs): support numeric parameters in rule editor with SpinButton"
```

---

### Task 5: Profile Export/Import

**Files:**

- Modify: `prefs.js:286-316` (action buttons area in Scenarios page)

**Step 1: Add Export and Import buttons to the Scenarios page**

In `prefs.js`, in the `fillPreferencesWindow` method, add Export/Import buttons to the existing `profileButtonBox` (around line 287-316). Insert them before the existing "Add Scenario" button:

```javascript
// Action buttons
const profileButtonBox = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 12,
    halign: Gtk.Align.CENTER,
    margin_top: 12,
});

// Export button
const exportButton = new Gtk.Button({
    label: _('Export All'),
    css_classes: ['pill'],
    tooltip_text: _('Export all scenarios to a JSON file'),
});
exportButton.connect('clicked', () => {
    this._exportProfiles(window, settings);
});
profileButtonBox.append(exportButton);

// Import button
const importButton = new Gtk.Button({
    label: _('Import'),
    css_classes: ['pill'],
    tooltip_text: _('Import scenarios from a JSON file'),
});
importButton.connect('clicked', () => {
    this._importProfiles(window, settings);
});
profileButtonBox.append(importButton);

// (existing Add Scenario and Create from Current buttons follow)
```

**Step 2: Implement `_exportProfiles` method**

Add to the `HaraHachiBuPreferences` class:

```javascript
    async _exportProfiles(window, settings) {
        const profiles = ProfileMatcher.getCustomProfiles(settings);
        if (profiles.length === 0) {
            const dialog = new Adw.AlertDialog({
                heading: _('Nothing to Export'),
                body: _('No scenarios to export. Create some scenarios first.'),
            });
            dialog.add_response('ok', _('OK'));
            dialog.present(window);
            return;
        }

        const exportData = {
            version: 1,
            exported: new Date().toISOString(),
            profiles: profiles,
        };

        try {
            const fileDialog = new Gtk.FileDialog({
                title: _('Export Scenarios'),
                initial_name: 'hara-hachi-bu-scenarios.json',
            });

            const file = await fileDialog.save(window, null);
            if (!file) return;

            const json = JSON.stringify(exportData, null, 2);
            const bytes = new GLib.Bytes(new TextEncoder().encode(json));
            const stream = await file.replace_async(null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, GLib.PRIORITY_DEFAULT, null);
            await stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null);
            await stream.close_async(GLib.PRIORITY_DEFAULT, null);

            const toast = new Adw.Toast({
                title: _('Exported %d scenarios').format(profiles.length),
                timeout: 3,
            });
            window.add_toast(toast);
        } catch (e) {
            if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return; // User cancelled
            console.error(`Hara Hachi Bu: Export error: ${e.message}`);
            const dialog = new Adw.AlertDialog({
                heading: _('Export Failed'),
                body: e.message,
            });
            dialog.add_response('ok', _('OK'));
            dialog.present(window);
        }
    }
```

**Step 3: Implement `_importProfiles` method**

```javascript
    async _importProfiles(window, settings) {
        try {
            const filter = new Gtk.FileFilter();
            filter.add_pattern('*.json');
            filter.set_name(_('JSON files'));

            const filterList = new Gio.ListStore({item_type: Gtk.FileFilter});
            filterList.append(filter);

            const fileDialog = new Gtk.FileDialog({
                title: _('Import Scenarios'),
                filters: filterList,
                default_filter: filter,
            });

            const file = await fileDialog.open(window, null);
            if (!file) return;

            const [contents] = await file.load_contents_async(null);
            const text = new TextDecoder().decode(contents);

            let importData;
            try {
                importData = JSON.parse(text);
            } catch {
                const dialog = new Adw.AlertDialog({
                    heading: _('Import Failed'),
                    body: _('The file does not contain valid JSON.'),
                });
                dialog.add_response('ok', _('OK'));
                dialog.present(window);
                return;
            }

            if (!importData.version || !Array.isArray(importData.profiles)) {
                const dialog = new Adw.AlertDialog({
                    heading: _('Import Failed'),
                    body: _('The file is not a valid Hara Hachi Bu export.'),
                });
                dialog.add_response('ok', _('OK'));
                dialog.present(window);
                return;
            }

            const existingProfiles = ProfileMatcher.getCustomProfiles(settings);
            const existingIds = new Set(existingProfiles.map(p => p.id));

            const toImport = [];
            const skippedDuplicate = [];
            const skippedInvalid = [];

            for (const profile of importData.profiles) {
                if (!profile || typeof profile !== 'object') {
                    skippedInvalid.push('(unnamed)');
                    continue;
                }

                if (existingIds.has(profile.id)) {
                    skippedDuplicate.push(profile.name || profile.id);
                    continue;
                }

                // Deep-copy to avoid mutating the import data
                const copy = JSON.parse(JSON.stringify(profile));
                if (ProfileMatcher.validateProfile(copy) === null) {
                    skippedInvalid.push(profile.name || profile.id);
                    continue;
                }

                toImport.push(copy);
            }

            if (toImport.length === 0) {
                let body;
                if (skippedDuplicate.length > 0)
                    body = _('All scenarios already exist: %s').format(skippedDuplicate.join(', '));
                else if (skippedInvalid.length > 0)
                    body = _('No valid scenarios found in the file.');
                else
                    body = _('The file contains no scenarios.');

                const dialog = new Adw.AlertDialog({
                    heading: _('Nothing to Import'),
                    body,
                });
                dialog.add_response('ok', _('OK'));
                dialog.present(window);
                return;
            }

            // Check profile limit
            const available = ProfileMatcher.MAX_PROFILES - existingProfiles.length;
            const importCount = Math.min(toImport.length, available);
            const limitReached = toImport.length > available;

            // Build summary
            let bodyParts = [];
            bodyParts.push(Gettext.dngettext(
                'hara-hachi-bu',
                '%d scenario will be imported',
                '%d scenarios will be imported',
                importCount
            ).format(importCount));

            if (skippedDuplicate.length > 0)
                bodyParts.push(Gettext.dngettext(
                    'hara-hachi-bu',
                    '%d skipped (already exists)',
                    '%d skipped (already exist)',
                    skippedDuplicate.length
                ).format(skippedDuplicate.length));

            if (skippedInvalid.length > 0)
                bodyParts.push(Gettext.dngettext(
                    'hara-hachi-bu',
                    '%d skipped (invalid)',
                    '%d skipped (invalid)',
                    skippedInvalid.length
                ).format(skippedInvalid.length));

            if (limitReached)
                bodyParts.push(_('Limit reached — only the first %d will be imported').format(importCount));

            const confirmDialog = new Adw.AlertDialog({
                heading: _('Import Scenarios'),
                body: bodyParts.join('\n'),
            });
            confirmDialog.add_response('cancel', _('Cancel'));
            confirmDialog.add_response('import', _('Import'));
            confirmDialog.set_response_appearance('import', Adw.ResponseAppearance.SUGGESTED);
            confirmDialog.set_default_response('import');
            confirmDialog.set_close_response('cancel');

            confirmDialog.choose(window, null, (dlg, result) => {
                try {
                    if (dlg.choose_finish(result) !== 'import')
                        return;

                    const merged = [...existingProfiles, ...toImport.slice(0, importCount)];
                    ProfileMatcher.saveCustomProfiles(settings, merged);

                    const toast = new Adw.Toast({
                        title: Gettext.dngettext(
                            'hara-hachi-bu',
                            'Imported %d scenario',
                            'Imported %d scenarios',
                            importCount
                        ).format(importCount),
                        timeout: 3,
                    });
                    window.add_toast(toast);
                } catch (e) {
                    console.error(`Hara Hachi Bu: Import save error: ${e.message}`);
                }
            });
        } catch (e) {
            if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return;
            console.error(`Hara Hachi Bu: Import error: ${e.message}`);
            const dialog = new Adw.AlertDialog({
                heading: _('Import Failed'),
                body: e.message,
            });
            dialog.add_response('ok', _('OK'));
            dialog.present(window);
        }
    }
```

**Step 4: Commit**

```bash
git add prefs.js
git commit -m "feat(prefs): add profile export/import to Scenarios page"
```

---

### Task 6: Regenerate translations and verify

**Step 1: Regenerate POT file**

```bash
make pot
```

**Step 2: Compile schemas**

```bash
make schemas
```

**Step 3: Manual verification checklist**

Open prefs: `gnome-extensions prefs hara-hachi-bu@ZviBaratz`

- [ ] Scenarios page shows Export All / Import buttons
- [ ] Export All creates a JSON file with correct format
- [ ] Import reads a JSON file, shows confirmation, adds profiles
- [ ] Import skips duplicates correctly
- [ ] Import handles invalid files gracefully
- [ ] Create scenario → Add Condition → select "Battery Level"
- [ ] Operators change to "is below" / "is above" (not "is" / "is not")
- [ ] Value widget changes to SpinButton with % suffix
- [ ] Switch back to binary param → operators and value restore correctly
- [ ] Save scenario with battery level rule → verify rule stored in GSettings
- [ ] Rule conflict detection works with numeric rules

**Step 4: Commit translations**

```bash
git add hara-hachi-bu.pot
git commit -m "chore(i18n): regenerate POT file for battery level rules and export/import"
```

---

## Testing Notes

**Battery-level rule runtime testing requires GNOME Shell restart** (StateManager + ParameterDetector + RuleEvaluator run in extension context). Use `make nested` for a nested session, or logout/login on Wayland.

**Prefs testing is hot-reloadable** — just close and reopen `gnome-extensions prefs`.

**MockDevice works** for battery level testing — it reports a simulated battery level.

**To verify hysteresis**: Create a profile with "battery_level is below 50", watch `journalctl -f -o cat /usr/bin/gnome-shell` for rule evaluation debug messages. The profile should activate at 49% and deactivate at 52%.
