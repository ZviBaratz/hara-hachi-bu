/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gettext from 'gettext';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as ProfileMatcher from './lib/profileMatcher.js';
import * as RuleEvaluator from './lib/ruleEvaluator.js';
import * as ScheduleUtils from './lib/scheduleUtils.js';
import * as Constants from './lib/constants.js';

const {PARAMETERS, OPERATORS} = Constants;

const _ = s => Gettext.dgettext('hara-hachi-bu', s);

// ProfileRow widget for displaying profile in the list
const ProfileRow = GObject.registerClass(
class ProfileRow extends Adw.ActionRow {
    _init(profile, onEdit, onDelete) {
        // Build subtitle with human-readable mode labels
        const powerLabel = _(Constants.POWER_MODES[profile.powerMode]?.label ?? profile.powerMode);
        const batteryLabel = _(Constants.BATTERY_MODES[profile.batteryMode]?.label ?? profile.batteryMode);
        let subtitle = _('%s + %s').format(powerLabel, batteryLabel);
        if (profile.forceDischarge && profile.forceDischarge !== 'unspecified') {
            const fdLabel = Constants.FORCE_DISCHARGE_OPTIONS[profile.forceDischarge]?.label ?? profile.forceDischarge;
            subtitle = _('%s \u00b7 Force Discharge: %s').format(subtitle, _(fdLabel));
        }
        if (profile.schedule?.enabled) {
            const daysSummary = ScheduleUtils.formatDaysSummary(profile.schedule.days);
            subtitle = _('%s \u00b7 %s %s\u2013%s').format(
                subtitle, daysSummary, profile.schedule.startTime, profile.schedule.endTime
            );
        }

        super._init({
            title: ProfileMatcher.getProfileDisplayName(profile),
            subtitle: subtitle,
        });

        // Add "auto" badge if profile is auto-managed
        if (ProfileMatcher.isAutoManaged(profile)) {
            const autoBadge = new Gtk.Label({
                label: _('Auto'),
                css_classes: ['accent', 'caption'],
                margin_start: 6,
                valign: Gtk.Align.CENTER,
            });
            this.add_suffix(autoBadge);
        }

        // Edit button
        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Edit profile'),
        });
        editButton.connect('clicked', () => onEdit(profile));
        this.add_suffix(editButton);

        // Delete button (hidden for builtin profiles which cannot be deleted)
        if (!profile.builtin) {
            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Delete profile'),
            });
            deleteButton.connect('clicked', () => onDelete(profile));
            this.add_suffix(deleteButton);
        }
    }
});

