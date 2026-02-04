/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
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
import {PARAMETERS, OPERATORS} from './lib/parameterDetector.js';
import * as RuleEvaluator from './lib/ruleEvaluator.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

// ProfileRow widget for displaying profile in the list
const ProfileRow = GObject.registerClass(
class ProfileRow extends Adw.ActionRow {
    _init(profile, onEdit, onDelete) {
        // Build subtitle with mode info and rule summary
        let subtitle = `${profile.powerMode} + ${profile.batteryMode}`;
        if (profile.forceDischarge && profile.forceDischarge !== 'unspecified') {
            subtitle += ` · FD: ${profile.forceDischarge}`;
        }

        super._init({
            title: profile.name,
            subtitle: subtitle,
        });

        // Add "auto" badge if profile has rules
        if (ProfileMatcher.hasAutoRules(profile)) {
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
        });
        editButton.connect('clicked', () => onEdit(profile));
        this.add_suffix(editButton);

        // Delete button (only for non-builtin)
        if (!profile.builtin) {
            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'destructive-action'],
            });
            deleteButton.connect('clicked', () => onDelete(profile));
            this.add_suffix(deleteButton);
        } else {
            // Builtin badge
            const badge = new Gtk.Label({
                label: _('Default'),
                css_classes: ['dim-label', 'caption'],
                margin_start: 6,
            });
            this.add_suffix(badge);
        }
    }
});

