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
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import * as ProfileMatcher from './lib/profileMatcher.js';

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
                label: 'Default',
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
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(generalPage);

        // UI Settings Group
        const uiGroup = new Adw.PreferencesGroup({
            title: 'User Interface',
            description: 'Configure the appearance of the extension',
        });
        generalPage.add(uiGroup);

        // Show system indicator
        const indicatorRow = new Adw.SwitchRow({
            title: 'Show System Indicator',
            subtitle: 'Display indicator icon in the system tray',
        });
        settings.bind('show-system-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(indicatorRow);

        // Show force discharge toggle
        const forceDischargeRow = new Adw.SwitchRow({
            title: 'Show Force Discharge Toggle',
            subtitle: 'Display force discharge toggle in the menu',
        });
        settings.bind('show-force-discharge', forceDischargeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(forceDischargeRow);

        // Hide built-in power profile indicator
        const hideBuiltinRow = new Adw.SwitchRow({
            title: 'Hide Built-in Power Profile',
            subtitle: 'Replace GNOME Shell\'s power profile quick settings with this extension',
        });
        settings.bind('hide-builtin-power-profile', hideBuiltinRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        uiGroup.add(hideBuiltinRow);

        // Battery Thresholds Page
        const thresholdsPage = new Adw.PreferencesPage({
            title: 'Thresholds',
            icon_name: 'battery-symbolic',
        });
        window.add(thresholdsPage);

        // Full Capacity Mode Group
        const fullGroup = new Adw.PreferencesGroup({
            title: 'Full Capacity Mode',
            description: 'Maximum battery capacity for travel',
        });
        thresholdsPage.add(fullGroup);

        const fullStartRow = new Adw.SpinRow({
            title: 'Start Charging At',
            subtitle: 'Begin charging when battery drops below this level',
            adjustment: new Gtk.Adjustment({
                lower: 80,
                upper: 99,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-full-start'),
            }),
        });
        settings.bind('threshold-full-start', fullStartRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        fullGroup.add(fullStartRow);

        const fullEndRow = new Adw.SpinRow({
            title: 'Stop Charging At',
            subtitle: 'Stop charging when battery reaches this level',
            adjustment: new Gtk.Adjustment({
                lower: 85,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-full-end'),
            }),
        });
        settings.bind('threshold-full-end', fullEndRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        fullGroup.add(fullEndRow);

        // Balanced Mode Group
        const balancedGroup = new Adw.PreferencesGroup({
            title: 'Balanced Mode',
            description: 'Balance between capacity and battery lifespan',
        });
        thresholdsPage.add(balancedGroup);

        const balancedStartRow = new Adw.SpinRow({
            title: 'Start Charging At',
            subtitle: 'Begin charging when battery drops below this level',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 80,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-balanced-start'),
            }),
        });
        settings.bind('threshold-balanced-start', balancedStartRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        balancedGroup.add(balancedStartRow);

        const balancedEndRow = new Adw.SpinRow({
            title: 'Stop Charging At',
            subtitle: 'Stop charging when battery reaches this level',
            adjustment: new Gtk.Adjustment({
                lower: 65,
                upper: 90,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-balanced-end'),
            }),
        });
        settings.bind('threshold-balanced-end', balancedEndRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        balancedGroup.add(balancedEndRow);

        // Max Lifespan Mode Group
        const lifespanGroup = new Adw.PreferencesGroup({
            title: 'Max Lifespan Mode',
            description: 'Maximize battery lifespan for desk work',
        });
        thresholdsPage.add(lifespanGroup);

        const lifespanStartRow = new Adw.SpinRow({
            title: 'Start Charging At',
            subtitle: 'Begin charging when battery drops below this level',
            adjustment: new Gtk.Adjustment({
                lower: 40,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-lifespan-start'),
            }),
        });
        settings.bind('threshold-lifespan-start', lifespanStartRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        lifespanGroup.add(lifespanStartRow);

        const lifespanEndRow = new Adw.SpinRow({
            title: 'Stop Charging At',
            subtitle: 'Stop charging when battery reaches this level',
            adjustment: new Gtk.Adjustment({
                lower: 45,
                upper: 70,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('threshold-lifespan-end'),
            }),
        });
        settings.bind('threshold-lifespan-end', lifespanEndRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        lifespanGroup.add(lifespanEndRow);

        // Profiles Page
        const profilesPage = new Adw.PreferencesPage({
            title: 'Profiles',
            icon_name: 'view-list-symbolic',
        });
        window.add(profilesPage);

        // Profile List Group
        const profileListGroup = new Adw.PreferencesGroup({
            title: 'Power Profiles',
            description: 'Manage custom power and battery mode combinations',
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
            label: 'Add Profile',
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
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        const aboutGroup = new Adw.PreferencesGroup();
        aboutPage.add(aboutGroup);

        const aboutRow = new Adw.ActionRow({
            title: 'Unified Power Manager',
            subtitle: 'Version 1.0\nManage power profiles and battery charging modes',
        });
        aboutGroup.add(aboutRow);

        // System Status group
        const statusGroup = new Adw.PreferencesGroup({
            title: 'System Status',
            description: 'Component installation and hardware support status',
        });
        aboutPage.add(statusGroup);

        // Check helper script
        const helperInstalled = this._checkFileExists('/usr/local/bin/unified-power-ctl');
        const helperRow = new Adw.ActionRow({
            title: 'Helper Script',
            subtitle: helperInstalled
                ? 'Installed at /usr/local/bin/unified-power-ctl'
                : 'Not installed - battery threshold control unavailable',
        });
        const helperIcon = new Gtk.Image({
            icon_name: helperInstalled ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        helperRow.add_suffix(helperIcon);
        statusGroup.add(helperRow);

        // Check polkit rules
        const polkitRules = this._checkFileExists('/etc/polkit-1/rules.d/10-unified-power-manager.rules');
        const polkitPolicy = this._checkFileExists('/usr/share/polkit-1/actions/org.gnome.shell.extensions.unified-power-manager.policy');
        const polkitInstalled = polkitRules || polkitPolicy;
        const polkitRow = new Adw.ActionRow({
            title: 'Polkit Configuration',
            subtitle: polkitInstalled
                ? (polkitRules ? 'Rules installed' : 'Legacy policy installed')
                : 'Not installed - may require password for each change',
        });
        const polkitIcon = new Gtk.Image({
            icon_name: polkitInstalled ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            valign: Gtk.Align.CENTER,
        });
        polkitRow.add_suffix(polkitIcon);
        statusGroup.add(polkitRow);

        // Check ThinkPad support
        const thinkpadSupport = this._checkFileExists('/sys/devices/platform/thinkpad_acpi');
        const thresholdSupport = this._checkFileExists('/sys/class/power_supply/BAT0/charge_control_end_threshold');
        const thinkpadRow = new Adw.ActionRow({
            title: 'Battery Threshold Support',
            subtitle: thinkpadSupport && thresholdSupport
                ? 'ThinkPad detected with threshold support'
                : (thinkpadSupport ? 'ThinkPad detected but threshold files not found' : 'Not a ThinkPad - battery features unavailable'),
        });
        const thinkpadIcon = new Gtk.Image({
            icon_name: (thinkpadSupport && thresholdSupport) ? 'emblem-ok-symbolic' : 'dialog-information-symbolic',
            valign: Gtk.Align.CENTER,
        });
        thinkpadRow.add_suffix(thinkpadIcon);
        statusGroup.add(thinkpadRow);

        // Installation instructions
        const installGroup = new Adw.PreferencesGroup({
            title: 'Installation',
            description: 'Run install-helper.sh or see README.md for manual installation',
        });
        aboutPage.add(installGroup);

        const installRow = new Adw.ActionRow({
            title: 'Helper Installation',
            subtitle: 'sudo ./install-helper.sh (in extension directory)',
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
            title: isEdit ? 'Edit Profile' : 'Create Profile',
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
            placeholder_text: 'Profile Name (e.g., Gaming)',
            text: isEdit ? existingProfile.name : '',
        });
        content.append(new Gtk.Label({label: 'Profile Name', halign: Gtk.Align.START}));
        content.append(nameEntry);

        // Disable name editing for builtin profiles
        if (isEdit && existingProfile.builtin)
            nameEntry.sensitive = false;

        // Power mode dropdown
        const powerModes = ['performance', 'balanced', 'power-saver'];
        const powerCombo = new Gtk.ComboBoxText();
        powerModes.forEach(mode => powerCombo.append_text(mode));
        powerCombo.set_active(isEdit ?
            powerModes.indexOf(existingProfile.powerMode) : 1);
        content.append(new Gtk.Label({label: 'Power Mode', halign: Gtk.Align.START, margin_top: 6}));
        content.append(powerCombo);

        // Battery mode dropdown
        const batteryModes = ['full-capacity', 'balanced', 'max-lifespan'];
        const batteryCombo = new Gtk.ComboBoxText();
        batteryModes.forEach(mode => batteryCombo.append_text(mode));
        batteryCombo.set_active(isEdit ?
            batteryModes.indexOf(existingProfile.batteryMode) : 1);
        content.append(new Gtk.Label({label: 'Battery Mode', halign: Gtk.Align.START, margin_top: 6}));
        content.append(batteryCombo);

        // Error label
        const errorLabel = new Gtk.Label({
            css_classes: ['error'],
            halign: Gtk.Align.START,
            visible: false,
        });
        content.append(errorLabel);

        // Dialog buttons
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        const saveButton = dialog.add_button(
            isEdit ? 'Save' : 'Create',
            Gtk.ResponseType.OK
        );
        saveButton.add_css_class('suggested-action');

        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK) {
                const name = nameEntry.get_text().trim();
                const powerMode = powerModes[powerCombo.get_active()];
                const batteryMode = batteryModes[batteryCombo.get_active()];

                // Generate ID from name
                const id = isEdit ?
                    existingProfile.id :
                    name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');

                // Validate
                if (!name) {
                    errorLabel.set_text('Profile name is required');
                    errorLabel.show();
                    return;
                }

                if (!isEdit && !ProfileMatcher.isValidProfileId(id)) {
                    errorLabel.set_text('Invalid name (use letters, numbers, hyphens)');
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
                    errorLabel.set_text('Profile already exists or limit reached');
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
            text: `Delete "${profile.name}"?`,
            secondary_text: 'This action cannot be undone.',
        });

        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        const deleteButton = dialog.add_button('Delete', Gtk.ResponseType.OK);
        deleteButton.add_css_class('destructive-action');

        dialog.connect('response', (dialog, response) => {
            if (response === Gtk.ResponseType.OK)
                ProfileMatcher.deleteProfile(settings, profile.id);
            dialog.close();
        });

        dialog.present();
    }
}
