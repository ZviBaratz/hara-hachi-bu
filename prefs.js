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

const _ = s => Gettext.dgettext('unified-power-manager', s);

// ProfileRow widget for displaying profile in the list
const ProfileRow = GObject.registerClass(
class ProfileRow extends Adw.ActionRow {
    _init(profile, onEdit, onDelete) {
        super._init({
            title: profile.name,
            subtitle: `${profile.powerMode} + ${profile.batteryMode}`,
        });

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

        // Auto-switch profiles
        const autoSwitchRow = new Adw.SwitchRow({
            title: _('Automatically Switch Profiles'),
            subtitle: _('Switch profiles based on power source (docking/undocking)'),
        });
        settings.bind('auto-switch-enabled', autoSwitchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(autoSwitchRow);

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

        // Docking Detection Group
        const dockingGroup = new Adw.PreferencesGroup({
            title: _('Automatic Profile Switching'),
            description: _('Automatically change profiles based on external displays'),
        });
        generalPage.add(dockingGroup);

        const dockingEnabledRow = new Adw.SwitchRow({
            title: _('Enable Docking Detection'),
            subtitle: _('Switch profiles when external displays connect/disconnect'),
        });
        settings.bind('docking-detection-enabled', dockingEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dockingGroup.add(dockingEnabledRow);

        // Docked profile selector
        const profiles = ProfileMatcher.getCustomProfiles(settings);
        const dockedCombo = new Adw.ComboRow({
            title: _('Docked Profile'),
            subtitle: _('Profile to use when external display is connected'),
        });
        const dockedModel = Gtk.StringList.new(profiles.map(p => p.name));
        dockedCombo.model = dockedModel;
        // Set initial selection based on current setting
        const dockedId = settings.get_string('docked-profile-id');
        const dockedIndex = profiles.findIndex(p => p.id === dockedId);
        if (dockedIndex >= 0)
            dockedCombo.selected = dockedIndex;
        // Save on change
        dockedCombo.connect('notify::selected', () => {
            const selectedProfile = profiles[dockedCombo.selected];
            if (selectedProfile)
                settings.set_string('docked-profile-id', selectedProfile.id);
        });
        dockingGroup.add(dockedCombo);

        // Undocked profile selector
        const undockedCombo = new Adw.ComboRow({
            title: _('Undocked Profile'),
            subtitle: _('Profile to use when external displays disconnect'),
        });
        const undockedModel = Gtk.StringList.new(profiles.map(p => p.name));
        undockedCombo.model = undockedModel;
        const undockedId = settings.get_string('undocked-profile-id');
        const undockedIndex = profiles.findIndex(p => p.id === undockedId);
        if (undockedIndex >= 0)
            undockedCombo.selected = undockedIndex;
        undockedCombo.connect('notify::selected', () => {
            const selectedProfile = profiles[undockedCombo.selected];
            if (selectedProfile)
                settings.set_string('undocked-profile-id', selectedProfile.id);
        });
        dockingGroup.add(undockedCombo);

        // Power Source Detection Group
        const powerSourceGroup = new Adw.PreferencesGroup({
            title: _('Power Source Switching'),
            description: _('Automatically change profiles based on AC/Battery power'),
        });
        generalPage.add(powerSourceGroup);

        const powerSourceEnabledRow = new Adw.SwitchRow({
            title: _('Enable Power Source Detection'),
            subtitle: _('Switch profiles when plugging in or out'),
        });
        settings.bind('power-source-detection-enabled', powerSourceEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        powerSourceGroup.add(powerSourceEnabledRow);

        // AC profile selector
        const acCombo = new Adw.ComboRow({
            title: _('AC Profile'),
            subtitle: _('Profile to use when connected to power'),
        });
        const acModel = Gtk.StringList.new(profiles.map(p => p.name));
        acCombo.model = acModel;
        const acId = settings.get_string('ac-profile-id');
        const acIndex = profiles.findIndex(p => p.id === acId);
        if (acIndex >= 0)
            acCombo.selected = acIndex;
        acCombo.connect('notify::selected', () => {
            const selectedProfile = profiles[acCombo.selected];
            if (selectedProfile)
                settings.set_string('ac-profile-id', selectedProfile.id);
        });
        powerSourceGroup.add(acCombo);

        // Battery profile selector
        const batteryCombo = new Adw.ComboRow({
            title: _('Battery Profile'),
            subtitle: _('Profile to use when running on battery'),
        });
        const batteryModel = Gtk.StringList.new(profiles.map(p => p.name));
        batteryCombo.model = batteryModel;
        const batteryId = settings.get_string('battery-profile-id');
        const batteryIndex = profiles.findIndex(p => p.id === batteryId);
        if (batteryIndex >= 0)
            batteryCombo.selected = batteryIndex;
        batteryCombo.connect('notify::selected', () => {
            const selectedProfile = profiles[batteryCombo.selected];
            if (selectedProfile)
                settings.set_string('battery-profile-id', selectedProfile.id);
        });
        powerSourceGroup.add(batteryCombo);

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
        });

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
        });

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
        });

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

        // Disconnect signal when window closes to prevent memory leak
        window.connect('close-request', () => {
            if (this._profileSettingsId) {
                settings.disconnect(this._profileSettingsId);
                this._profileSettingsId = null;
            }
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
        });

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        dialog.get_content_area().append(content);

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
                } else {
                    const generatedId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
                    if (generatedId.length === 0) {
                        idPreviewLabel.set_text(_('ID: (invalid characters)'));
                        idPreviewLabel.add_css_class('error');
                        idPreviewLabel.remove_css_class('dim-label');
                    } else {
                        idPreviewLabel.set_text(_('ID: %s').format(generatedId));
                        idPreviewLabel.remove_css_class('error');
                        idPreviewLabel.add_css_class('dim-label');
                    }
                }
            });
        }

        // Disable name editing for builtin profiles
        if (isEdit && existingProfile.builtin)
            nameEntry.sensitive = false;

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

        // Error label
        const errorLabel = new Gtk.Label({
            css_classes: ['error'],
            halign: Gtk.Align.START,
            visible: false,
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

        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const name = nameEntry.get_text().trim();
                const powerMode = powerCombo.get_active_id();
                const batteryMode = batteryCombo.get_active_id();

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

                // Save
                let success;
                if (isEdit) {
                    success = ProfileMatcher.updateProfile(settings, existingProfile.id,
                        {name, powerMode, batteryMode});
                } else {
                    success = ProfileMatcher.createProfile(settings, id, name, powerMode, batteryMode);
                }

                if (!success) {
                    errorLabel.set_text(_('Profile already exists or limit reached'));
                    errorLabel.show();
                    return;
                }
            }
            dialog.close();
        });

        dialog.present();
    }

    _showDeleteDialog(window, settings, profile) {
        const dialog = new Gtk.MessageDialog({
            transient_for: window,
            modal: true,
            buttons: Gtk.ButtonsType.NONE,
            message_type: Gtk.MessageType.WARNING,
            text: _('Delete "%s"?').format(profile.name),
            secondary_text: _('This action cannot be undone.'),
        });

        dialog.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        const deleteButton = dialog.add_button(_('Delete'), Gtk.ResponseType.OK);
        deleteButton.add_css_class('destructive-action');

        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK)
                ProfileMatcher.deleteProfile(settings, profile.id);
            dialog.close();
        });

        dialog.present();
    }
}