export default class UnifiedPowerManagerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Run migration
        ProfileMatcher.migrateProfilesToCustomFormat(settings);

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
            subtitle: _('Display indicator icon in the system tray'),
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

        // Auto-manage battery levels
        const autoManageRow = new Adw.SwitchRow({
            title: _('Auto-Manage Battery Levels'),
            subtitle: _('Automatically discharge when battery exceeds threshold (AC power only)'),
        });
        settings.bind('auto-manage-battery-levels', autoManageRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(autoManageRow);

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

        // Auto-Management Group
        const autoManageGroup = new Adw.PreferencesGroup({
            title: _('Automatic Profile Switching'),
            description: _('Profiles with rules automatically activate when conditions match'),
        });
        generalPage.add(autoManageGroup);

        // Auto-switch profiles master toggle
        const autoSwitchRow = new Adw.SwitchRow({
            title: _('Auto-switch Profiles'),
            subtitle: _('Automatically switch profiles based on their configured rules'),
        });
        settings.bind('auto-switch-enabled', autoSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoManageGroup.add(autoSwitchRow);

        // Resume on state change toggle
        const resumeRow = new Adw.SwitchRow({
            title: _('Resume on State Change'),
            subtitle: _('When paused, resume auto-switching when display/power changes'),
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

        // Full Capacity Mode Group
        const fullGroup = new Adw.PreferencesGroup({
            title: _('Full Capacity Mode'),
            description: _('Maximum battery capacity for travel'),
        });
        thresholdsPage.add(fullGroup);

        const fullStartRow = new Adw.SpinRow({
            title: _('Start Charging At'),
            subtitle: _('Battery will start charging when it drops to %d%%').format(
                settings.get_int('threshold-full-start')
            ),
            adjustment: new Gtk.Adjustment({
                lower: 80,
                upper: 99,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-full-start'),
            }),
        });
        settings.bind('threshold-full-start', fullStartRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Update subtitle when value changes
        fullStartRow.adjustment.connect('value-changed', () => {
            const value = Math.round(fullStartRow.adjustment.value);
            fullStartRow.subtitle = _('Battery will start charging when it drops to %d%%').format(value);
            // Ensure end threshold is always higher than start
            if (fullEndRow.adjustment.value <= value) {
                fullEndRow.adjustment.value = value + 1;
            }
            fullEndRow.adjustment.lower = value + 1;
        });

        fullGroup.add(fullStartRow);

        const fullEndRow = new Adw.SpinRow({
            title: _('Stop Charging At'),
            subtitle: _('Battery will stop charging when it reaches %d%%').format(
                settings.get_int('threshold-full-end')
            ),
            adjustment: new Gtk.Adjustment({
                lower: 85,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-full-end'),
            }),
        });
        settings.bind('threshold-full-end', fullEndRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Update subtitle when value changes
        fullEndRow.adjustment.connect('value-changed', () => {
            const value = Math.round(fullEndRow.adjustment.value);
            fullEndRow.subtitle = _('Battery will stop charging when it reaches %d%%').format(value);
            // Ensure start threshold is always lower than end
            if (fullStartRow.adjustment.value >= value) {
                fullStartRow.adjustment.value = value - 1;
            }
            fullStartRow.adjustment.upper = value - 1;
        });
        
        // Initialize dynamic bounds
        fullEndRow.adjustment.lower = fullStartRow.adjustment.value + 1;
        fullStartRow.adjustment.upper = fullEndRow.adjustment.value - 1;

        fullGroup.add(fullEndRow);

        // Balanced Mode Group
        const balancedGroup = new Adw.PreferencesGroup({
            title: _('Balanced Mode'),
            description: _('Balance between capacity and battery lifespan'),
        });
        thresholdsPage.add(balancedGroup);

        const balancedStartRow = new Adw.SpinRow({
            title: _('Start Charging At'),
            subtitle: _('Battery will start charging when it drops to %d%%').format(
                settings.get_int('threshold-balanced-start')
            ),
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 80,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-balanced-start'),
            }),
        });
        settings.bind('threshold-balanced-start', balancedStartRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Update subtitle when value changes
        balancedStartRow.adjustment.connect('value-changed', () => {
            const value = Math.round(balancedStartRow.adjustment.value);
            balancedStartRow.subtitle = _('Battery will start charging when it drops to %d%%').format(value);
            // Ensure end threshold is always higher than start
            if (balancedEndRow.adjustment.value <= value) {
                balancedEndRow.adjustment.value = value + 1;
            }
            balancedEndRow.adjustment.lower = value + 1;
        });

        balancedGroup.add(balancedStartRow);

        const balancedEndRow = new Adw.SpinRow({
            title: _('Stop Charging At'),
            subtitle: _('Battery will stop charging when it reaches %d%%').format(
                settings.get_int('threshold-balanced-end')
            ),
            adjustment: new Gtk.Adjustment({
                lower: 65,
                upper: 90,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-balanced-end'),
            }),
        });
        settings.bind('threshold-balanced-end', balancedEndRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Update subtitle when value changes
        balancedEndRow.adjustment.connect('value-changed', () => {
            const value = Math.round(balancedEndRow.adjustment.value);
            balancedEndRow.subtitle = _('Battery will stop charging when it reaches %d%%').format(value);
            // Ensure start threshold is always lower than end
            if (balancedStartRow.adjustment.value >= value) {
                balancedStartRow.adjustment.value = value - 1;
            }
            balancedStartRow.adjustment.upper = value - 1;
        });

        // Initialize dynamic bounds
        balancedEndRow.adjustment.lower = balancedStartRow.adjustment.value + 1;
        balancedStartRow.adjustment.upper = balancedEndRow.adjustment.value - 1;

        balancedGroup.add(balancedEndRow);

        // Max Lifespan Mode Group
        const lifespanGroup = new Adw.PreferencesGroup({
            title: _('Max Lifespan Mode'),
            description: _('Maximize battery lifespan for desk work'),
        });
        thresholdsPage.add(lifespanGroup);

        const lifespanStartRow = new Adw.SpinRow({
            title: _('Start Charging At'),
            subtitle: _('Battery will start charging when it drops to %d%%').format(
                settings.get_int('threshold-lifespan-start')
            ),
            adjustment: new Gtk.Adjustment({
                lower: 40,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-lifespan-start'),
            }),
        });
        settings.bind('threshold-lifespan-start', lifespanStartRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Update subtitle when value changes
        lifespanStartRow.adjustment.connect('value-changed', () => {
            const value = Math.round(lifespanStartRow.adjustment.value);
            lifespanStartRow.subtitle = _('Battery will start charging when it drops to %d%%').format(value);
            // Ensure end threshold is always higher than start
            if (lifespanEndRow.adjustment.value <= value) {
                lifespanEndRow.adjustment.value = value + 1;
            }
            lifespanEndRow.adjustment.lower = value + 1;
        });

        lifespanGroup.add(lifespanStartRow);

        const lifespanEndRow = new Adw.SpinRow({
            title: _('Stop Charging At'),
            subtitle: _('Battery will stop charging when it reaches %d%%').format(
                settings.get_int('threshold-lifespan-end')
            ),
            adjustment: new Gtk.Adjustment({
                lower: 45,
                upper: 70,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-lifespan-end'),
            }),
        });
        settings.bind('threshold-lifespan-end', lifespanEndRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);

        // Update subtitle when value changes
        lifespanEndRow.adjustment.connect('value-changed', () => {
            const value = Math.round(lifespanEndRow.adjustment.value);
            lifespanEndRow.subtitle = _('Battery will stop charging when it reaches %d%%').format(value);
            // Ensure start threshold is always lower than end
            if (lifespanStartRow.adjustment.value >= value) {
                lifespanStartRow.adjustment.value = value - 1;
            }
            lifespanStartRow.adjustment.upper = value - 1;
        });
        
        // Initialize dynamic bounds
        lifespanEndRow.adjustment.lower = lifespanStartRow.adjustment.value + 1;
        lifespanStartRow.adjustment.upper = lifespanEndRow.adjustment.value - 1;

        lifespanGroup.add(lifespanEndRow);

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
        const addButton = new Gtk.Button({
            label: _('Add Profile'),
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            css_classes: ['pill'],
        });
        addButton.connect('clicked', () => {
            this._showProfileDialog(window, settings, null);
        });
        profileListGroup.add(addButton);

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

        const aboutRow = new Adw.ActionRow({
            title: _('Unified Power Manager'),
            subtitle: _('Version 1.0\nManage power profiles and battery charging modes'),
        });
        aboutGroup.add(aboutRow);

        // System Status group
        const statusGroup = new Adw.PreferencesGroup({
            title: _('System Status'),
            description: _('Component installation and hardware support status'),
        });
        aboutPage.add(statusGroup);

        // Check helper script
        const helperInstalled = this._checkFileExists('/usr/local/bin/unified-power-ctl');
        const helperRow = new Adw.ActionRow({
            title: _('Helper Script'),
            subtitle: helperInstalled
                ? _('Installed at /usr/local/bin/unified-power-ctl')
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
        const polkitRules = this._checkFileExists('/etc/polkit-1/rules.d/10-unified-power-manager.rules');
        const polkitPolicy = this._checkFileExists('/usr/share/polkit-1/actions/org.gnome.shell.extensions.unified-power-manager.policy');
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

        // Check Battery Threshold Support
        const bat0End = this._checkFileExists('/sys/class/power_supply/BAT0/charge_control_end_threshold');
        const bat0Start = this._checkFileExists('/sys/class/power_supply/BAT0/charge_control_start_threshold');
        const bat1End = this._checkFileExists('/sys/class/power_supply/BAT1/charge_control_end_threshold');
        const bat1Start = this._checkFileExists('/sys/class/power_supply/BAT1/charge_control_start_threshold');
        
        let statusSubtitle = _('No compatible battery detected');
        let iconName = 'dialog-warning-symbolic';

        if (bat0End || bat1End) {
            const bat = bat0End ? 'BAT0' : 'BAT1';
            const hasStart = bat0End ? bat0Start : bat1Start;
            
            if (hasStart) {
                statusSubtitle = _('Compatible battery detected (%s) - Full threshold control').format(bat);
                iconName = 'emblem-ok-symbolic';
            } else {
                statusSubtitle = _('Compatible battery detected (%s) - End threshold only (Start threshold ignored)').format(bat);
                iconName = 'emblem-ok-symbolic';
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
            description: _('Run install-helper.sh or see README.md for manual installation'),
        });
        aboutPage.add(installGroup);

        const installRow = new Adw.ActionRow({
            title: _('Helper Installation'),
            subtitle: _('sudo ./install-helper.sh (in extension directory)'),
        });
        installGroup.add(installRow);
    }

    _cleanupSettingsConnection() {
        if (this._profileSettingsId && this._settings) {
            try {
                this._settings.disconnect(this._profileSettingsId);
            } catch {
                // Ignore - already disconnected
            }
            this._profileSettingsId = null;
        }
        this._settings = null;
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
        for (const profile of profiles) {
            const row = new ProfileRow(
                profile,
                p => this._showProfileDialog(window, settings, p),
                p => this._showDeleteDialog(window, settings, p)
            );
            this._profileListBox.append(row);
        }
    }

    _showProfileDialog(window, settings, existingProfile) {
        const isEdit = existingProfile !== null;

        const dialog = new Gtk.Dialog({
            title: isEdit ? _('Edit Profile') : _('Create Profile'),
            transient_for: window,
            modal: true,
            use_header_bar: true,
            default_width: 450,
            default_height: 600,
        });

        // Wrap in scrolled window for better usability
        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            propagate_natural_height: true,
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        scrolled.set_child(content);
        dialog.get_content_area().append(scrolled);

        // Profile name entry
        const nameEntry = new Gtk.Entry({
            placeholder_text: _('Profile Name (e.g., Gaming)'),
            text: isEdit ? existingProfile.name : '',
        });
        content.append(new Gtk.Label({label: _('Profile Name'), halign: Gtk.Align.START}));
        content.append(nameEntry);

        // Live ID preview (only for new profiles)
        let idPreviewLabel = null;
        if (!isEdit) {
            idPreviewLabel = new Gtk.Label({
                label: _('ID: (enter name above)'),
                halign: Gtk.Align.START,
                css_classes: ['dim-label', 'caption'],
                margin_top: 4,
            });
            content.append(idPreviewLabel);

            // Update ID preview as user types
            nameEntry.connect('changed', () => {
                const name = nameEntry.get_text().trim();
                if (name.length === 0) {
                    idPreviewLabel.set_text(_('ID: (enter name above)'));
                    idPreviewLabel.remove_css_class('error');
                    idPreviewLabel.remove_css_class('warning');
                    idPreviewLabel.add_css_class('dim-label');
                } else {
                    const generatedId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
                    if (generatedId.length === 0) {
                        idPreviewLabel.set_text(_('ID: (invalid characters)'));
                        idPreviewLabel.add_css_class('error');
                        idPreviewLabel.remove_css_class('dim-label');
                        idPreviewLabel.remove_css_class('warning');
                    } else {
                        // Check for duplicate ID
                        const existingProfiles = ProfileMatcher.getCustomProfiles(settings);
                        const isDuplicate = existingProfiles.some(p => p.id === generatedId);

                        if (isDuplicate) {
                            idPreviewLabel.set_text(_('ID: %s (already exists!)').format(generatedId));
                            idPreviewLabel.add_css_class('warning');
                            idPreviewLabel.remove_css_class('error');
                            idPreviewLabel.remove_css_class('dim-label');
                        } else {
                            idPreviewLabel.set_text(_('ID: %s').format(generatedId));
                            idPreviewLabel.remove_css_class('error');
                            idPreviewLabel.remove_css_class('warning');
                            idPreviewLabel.add_css_class('dim-label');
                        }
                    }
                }
            });
        }

        // Note: builtin profiles can have their names edited (ID remains stable)

        // Power mode dropdown
        const powerModes = ['performance', 'balanced', 'power-saver'];
        const powerModeLabels = {
            'performance': _('Performance'),
            'balanced': _('Balanced'),
            'power-saver': _('Power Saver'),
        };
        const powerCombo = new Gtk.ComboBoxText();
        powerModes.forEach(mode => powerCombo.append(mode, powerModeLabels[mode]));
        powerCombo.set_active_id(isEdit ? existingProfile.powerMode : 'balanced');
        content.append(new Gtk.Label({label: _('Power Mode'), halign: Gtk.Align.START, margin_top: 6}));
        content.append(powerCombo);

        // Battery mode dropdown
        const batteryModes = ['full-capacity', 'balanced', 'max-lifespan'];
        const batteryModeLabels = {
            'full-capacity': _('Full Capacity'),
            'balanced': _('Balanced'),
            'max-lifespan': _('Max Lifespan'),
        };
        const batteryCombo = new Gtk.ComboBoxText();
        batteryModes.forEach(mode => batteryCombo.append(mode, batteryModeLabels[mode]));
        batteryCombo.set_active_id(isEdit ? existingProfile.batteryMode : 'balanced');
        content.append(new Gtk.Label({label: _('Battery Mode'), halign: Gtk.Align.START, margin_top: 6}));
        content.append(batteryCombo);

        // Force discharge dropdown
        const forceDischargeOptions = ['unspecified', 'on', 'off'];
        const forceDischargeLabels = {
            'unspecified': _('Unspecified (no change)'),
            'on': _('On'),
            'off': _('Off'),
        };
        const forceDischargeCombo = new Gtk.ComboBoxText();
        forceDischargeOptions.forEach(opt => forceDischargeCombo.append(opt, forceDischargeLabels[opt]));
        forceDischargeCombo.set_active_id(isEdit && existingProfile.forceDischarge ? existingProfile.forceDischarge : 'unspecified');
        content.append(new Gtk.Label({label: _('Force Discharge'), halign: Gtk.Align.START, margin_top: 6}));
        content.append(forceDischargeCombo);

        // Separator
        content.append(new Gtk.Separator({margin_top: 12, margin_bottom: 6}));

        // Auto-activation rules section
        const rulesLabel = new Gtk.Label({
            label: _('Auto-Activation Rules'),
            halign: Gtk.Align.START,
            css_classes: ['heading'],
        });
        content.append(rulesLabel);

        const rulesDescription = new Gtk.Label({
            label: _('When all conditions match, this profile activates automatically.'),
            halign: Gtk.Align.START,
            css_classes: ['dim-label', 'caption'],
            wrap: true,
        });
        content.append(rulesDescription);

        // Rules container
        const rulesBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
        });
        content.append(rulesBox);

        // Track rule rows
        const ruleRows = [];
        const initialRules = isEdit && existingProfile.rules ? [...existingProfile.rules] : [];

        // Function to add a rule row
        const addRuleRow = (rule = null) => {
            const rowBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
            });

            // Parameter dropdown
            const paramCombo = new Gtk.ComboBoxText();
            Object.values(PARAMETERS).forEach(p => paramCombo.append(p.name, p.label));
            if (rule)
                paramCombo.set_active_id(rule.param);
            else
                paramCombo.set_active(0);
            rowBox.append(paramCombo);

            // Operator dropdown
            const opCombo = new Gtk.ComboBoxText();
            Object.values(OPERATORS).forEach(o => opCombo.append(o.name, o.label));
            if (rule)
                opCombo.set_active_id(rule.op);
            else
                opCombo.set_active(0);
            rowBox.append(opCombo);

            // Value dropdown (populated based on parameter)
            const valueCombo = new Gtk.ComboBoxText();
            const updateValueOptions = () => {
                valueCombo.remove_all();
                const paramName = paramCombo.get_active_id();
                const param = PARAMETERS[paramName];
                if (param) {
                    param.values.forEach(v => valueCombo.append(v, param.valueLabels[v]));
                }
                if (rule && rule.param === paramName) {
                    valueCombo.set_active_id(rule.value);
                } else {
                    valueCombo.set_active(0);
                }
            };
            updateValueOptions();
            paramCombo.connect('changed', updateValueOptions);
            rowBox.append(valueCombo);

            // Remove button
            const removeBtn = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                css_classes: ['flat', 'circular'],
            });
            removeBtn.connect('clicked', () => {
                const index = ruleRows.indexOf(rowData);
                if (index > -1) {
                    ruleRows.splice(index, 1);
                    rulesBox.remove(rowBox);
                }
            });
            rowBox.append(removeBtn);

            const rowData = {box: rowBox, paramCombo, opCombo, valueCombo};
            ruleRows.push(rowData);
            rulesBox.append(rowBox);
        };

        // Add existing rules
        initialRules.forEach(rule => addRuleRow(rule));

        // Add rule button
        const addRuleBtn = new Gtk.Button({
            label: _('Add Condition'),
            halign: Gtk.Align.START,
            margin_top: 6,
        });
        addRuleBtn.connect('clicked', () => addRuleRow());
        content.append(addRuleBtn);

        // Error label
        const errorLabel = new Gtk.Label({
            css_classes: ['error'],
            halign: Gtk.Align.START,
            visible: false,
            wrap: true,
            margin_top: 12,
        });
        content.append(errorLabel);

        // Dialog buttons
        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const saveButton = dialog.add_button(
            isEdit ? _('Save') : _('Create'),
            Gtk.ResponseType.OK
        );
        saveButton.add_css_class('suggested-action');

        // Set initial focus and keyboard navigation
        nameEntry.grab_focus();
        dialog.set_default_response(Gtk.ResponseType.OK);
        nameEntry.activates_default = true;

        dialog.connect('response', (dlg, response) => {
            try {
                if (response === Gtk.ResponseType.OK) {
                    const name = nameEntry.get_text().trim();
                    const powerMode = powerCombo.get_active_id();
                    const batteryMode = batteryCombo.get_active_id();
                    const forceDischarge = forceDischargeCombo.get_active_id();

                    // Collect rules
                    const rules = ruleRows.map(row => ({
                        param: row.paramCombo.get_active_id(),
                        op: row.opCombo.get_active_id(),
                        value: row.valueCombo.get_active_id(),
                    })).filter(r => r.param && r.op && r.value);

                    // Generate ID from name
                    const id = isEdit ?
                        existingProfile.id :
                        name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');

                    // Validate using centralized validation
                    const validation = ProfileMatcher.validateProfileInput(
                        settings, id, name, powerMode, batteryMode, isEdit
                    );
                    if (!validation.valid) {
                        errorLabel.set_text(_(validation.error));
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
                    const newProfile = {id, name, powerMode, batteryMode, forceDischarge, rules};
                    const conflict = RuleEvaluator.findRuleConflict(profiles, newProfile, isEdit ? existingProfile.id : null);
                    if (conflict) {
                        errorLabel.set_text(_('Rule conflict with profile "%s": same conditions at same specificity').format(conflict.name));
                        errorLabel.show();
                        return;
                    }

                    // Save
                    let success;
                    if (isEdit) {
                        success = ProfileMatcher.updateProfile(settings, existingProfile.id,
                            {name, powerMode, batteryMode, forceDischarge, rules});
                    } else {
                        success = ProfileMatcher.createProfile(settings, id, name, powerMode, batteryMode, forceDischarge, rules);
                    }

                    if (!success) {
                        errorLabel.set_text(_('Failed to save profile. Check for conflicts or limit reached.'));
                        errorLabel.show();
                        return;
                    }
                }
                dlg.close();
            } catch (e) {
                console.error(`Unified Power Manager: Profile dialog error: ${e.message}`);
                errorLabel.set_text(_('An unexpected error occurred. Check logs for details.'));
                errorLabel.show();
            }
        });

        dialog.present();
    }

    _showDeleteDialog(window, settings, profile) {
        // Check if this profile is currently active
        const currentProfileId = settings.get_string('current-power-mode') + '+' +
            settings.get_string('current-battery-mode');
        const profileConfig = `${profile.powerMode}+${profile.batteryMode}`;
        const isActive = currentProfileId === profileConfig ||
            ProfileMatcher.detectProfile(
                settings.get_string('current-power-mode'),
                settings.get_string('current-battery-mode'),
                settings
            ) === profile.id;

        let secondaryText = _('This action cannot be undone.');
        if (isActive) {
            secondaryText = _('This profile is currently active.') + ' ' + secondaryText;
        }

        const dialog = new Gtk.MessageDialog({
            transient_for: window,
            modal: true,
            buttons: Gtk.ButtonsType.NONE,
            message_type: Gtk.MessageType.WARNING,
            text: _('Delete "%s"?').format(profile.name),
            secondary_text: secondaryText,
        });

        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const deleteButton = dialog.add_button(_('Delete'), Gtk.ResponseType.OK);
        deleteButton.add_css_class('destructive-action');

        dialog.connect('response', (dialog, response) => {
            try {
                if (response === Gtk.ResponseType.OK)
                    ProfileMatcher.deleteProfile(settings, profile.id);
                dialog.close();
            } catch (e) {
                console.error(`Unified Power Manager: Delete dialog error: ${e.message}`);
                dialog.close();
            }
        });

        dialog.present();
    }
}