export default class UnifiedPowerManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Run migration
        ProfileMatcher.runMigrations(settings);

        // General Settings Page
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // UI Settings Group
        const uiGroup = new Adw.PreferencesGroup({
            title: _('User Interface'),
            description: _('Configure the appearance of the extension'),
        });
        generalPage.add(uiGroup);

        // Show system indicator
        const indicatorRow = new Adw.SwitchRow({
            title: _('Show System Indicator'),
            subtitle: _('Display indicator icon in the top bar'),
        });
        settings.bind('show-system-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(indicatorRow);

        // Show force discharge toggle
        const forceDischargeRow = new Adw.SwitchRow({
            title: _('Show Force Discharge Toggle'),
            subtitle: _('Display force discharge toggle in the menu'),
        });
        settings.bind('show-force-discharge', forceDischargeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(forceDischargeRow);

        // Hide built-in power profile indicator
        const hideBuiltinRow = new Adw.SwitchRow({
            title: _('Hide Built-in Power Profile'),
            subtitle: _('Replace GNOME Shell\'s power profile quick settings with this extension'),
        });
        settings.bind('hide-builtin-power-profile', hideBuiltinRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(hideBuiltinRow);

        // Battery health display
        const healthDisplayRow = new Adw.SwitchRow({
            title: _('Show Battery Health in Quick Settings'),
            subtitle: _('Display battery capacity degradation information'),
        });
        settings.bind('show-battery-health', healthDisplayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(healthDisplayRow);

        // Battery health threshold
        const healthThresholdRow = new Adw.SpinRow({
            title: _('Battery Health Threshold'),
            subtitle: _('Show health only when below this percentage (100 = always show)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        settings.bind('battery-health-threshold', healthThresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(healthThresholdRow);

        // Bind threshold row sensitivity to show-battery-health toggle
        settings.bind('show-battery-health', healthThresholdRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        // Battery Management Group
        const batteryManageGroup = new Adw.PreferencesGroup({
            title: _('Battery Management'),
            description: _('Configure automatic battery level management'),
        });
        generalPage.add(batteryManageGroup);

        const autoManageRow = new Adw.SwitchRow({
            title: _('Automatic Discharge to Threshold'),
            subtitle: _('When plugged in and battery is above the stop-charging threshold, use force discharge to bring it down. Requires force discharge support.'),
        });
        settings.bind('auto-manage-battery-levels', autoManageRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        batteryManageGroup.add(autoManageRow);

        const boostTimeoutRow = new Adw.SpinRow({
            title: _('Boost Charge Timeout'),
            subtitle: _('Maximum hours before Boost Charge auto-reverts'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 12,
                step_increment: 1,
                page_increment: 2,
            }),
        });
        settings.bind('boost-charge-timeout-hours', boostTimeoutRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        batteryManageGroup.add(boostTimeoutRow);

        // Auto-Management Group
        const autoManageGroup = new Adw.PreferencesGroup({
            title: _('Automatic Profile Switching'),
            description: _('Profiles with "Apply Automatically" enabled will activate based on their conditions and schedules. Manually selecting a profile or mode pauses auto-switching. When no profile matches, settings remain unchanged.'),
        });
        generalPage.add(autoManageGroup);

        // Auto-switch profiles master toggle
        const autoSwitchRow = new Adw.SwitchRow({
            title: _('Auto-switch Profiles'),
            subtitle: _('Enable automatic profile switching based on conditions and schedules. Manually selecting a profile or mode will pause this.'),
        });
        settings.bind('auto-switch-enabled', autoSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoManageGroup.add(autoSwitchRow);

        // Resume on state change toggle
        const resumeRow = new Adw.SwitchRow({
            title: _('Resume on State Change'),
            subtitle: _('When paused by manual selection, automatically resume switching when system conditions change (display connected/disconnected, AC plugged/unplugged)'),
        });
        settings.bind('resume-on-state-change', resumeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoManageGroup.add(resumeRow);

        // Bind resume row sensitivity to auto-switch toggle
        settings.bind('auto-switch-enabled', resumeRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        // Battery Thresholds Page
        const thresholdsPage = new Adw.PreferencesPage({
            title: _('Thresholds'),
            icon_name: 'battery-symbolic',
        });
        window.add(thresholdsPage);

        // Introductory description
        const thresholdsIntro = new Adw.PreferencesGroup({
            description: _('These thresholds define the three battery charging modes available in Quick Settings. Limiting the maximum charge extends your battery\'s overall lifespan.'),
        });
        thresholdsPage.add(thresholdsIntro);

        // Threshold mode groups
        const thresholdConfigs = [
            {
                title: _('Full Capacity Mode'),
                description: _('Maximum battery capacity for travel'),
                startKey: 'threshold-full-start',
                endKey: 'threshold-full-end',
                startRange: {lower: 80, upper: 99},
                endRange: {lower: 85, upper: 100},
                defaults: {start: 95, end: 100},
            },
            {
                title: _('Balanced Mode'),
                description: _('Balance between capacity and battery lifespan'),
                startKey: 'threshold-balanced-start',
                endKey: 'threshold-balanced-end',
                startRange: {lower: 60, upper: 80},
                endRange: {lower: 65, upper: 90},
                defaults: {start: 75, end: 80},
            },
            {
                title: _('Max Lifespan Mode'),
                description: _('Maximize battery lifespan for desk work'),
                startKey: 'threshold-lifespan-start',
                endKey: 'threshold-lifespan-end',
                startRange: {lower: 40, upper: 60},
                endRange: {lower: 45, upper: 70},
                defaults: {start: 55, end: 60},
            },
        ];

        for (const config of thresholdConfigs) {
            thresholdsPage.add(this._buildThresholdGroup(settings, config));
        }

        // Profiles Page
        const profilesPage = new Adw.PreferencesPage({
            title: _('Profiles'),
            icon_name: 'view-list-symbolic',
        });
        window.add(profilesPage);

        // Profile List Group
        const profileListGroup = new Adw.PreferencesGroup({
            title: _('Power Profiles'),
            description: _('Manage custom power and battery mode combinations'),
        });
        profilesPage.add(profileListGroup);

        // Profile list container
        this._profileListBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            margin_top: 12,
            margin_bottom: 12,
        });

        // Wrap in scrolled window
        const scrolled = new Gtk.ScrolledWindow({
            child: this._profileListBox,
            vexpand: true,
            max_content_height: 400,
            propagate_natural_height: true,
        });
        profileListGroup.add(scrolled);

        // Add Profile button
        this._addProfileButton = new Gtk.Button({
            label: _('Add Profile'),
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            css_classes: ['pill'],
        });
        this._addProfileButton.connect('clicked', () => {
            this._showProfileDialog(window, settings, null);
        });
        profileListGroup.add(this._addProfileButton);

        // Populate profile list
        this._refreshProfileList(window, settings);

        // Watch for profile changes
        this._profileSettingsId = settings.connect('changed::custom-profiles', () => {
            this._refreshProfileList(window, settings);
        });

        // Store settings reference for cleanup
        this._settings = settings;

        // Disconnect signal when window closes to prevent memory leak
        // Use both close-request and destroy to ensure cleanup happens
        window.connect('close-request', () => {
            this._cleanupSettingsConnection();
            return false; // Allow window to close
        });
        window.connect('destroy', () => {
            this._cleanupSettingsConnection();
        });

        // About Page
        const aboutPage = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);

        const version = this.metadata.version ?? '?';
        const aboutRow = new Adw.ActionRow({
            title: _('Hara Hachi Bu'),
            subtitle: _('Version %s\nManage power profiles and battery charging modes').format(version),
        });
        aboutGroup.add(aboutRow);

        // System Status group
        const statusGroup = new Adw.PreferencesGroup({
            title: _('System Status'),
            description: _('Component installation and hardware support status'),
        });
        aboutPage.add(statusGroup);

        // Check helper script
        const helperInstalled = this._checkFileExists('/usr/local/bin/hhb-power-ctl');
        const helperRow = new Adw.ActionRow({
            title: _('Helper Script'),
            subtitle: helperInstalled
                ? _('Installed at /usr/local/bin/hhb-power-ctl')
                : _('Not installed - battery threshold control unavailable'),
        });
        const helperIcon = new Gtk.Image({
            icon_name: helperInstalled ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        helperIcon.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [helperInstalled ? _('Installed') : _('Not installed')]
        );
        helperRow.add_suffix(helperIcon);
        statusGroup.add(helperRow);

        // Check polkit rules
        const polkitRules = this._checkFileExists('/etc/polkit-1/rules.d/10-hara-hachi-bu.rules');
        const polkitPolicy = this._checkFileExists('/usr/share/polkit-1/actions/org.gnome.shell.extensions.hara-hachi-bu.policy');
        const polkitInstalled = polkitRules || polkitPolicy;
        const polkitRow = new Adw.ActionRow({
            title: _('Polkit Configuration'),
            subtitle: polkitInstalled
                ? (polkitRules ? _('Rules installed') : _('Legacy policy installed'))
                : _('Not installed - may require password for each change'),
        });
        const polkitIcon = new Gtk.Image({
            icon_name: polkitInstalled ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        polkitIcon.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [polkitInstalled ? _('Configured') : _('Not configured')]
        );
        polkitRow.add_suffix(polkitIcon);
        statusGroup.add(polkitRow);

        // Check Battery Threshold Support (BAT0-BAT3)
        let statusSubtitle = _('No compatible battery detected');
        let iconName = 'dialog-warning-symbolic';

        for (const bat of ['BAT0', 'BAT1', 'BAT2', 'BAT3']) {
            const batEnd = Constants.THRESHOLD_END_FILES.some(
                f => this._checkFileExists(`/sys/class/power_supply/${bat}/${f}`)
            );
            if (batEnd) {
                const batStart = Constants.THRESHOLD_START_FILES.some(
                    f => this._checkFileExists(`/sys/class/power_supply/${bat}/${f}`)
                );
                if (batStart) {
                    statusSubtitle = _('Compatible battery detected (%s) - Full threshold control').format(bat);
                } else {
                    statusSubtitle = _('Compatible battery detected (%s) - End threshold only (Start threshold ignored)').format(bat);
                }
                iconName = 'emblem-ok-symbolic';
                break;
            }
        }

        const batteryRow = new Adw.ActionRow({
            title: _('Battery Threshold Support'),
            subtitle: statusSubtitle,
        });
        const batteryIcon = new Gtk.Image({
            icon_name: iconName,
            valign: Gtk.Align.CENTER,
        });
        batteryIcon.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [statusSubtitle]
        );
        batteryRow.add_suffix(batteryIcon);
        statusGroup.add(batteryRow);

        // Installation instructions
        const installGroup = new Adw.PreferencesGroup({
            title: _('Installation'),
            description: _('The helper script is required for battery threshold control'),
        });
        aboutPage.add(installGroup);

        const extDir = this.path;
        const installCmd = `sudo ${extDir}/install-helper.sh`;
        const installRow = new Adw.ActionRow({
            title: _('Helper Installation'),
            subtitle: installCmd,
        });
        const copyBtn = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Copy install command'),
        });
        copyBtn.connect('clicked', () => {
            const display = copyBtn.get_display();
            const clipboard = display.get_clipboard();
            clipboard.set(installCmd);
            copyBtn.icon_name = 'emblem-ok-symbolic';
            copyBtn.tooltip_text = _('Copied!');
            // Reset icon after 2 seconds
            setTimeout(() => {
                copyBtn.icon_name = 'edit-copy-symbolic';
                copyBtn.tooltip_text = _('Copy install command');
            }, 2000);
        });
        installRow.add_suffix(copyBtn);
        installGroup.add(installRow);
    }

    _cleanupSettingsConnection() {
        if (this._profileSettingsId && this._settings) {
            try {
                this._settings.disconnect(this._profileSettingsId);
            } catch (e) {
                console.debug(`Hara Hachi Bu: Could not disconnect settings signal: ${e.message}`);
            }
            this._profileSettingsId = null;
        }
        this._settings = null;
    }

    _buildThresholdGroup(settings, config) {
        const group = new Adw.PreferencesGroup({
            title: config.title,
            description: config.description,
        });

        const hasStartThreshold = settings.get_boolean('device-has-start-threshold');
        const startRow = new Adw.SpinRow({
            title: _('Start Charging At'),
            subtitle: hasStartThreshold
                ? _('Battery will start charging when it drops to %d%%').format(
                    settings.get_int(config.startKey))
                : _('Not supported on this device \u2013 only end threshold is used'),
            sensitive: hasStartThreshold,
            adjustment: new Gtk.Adjustment({
                lower: config.startRange.lower,
                upper: config.startRange.upper,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int(config.startKey),
            }),
        });
        settings.bind(config.startKey, startRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        const endRow = new Adw.SpinRow({
            title: _('Stop Charging At'),
            subtitle: _('Battery will stop charging when it reaches %d%%').format(
                settings.get_int(config.endKey)
            ),
            adjustment: new Gtk.Adjustment({
                lower: config.endRange.lower,
                upper: config.endRange.upper,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int(config.endKey),
            }),
        });
        settings.bind(config.endKey, endRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Cross-validate: start must always be less than end
        startRow.adjustment.connect('value-changed', () => {
            const value = Math.round(startRow.adjustment.value);
            if (hasStartThreshold)
                startRow.subtitle = _('Battery will start charging when it drops to %d%%').format(value);
            if (endRow.adjustment.value <= value)
                endRow.adjustment.value = value + 1;
            endRow.adjustment.lower = value + 1;
        });

        endRow.adjustment.connect('value-changed', () => {
            const value = Math.round(endRow.adjustment.value);
            endRow.subtitle = _('Battery will stop charging when it reaches %d%%').format(value);
            if (hasStartThreshold) {
                if (startRow.adjustment.value >= value)
                    startRow.adjustment.value = value - 1;
                startRow.adjustment.upper = value - 1;
            }
        });

        // Initialize dynamic bounds
        endRow.adjustment.lower = startRow.adjustment.value + 1;
        startRow.adjustment.upper = endRow.adjustment.value - 1;

        group.add(startRow);
        group.add(endRow);

        // Reset button
        const resetRow = new Adw.ActionRow({
            title: _('Reset to Defaults'),
        });
        const resetBtn = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetBtn.connect('clicked', () => {
            settings.set_int(config.startKey, config.defaults.start);
            settings.set_int(config.endKey, config.defaults.end);
        });
        resetRow.add_suffix(resetBtn);
        group.add(resetRow);

        return group;
    }

    _checkFileExists(path) {
        try {
            const file = Gio.File.new_for_path(path);
            return file.query_exists(null);
        } catch {
            return false;
        }
    }

    _refreshProfileList(window, settings) {
        // Clear existing rows
        let child = this._profileListBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._profileListBox.remove(child);
            child = next;
        }

        // Get profiles and add rows
        const profiles = ProfileMatcher.getCustomProfiles(settings);

        if (profiles.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: _('No profiles'),
                subtitle: _('Click "Add Profile" to create one'),
                sensitive: false,
            });
            this._profileListBox.append(emptyRow);
            return;
        }

        for (const profile of profiles) {
            const row = new ProfileRow(
                profile,
                p => this._showProfileDialog(window, settings, p),
                p => this._showDeleteDialog(window, settings, p)
            );
            this._profileListBox.append(row);
        }

        // Disable Add Profile button when at limit
        if (this._addProfileButton) {
            const atLimit = profiles.length >= ProfileMatcher.MAX_PROFILES;
            this._addProfileButton.sensitive = !atLimit;
            this._addProfileButton.tooltip_text = atLimit
                ? _('Maximum of %d profiles reached').format(ProfileMatcher.MAX_PROFILES)
                : null;
        }
    }

    _showProfileDialog(window, settings, existingProfile) {
        const isEdit = existingProfile !== null;

        // Build key arrays for DropDown index-based lookup
        const powerModeKeys = Object.keys(Constants.POWER_MODES);
        const powerModeLabels = powerModeKeys.map(k => _(Constants.POWER_MODES[k].label));
        const batteryModeKeys = Object.keys(Constants.BATTERY_MODES);
        const batteryModeLabels = batteryModeKeys.map(k => _(Constants.BATTERY_MODES[k].label));
        const fdKeys = Object.keys(Constants.FORCE_DISCHARGE_OPTIONS);
        const fdLabels = fdKeys.map(k => _(Constants.FORCE_DISCHARGE_OPTIONS[k].label));

        // --- Build dialog content using Adw widgets ---
        const mainGroup = new Adw.PreferencesGroup();

        // Profile name
        const nameRow = new Adw.EntryRow({
            title: _('Profile Name'),
            text: isEdit ? existingProfile.name : '',
        });
        mainGroup.add(nameRow);

        // Power mode dropdown (Adw.ComboRow)
        const powerModel = Gtk.StringList.new(powerModeLabels);
        const powerRow = new Adw.ComboRow({
            title: _('Power Mode'),
            model: powerModel,
            selected: isEdit
                ? Math.max(0, powerModeKeys.indexOf(existingProfile.powerMode))
                : powerModeKeys.indexOf('balanced'),
        });
        mainGroup.add(powerRow);

        // Battery mode dropdown (Adw.ComboRow)
        const batteryModel = Gtk.StringList.new(batteryModeLabels);
        const batteryRow = new Adw.ComboRow({
            title: _('Battery Mode'),
            model: batteryModel,
            selected: isEdit
                ? Math.max(0, batteryModeKeys.indexOf(existingProfile.batteryMode))
                : batteryModeKeys.indexOf('balanced'),
        });
        mainGroup.add(batteryRow);

        // Force discharge dropdown (Adw.ComboRow)
        const fdModel = Gtk.StringList.new(fdLabels);
        const fdRow = new Adw.ComboRow({
            title: _('Force Discharge'),
            model: fdModel,
            selected: isEdit && existingProfile.forceDischarge
                ? Math.max(0, fdKeys.indexOf(existingProfile.forceDischarge))
                : fdKeys.indexOf('unspecified'),
        });
        mainGroup.add(fdRow);

        // Auto-activate toggle (Adw.SwitchRow)
        const autoManagedRow = new Adw.SwitchRow({
            title: _('Apply Automatically'),
            subtitle: _('Activates when conditions match (requires Auto-switch in Quick Settings)'),
            active: isEdit ? !!existingProfile.autoManaged : false,
        });
        mainGroup.add(autoManagedRow);

        // --- Rules section ---
        const rulesGroup = new Adw.PreferencesGroup({
            title: _('Activation Conditions'),
            description: _('When all conditions match, this profile activates automatically.'),
        });

        // Track rule rows
        const ruleRows = [];
        const initialRules = isEdit && existingProfile.rules ? [...existingProfile.rules] : [];

        // Rule row builder helper arrays
        const paramKeys = Object.values(PARAMETERS).map(p => p.name);
        const paramLabels = Object.values(PARAMETERS).map(p => _(p.label));
        const opKeys = Object.values(OPERATORS).map(o => o.name);
        const opLabels = Object.values(OPERATORS).map(o => _(o.label));

        // Function to add a rule row
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

            // Parameter dropdown
            const paramDrop = new Gtk.DropDown({
                model: Gtk.StringList.new(paramLabels),
                selected: rule ? Math.max(0, paramKeys.indexOf(rule.param)) : 0,
                tooltip_text: _('Condition parameter'),
            });
            paramDrop.hexpand = true;
            rowBox.append(paramDrop);

            // Operator dropdown
            const opDrop = new Gtk.DropDown({
                model: Gtk.StringList.new(opLabels),
                selected: rule ? Math.max(0, opKeys.indexOf(rule.op)) : 0,
                tooltip_text: _('Condition operator'),
            });
            rowBox.append(opDrop);

            // Value dropdown (populated based on parameter)
            let valueKeys = [];
            let valueLabelsArr = [];
            const updateValueModel = () => {
                const paramIdx = paramDrop.selected;
                const paramName = paramKeys[paramIdx];
                const param = PARAMETERS[paramName];
                if (param) {
                    valueKeys = [...param.values];
                    valueLabelsArr = param.values.map(v => _(param.valueLabels[v]));
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
            };
            const valueDrop = new Gtk.DropDown({
                model: Gtk.StringList.new([]),
                tooltip_text: _('Condition value'),
            });
            valueDrop.hexpand = true;
            updateValueModel();
            paramDrop.connect('notify::selected', updateValueModel);
            rowBox.append(valueDrop);

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
                }
            });
            rowBox.append(removeBtn);

            const rowData = {
                box: rowBox,
                getParam: () => paramKeys[paramDrop.selected],
                getOp: () => opKeys[opDrop.selected],
                getValue: () => valueKeys[valueDrop.selected] ?? null,
            };
            ruleRows.push(rowData);
            rulesGroup.add(rowBox);
        };

        // Add existing rules
        initialRules.forEach(rule => addRuleRow(rule));

        // Add rule button
        const addRuleBtn = new Gtk.Button({
            label: _('Add Condition'),
            halign: Gtk.Align.START,
            margin_start: 12,
            margin_top: 6,
        });
        addRuleBtn.connect('clicked', () => addRuleRow());
        rulesGroup.add(addRuleBtn);

        // Toggle rules section visibility
        const updateRulesVisibility = () => {
            rulesGroup.visible = autoManagedRow.active;
        };
        autoManagedRow.connect('notify::active', updateRulesVisibility);
        updateRulesVisibility();

        // --- Schedule section ---
        const scheduleGroup = new Adw.PreferencesGroup({
            title: _('Schedule'),
            description: _('Limit this profile to specific days and times. Both conditions AND schedule must match for activation. When a schedule ends, settings remain unchanged unless another profile matches.'),
        });

        // Schedule enable switch
        const scheduleEnabledRow = new Adw.SwitchRow({
            title: _('Enable Schedule'),
            subtitle: _('Profile only activates during the scheduled window'),
            active: existingProfile?.schedule?.enabled ?? false,
        });
        scheduleGroup.add(scheduleEnabledRow);

        // Day-of-week buttons
        const dayBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });
        const dayButtons = {};
        const existingDays = new Set(existingProfile?.schedule?.days ?? []);
        for (let d = 1; d <= 7; d++) {
            const btn = new Gtk.ToggleButton({
                label: _(Constants.DAYS_SHORT[d]),
                active: existingDays.has(d),
                css_classes: ['circular'],
                tooltip_text: _(Constants.DAYS_OF_WEEK[d]),
            });
            dayButtons[d] = btn;
            dayBox.append(btn);
        }
        scheduleGroup.add(dayBox);

        // Quick-select buttons
        const quickSelectBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            margin_bottom: 6,
        });
        const weekdaysBtn = new Gtk.Button({label: _('Weekdays'), css_classes: ['pill']});
        weekdaysBtn.connect('clicked', () => {
            for (let d = 1; d <= 7; d++)
                dayButtons[d].active = d <= 5;
        });
        const weekendsBtn = new Gtk.Button({label: _('Weekends'), css_classes: ['pill']});
        weekendsBtn.connect('clicked', () => {
            for (let d = 1; d <= 7; d++)
                dayButtons[d].active = d >= 6;
        });
        const allDaysBtn = new Gtk.Button({label: _('All'), css_classes: ['pill']});
        allDaysBtn.connect('clicked', () => {
            for (let d = 1; d <= 7; d++)
                dayButtons[d].active = true;
        });
        const clearDaysBtn = new Gtk.Button({label: _('Clear'), css_classes: ['pill']});
        clearDaysBtn.connect('clicked', () => {
            for (let d = 1; d <= 7; d++)
                dayButtons[d].active = false;
        });
        quickSelectBox.append(weekdaysBtn);
        quickSelectBox.append(weekendsBtn);
        quickSelectBox.append(allDaysBtn);
        quickSelectBox.append(clearDaysBtn);
        scheduleGroup.add(quickSelectBox);

        // Parse existing times or use defaults
        const existingStart = ScheduleUtils.parseTime(existingProfile?.schedule?.startTime ?? '') ?? {hours: 6, minutes: 0};
        const existingEnd = ScheduleUtils.parseTime(existingProfile?.schedule?.endTime ?? '') ?? {hours: 8, minutes: 0};

        // Helper to create a zero-padded SpinButton
        const createTimeSpin = (lower, upper, step, value, tooltipText) => {
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step}),
                numeric: true,
                wrap: true,
                width_chars: 2,
                valign: Gtk.Align.CENTER,
                tooltip_text: tooltipText,
            });
            spin.value = value;
            spin.connect('output', (s) => {
                s.text = String(Math.round(s.value)).padStart(2, '0');
                return true;
            });
            return spin;
        };

        // Start time row
        const startTimeRow = new Adw.ActionRow({title: _('Start Time')});
        const startHourSpin = createTimeSpin(0, 23, 1, existingStart.hours, _('Hours'));
        const startColonLabel = new Gtk.Label({label: ':', valign: Gtk.Align.CENTER});
        const startMinuteSpin = createTimeSpin(0, 59, 5, existingStart.minutes, _('Minutes'));
        startTimeRow.add_suffix(startHourSpin);
        startTimeRow.add_suffix(startColonLabel);
        startTimeRow.add_suffix(startMinuteSpin);
        scheduleGroup.add(startTimeRow);

        // End time row
        const endTimeRow = new Adw.ActionRow({title: _('End Time')});
        const endHourSpin = createTimeSpin(0, 23, 1, existingEnd.hours, _('Hours'));
        const endColonLabel = new Gtk.Label({label: ':', valign: Gtk.Align.CENTER});
        const endMinuteSpin = createTimeSpin(0, 59, 5, existingEnd.minutes, _('Minutes'));
        endTimeRow.add_suffix(endHourSpin);
        endTimeRow.add_suffix(endColonLabel);
        endTimeRow.add_suffix(endMinuteSpin);
        scheduleGroup.add(endTimeRow);

        // Overnight hint
        const overnightHint = new Gtk.Label({
            label: _('Tip: Set start time after end time for overnight schedules (e.g., 23:00 to 07:00)'),
            css_classes: ['caption', 'dim-label'],
            wrap: true,
            margin_top: 6,
            margin_start: 12,
            margin_end: 12,
        });
        scheduleGroup.add(overnightHint);

        // Schedule group visibility: only when auto-managed
        const updateScheduleVisibility = () => {
            scheduleGroup.visible = autoManagedRow.active;
        };
        autoManagedRow.connect('notify::active', updateScheduleVisibility);
        updateScheduleVisibility();

        // Schedule inner sensitivity: day buttons, spinners, quick-select sensitive only when enabled
        const updateScheduleSensitivity = () => {
            const enabled = scheduleEnabledRow.active;
            dayBox.sensitive = enabled;
            quickSelectBox.sensitive = enabled;
            startTimeRow.sensitive = enabled;
            endTimeRow.sensitive = enabled;
        };
        scheduleEnabledRow.connect('notify::active', updateScheduleSensitivity);
        updateScheduleSensitivity();

        // Error label (inside scrollable content so long messages aren't clipped)
        const errorGroup = new Adw.PreferencesGroup();
        const errorLabel = new Gtk.Label({
            css_classes: ['error'],
            halign: Gtk.Align.START,
            visible: false,
            wrap: true,
            margin_start: 12,
            margin_end: 12,
        });
        errorGroup.add(errorLabel);

        // --- Assemble dialog layout ---
        const contentPage = new Adw.PreferencesPage();
        contentPage.add(mainGroup);
        contentPage.add(rulesGroup);
        contentPage.add(scheduleGroup);
        contentPage.add(errorGroup);

        // Wrap in Adw.ToolbarView for header bar with buttons
        const headerBar = new Adw.HeaderBar();

        const cancelBtn = new Gtk.Button({label: _('Cancel')});
        headerBar.pack_start(cancelBtn);

        const saveBtn = new Gtk.Button({
            label: isEdit ? _('Save') : _('Create'),
            css_classes: ['suggested-action'],
        });
        headerBar.pack_end(saveBtn);

        const outerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
        });

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(headerBar);
        toolbarView.set_content(contentPage);
        outerBox.append(toolbarView);

        const dialog = new Adw.Dialog({
            title: isEdit ? _('Edit Profile') : _('Create Profile'),
            content_width: 450,
            content_height: 600,
        });
        dialog.set_child(outerBox);

        // Clear validation errors when user edits any field
        const hideError = () => errorLabel.hide();
        nameRow.connect('changed', hideError);
        powerRow.connect('notify::selected', hideError);
        batteryRow.connect('notify::selected', hideError);
        fdRow.connect('notify::selected', hideError);
        autoManagedRow.connect('notify::active', hideError);
        scheduleEnabledRow.connect('notify::active', hideError);
        for (const btn of Object.values(dayButtons))
            btn.connect('toggled', hideError);
        startHourSpin.connect('value-changed', hideError);
        startMinuteSpin.connect('value-changed', hideError);
        endHourSpin.connect('value-changed', hideError);
        endMinuteSpin.connect('value-changed', hideError);

        // Button handlers
        cancelBtn.connect('clicked', () => dialog.close());
        saveBtn.connect('clicked', () => {
            try {
                errorLabel.set_text('');
                errorLabel.hide();
                const name = nameRow.get_text().trim();
                const powerMode = powerModeKeys[powerRow.selected];
                const batteryMode = batteryModeKeys[batteryRow.selected];
                const forceDischarge = fdKeys[fdRow.selected];
                const autoManaged = autoManagedRow.active;

                // Collect rules
                const allRules = ruleRows.map(row => ({
                    param: row.getParam(),
                    op: row.getOp(),
                    value: row.getValue(),
                }));
                const rules = allRules.filter(r => r.param && r.op && r.value);
                if (rules.length < allRules.length) {
                    errorLabel.set_text(_('Some conditions are incomplete. Please complete or remove them before saving.'));
                    errorLabel.show();
                    return;
                }

                // Collect schedule data (always preserve user input; set enabled=false when not active)
                const scheduleDays = [];
                for (let d = 1; d <= 7; d++) {
                    if (dayButtons[d].active)
                        scheduleDays.push(d);
                }
                const scheduleEnabled = autoManaged && scheduleEnabledRow.active;
                const hadSchedule = existingProfile?.schedule != null;
                let schedule = null;
                if (scheduleEnabled || hadSchedule || scheduleDays.length > 0) {
                    schedule = {
                        enabled: scheduleEnabled,
                        days: scheduleDays,
                        startTime: ScheduleUtils.formatTimeHHMM(
                            Math.round(startHourSpin.value),
                            Math.round(startMinuteSpin.value)
                        ),
                        endTime: ScheduleUtils.formatTimeHHMM(
                            Math.round(endHourSpin.value),
                            Math.round(endMinuteSpin.value)
                        ),
                    };

                    if (scheduleEnabled) {
                        const scheduleValidation = ScheduleUtils.validateSchedule(schedule);
                        if (!scheduleValidation.valid) {
                            errorLabel.set_text(scheduleValidation.error);
                            errorLabel.show();
                            return;
                        }
                    }
                }

                const hasSchedule = schedule?.enabled;
                if (autoManaged && rules.length === 0 && !hasSchedule) {
                    errorLabel.set_text(_('Apply Automatically requires at least one condition or an enabled schedule.'));
                    errorLabel.show();
                    return;
                }

                // Generate ID from name
                const id = isEdit
                    ? existingProfile.id
                    : name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');

                if (!isEdit && id.length === 0) {
                    if (name.length === 0) {
                        errorLabel.set_text(_('Please enter a profile name.'));
                    } else {
                        errorLabel.set_text(_('Profile name must contain at least one letter or number (used to generate an internal ID).'));
                    }
                    errorLabel.show();
                    return;
                }

                // Validate using centralized validation
                const validation = ProfileMatcher.validateProfileInput(
                    settings, id, name, powerMode, batteryMode, isEdit
                );
                if (!validation.valid) {
                    errorLabel.set_text(validation.error);
                    errorLabel.show();
                    return;
                }

                // Check for duplicate display name
                const existingProfiles = ProfileMatcher.getCustomProfiles(settings);
                const duplicateName = existingProfiles.some(p =>
                    p.name.trim().toLowerCase() === name.toLowerCase() &&
                    (!isEdit || p.id !== existingProfile.id)
                );
                if (duplicateName) {
                    errorLabel.set_text(_('A profile with this name already exists'));
                    errorLabel.show();
                    return;
                }

                // Validate rules
                const rulesValidation = RuleEvaluator.validateRules(rules);
                if (!rulesValidation.valid) {
                    errorLabel.set_text(rulesValidation.errors.join('\n'));
                    errorLabel.show();
                    return;
                }

                // Check for conflicts
                const profiles = ProfileMatcher.getCustomProfiles(settings);
                const newProfile = {id, name, powerMode, batteryMode, forceDischarge, rules, autoManaged, schedule};
                const conflict = RuleEvaluator.findRuleConflict(profiles, newProfile, isEdit ? existingProfile.id : null);
                if (conflict) {
                    errorLabel.set_text(_('Conflicts with "%s" \u2014 same conditions and priority. Add more conditions to one, or give them non-overlapping schedules.').format(conflict.name));
                    errorLabel.show();
                    return;
                }

                // Save
                let success;
                if (isEdit) {
                    success = ProfileMatcher.updateProfile(settings, existingProfile.id,
                        {name, powerMode, batteryMode, forceDischarge, rules, autoManaged, schedule});
                } else {
                    success = ProfileMatcher.createProfile(settings, id, name, powerMode, batteryMode, forceDischarge, rules, autoManaged, schedule);
                }

                if (!success) {
                    errorLabel.set_text(_('Failed to save profile. Check for conflicts or limit reached.'));
                    errorLabel.show();
                    return;
                }

                dialog.close();
            } catch (e) {
                console.error(`Hara Hachi Bu: Profile dialog error: ${e.message}`);
                errorLabel.set_text(_('An unexpected error occurred. Check logs for details.'));
                errorLabel.show();
            }
        });

        // Store reference to prevent GC before GTK processes the dialog
        if (this._profileDialog && this._profileDialogClosedId)
            this._profileDialog.disconnect(this._profileDialogClosedId);
        this._profileDialogClosedId = dialog.connect('closed', () => {
            this._profileDialog = null;
            this._profileDialogClosedId = null;
        });
        this._profileDialog = dialog;
        dialog.present(window);
    }

    _showDeleteDialog(window, settings, profile) {
        // Check if this profile is currently active
        const isActive = ProfileMatcher.detectProfile(
            settings.get_string('current-power-mode'),
            settings.get_string('current-battery-mode'),
            settings
        ) === profile.id;

        let body = _('This action cannot be undone.');
        if (isActive) {
            body = _('This profile is currently active. Deleting it will switch to manual mode.') + ' ' + body;
        }

        const dialog = new Adw.AlertDialog({
            heading: _('Delete "%s"?').format(ProfileMatcher.getProfileDisplayName(profile)),
            body,
        });

        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.choose(window, null, (dlg, result) => {
            try {
                const response = dlg.choose_finish(result);
                if (response === 'delete') {
                    const success = ProfileMatcher.deleteProfile(settings, profile.id);
                    if (!success) {
                        // Show a follow-up error dialog
                        const errDialog = new Adw.AlertDialog({
                            heading: _('Delete Failed'),
                            body: _('Failed to delete profile. Please try again.'),
                        });
                        errDialog.add_response('ok', _('OK'));
                        errDialog.present(window);
                    }
                }
            } catch (e) {
                console.error(`Hara Hachi Bu: Delete dialog error: ${e.message}`);
            }
        });
    }
}
