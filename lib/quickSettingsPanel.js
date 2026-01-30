/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as ProfileMatcher from './profileMatcher.js';

const {BATTERY_MODES, POWER_MODES} = ProfileMatcher;

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

const PowerManagerToggle = GObject.registerClass(
class PowerManagerToggle extends QuickSettings.QuickMenuToggle {
    constructor(settings, extensionObject, stateManager) {
        super();
        this._settings = settings;
        this._stateManager = stateManager;
        this._extensionObject = extensionObject;
        this._iconFolder = extensionObject.dir.get_child('icons/hicolor/scalable/actions').get_path();

        this.title = 'Power Manager';
        this._updateSubtitle();

        // Set up menu header
        this.menu.setHeader('power-profile-balanced-symbolic', 'Power Manager');

        // Create menu sections
        this._profileSection = new PopupMenu.PopupMenuSection();
        this._powerModeSection = new PopupMenu.PopupMenuSection();
        this._batteryModeSection = new PopupMenu.PopupMenuSection();
        this._statusSection = new PopupMenu.PopupMenuSection();

        // Add section headers and items
        this._buildProfileSection();
        this._buildPowerModeSection();
        this._buildBatteryModeSection();
        this._buildStatusSection();

        // Add sections to menu
        this.menu.addMenuItem(this._profileSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._powerModeSection);

        // Only show battery section if battery threshold control is available
        this._batteryControlAvailable = this._stateManager.availableBatteryModes.length > 0;
        if (this._batteryControlAvailable) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(this._batteryModeSection);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._statusSection);

        // Force discharge toggle (if supported)
        if (this._stateManager.supportsForceDischarge &&
            this._settings.get_boolean('show-force-discharge')) {
            this._addForceDischargeToggle();
        }

        // Connect to state changes using connectObject for automatic cleanup
        this._stateManager.connectObject('state-changed', () => {
            this._updateUI();
        }, this);

        this._settings.connectObject('changed::show-force-discharge', () => {
            if (this._settings.get_boolean('show-force-discharge'))
                this._addForceDischargeToggle();
            else
                this._removeForceDischargeToggle();
        }, this);

        // Initial toggle state
        this.checked = this._stateManager.currentProfile !== null;

        // Toggle click cycles through profiles
        this.connectObject('clicked', () => {
            this._cycleProfile();
        }, this);

        this._updateUI();
    }

    _getIcon(iconName) {
        // Try extension icons first, then fall back to system icons
        const localPath = `${this._iconFolder}/${iconName}.svg`;
        const file = Gio.File.new_for_path(localPath);
        if (file.query_exists(null))
            return Gio.icon_new_for_string(localPath);
        return Gio.ThemedIcon.new(iconName);
    }

    _buildProfileSection() {
        // Section header
        const headerItem = new PopupMenu.PopupMenuItem('PROFILE', {
            reactive: false,
            style_class: 'popup-menu-section-header',
        });
        headerItem.sensitive = false;
        this._profileSection.addMenuItem(headerItem);

        // Build dynamic profile items
        this._rebuildProfileItems();

        // Watch for profile list changes
        this._settings.connectObject('changed::custom-profiles', () => {
            this._rebuildProfileItems();
        }, this);
    }

    _rebuildProfileItems() {
        // Clear existing items (except header)
        const items = this._profileSection._getMenuItems();
        items.slice(1).forEach(item => item.destroy());

        this._profileItems = {};
        const profiles = ProfileMatcher.getCustomProfiles(this._settings);

        for (const profile of profiles) {
            const item = new PopupMenu.PopupMenuItem(profile.name);
            item.connectObject('activate', () => {
                Main.panel.closeQuickSettings();
                this._stateManager.setProfile(profile.id);
            }, this);
            this._profileSection.addMenuItem(item);
            this._profileItems[profile.id] = item;
        }

        this._updateProfileOrnaments();
    }

    _buildPowerModeSection() {
        // Section header
        const headerItem = new PopupMenu.PopupMenuItem('POWER MODE', {
            reactive: false,
            style_class: 'popup-menu-section-header',
        });
        headerItem.sensitive = false;
        this._powerModeSection.addMenuItem(headerItem);

        // Power mode items
        this._powerModeItems = {};
        const powerModes = this._stateManager.availablePowerModes;

        for (const mode of powerModes) {
            const config = POWER_MODES[mode];
            const label = config ? config.label : mode;
            const item = new PopupMenu.PopupImageMenuItem(label, config?.icon || 'power-profile-balanced-symbolic');
            item.connectObject('activate', () => {
                Main.panel.closeQuickSettings();
                this._stateManager.setPowerMode(mode);
            }, this);
            this._powerModeSection.addMenuItem(item);
            this._powerModeItems[mode] = item;
        }
    }

    _buildBatteryModeSection() {
        // Section header
        const headerItem = new PopupMenu.PopupMenuItem('BATTERY MODE', {
            reactive: false,
            style_class: 'popup-menu-section-header',
        });
        headerItem.sensitive = false;
        this._batteryModeSection.addMenuItem(headerItem);

        // Battery mode items
        this._batteryModeItems = {};
        const batteryModes = this._stateManager.availableBatteryModes;

        for (const mode of batteryModes) {
            const config = BATTERY_MODES[mode];
            const label = `${config.label} (${config.description})`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connectObject('activate', () => {
                Main.panel.closeQuickSettings();
                this._stateManager.setBatteryMode(mode);
            }, this);
            this._batteryModeSection.addMenuItem(item);
            this._batteryModeItems[mode] = item;
        }
    }

    _buildStatusSection() {
        // Battery status display
        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            style_class: 'popup-menu-status-item',
        });
        this._statusItem.sensitive = false;
        this._statusSection.addMenuItem(this._statusItem);
        this._updateStatusItem();
    }

    _addForceDischargeToggle() {
        if (this._forceDischargeItem)
            return;

        this._forceDischargeSeperator = new PopupMenu.PopupSeparatorMenuItem();
        const forceDischargeState = this._stateManager.forceDischargeEnabled;
        this._forceDischargeItem = new PopupMenu.PopupSwitchMenuItem('Force Discharge', forceDischargeState);
        this._forceDischargeItem.setOrnament(PopupMenu.Ornament.HIDDEN);

        this._statusSection.addMenuItem(this._forceDischargeSeperator);
        this._statusSection.addMenuItem(this._forceDischargeItem);

        this._forceDischargeItem.activate = _ => {
            if (this._forceDischargeItem._switch.mapped)
                this._forceDischargeItem.toggle();
        };
        this._forceDischargeItem.connectObject('toggled', (o, state) => {
            this._stateManager.setForceDischarge(state);
        });
    }

    _removeForceDischargeToggle() {
        if (this._forceDischargeItem) {
            this._forceDischargeItem.destroy();
            this._forceDischargeItem = null;
        }
        if (this._forceDischargeSeperator) {
            this._forceDischargeSeperator.destroy();
            this._forceDischargeSeperator = null;
        }
    }

    _cycleProfile() {
        const profiles = this._stateManager.availableProfiles;
        const currentProfile = this._stateManager.currentProfile;
        const currentIndex = currentProfile ? profiles.indexOf(currentProfile) : -1;
        const nextIndex = (currentIndex + 1) % profiles.length;
        this._stateManager.setProfile(profiles[nextIndex]);
    }

    _updateUI() {
        this._updateSubtitle();
        this._updateProfileOrnaments();
        this._updatePowerModeOrnaments();
        this._updateBatteryModeOrnaments();
        this._updateStatusItem();
        this._updateForceDischargeToggle();
        this._updateIcon();

        // Update checked state based on profile match
        this.checked = this._stateManager.currentProfile !== null;
    }

    _updateSubtitle() {
        const profileId = this._stateManager.currentProfile;
        if (profileId) {
            const profile = ProfileMatcher.getProfileById(this._settings, profileId);
            this.subtitle = profile ? profile.name : 'Custom';
        } else {
            this.subtitle = 'Custom';
        }
    }

    _updateItemOrnaments(items, currentValue) {
        for (const [value, item] of Object.entries(items)) {
            item.setOrnament(value === currentValue
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
    }

    _updateProfileOrnaments() {
        this._updateItemOrnaments(this._profileItems, this._stateManager.currentProfile);
    }

    _updatePowerModeOrnaments() {
        this._updateItemOrnaments(this._powerModeItems, this._stateManager.currentPowerMode);
    }

    _updateBatteryModeOrnaments() {
        this._updateItemOrnaments(this._batteryModeItems, this._stateManager.currentBatteryMode);
    }

    _updateStatusItem() {
        const batteryLevel = this._stateManager.batteryLevel;
        const batteryStatus = this._stateManager.getBatteryStatus();

        let statusText = `Battery: ${batteryLevel}%`;

        // Add charging status
        if (batteryStatus === 'Charging') {
            statusText += ' \u2022 Charging';
        } else if (batteryStatus === 'Discharging') {
            if (this._stateManager.forceDischargeEnabled)
                statusText += ' \u2022 Force discharging';
            else
                statusText += ' \u2022 Discharging';
        } else if (batteryStatus === 'Not charging') {
            statusText += ' \u2022 Charging inhibited';
        } else if (batteryStatus === 'Full') {
            statusText += ' \u2022 Full';
        }

        this._statusItem.label.text = statusText;
    }

    _updateForceDischargeToggle() {
        if (this._forceDischargeItem) {
            const state = this._stateManager.forceDischargeEnabled;
            if (this._forceDischargeItem._switch.state !== state)
                this._forceDischargeItem._switch.state = state;
        }
    }

    _updateIcon() {
        const profileId = this._stateManager.currentProfile;
        const powerMode = this._stateManager.currentPowerMode;

        // Use power mode icon for the toggle
        const modeConfig = POWER_MODES[powerMode];
        if (modeConfig)
            this.gicon = Gio.ThemedIcon.new(modeConfig.icon);
        else
            this.gicon = Gio.ThemedIcon.new('power-profile-balanced-symbolic');

        // Update header with profile info
        const profile = profileId ?
            ProfileMatcher.getProfileById(this._settings, profileId) : null;
        const headerSubtitle = profile ? profile.name : 'Custom';
        this.menu.setHeader(this.gicon, 'Power Manager', headerSubtitle);
    }

    destroy() {
        this._stateManager?.disconnectObject(this);
        this._settings?.disconnectObject(this);

        this._removeForceDischargeToggle();
        this._settings = null;
        this._stateManager = null;
        super.destroy();
    }
});

export const PowerManagerIndicator = GObject.registerClass(
class PowerManagerIndicator extends QuickSettings.SystemIndicator {
    constructor(settings, extensionObject, stateManager) {
        super();
        this._settings = settings;
        this._stateManager = stateManager;
        this._extensionObject = extensionObject;
        this._iconFolder = extensionObject.dir.get_child('icons/hicolor/scalable/actions').get_path();

        this._indicator = this._addIndicator();
        this._indicatorPosition = this._settings.get_int('indicator-position');
        this._indicatorIndex = this._settings.get_int('indicator-position-index');
        this._lastIndicatorPosition = this._indicatorPosition;

        // Create toggle
        this.quickSettingsItems.push(new PowerManagerToggle(this._settings, extensionObject, this._stateManager));
        QuickSettingsMenu.addExternalIndicator(this);
        QuickSettingsMenu._indicators.remove_child(this);
        QuickSettingsMenu._indicators.insert_child_at_index(this, this._indicatorIndex);
        this._updateLastIndicatorPosition();

        // Connect to state changes
        this._stateManagerId = this._stateManager.connect('state-changed', () => {
            this._updateIndicator();
        });

        // Connect to settings
        this._settings.connectObject(
            'changed::show-system-indicator', () => {
                this._updateIndicator();
            },
            'changed::indicator-position', () => {
                this._updateIndicatorPosition();
            },
            this
        );

        this._updateIndicator();
    }

    _getIcon(iconName) {
        const localPath = `${this._iconFolder}/${iconName}.svg`;
        const file = Gio.File.new_for_path(localPath);
        if (file.query_exists(null))
            return Gio.icon_new_for_string(localPath);
        return Gio.ThemedIcon.new(iconName);
    }

    _updateIndicator() {
        if (this._settings.get_boolean('show-system-indicator')) {
            this._indicator.visible = true;

            const profileId = this._stateManager.currentProfile;
            const powerMode = this._stateManager.currentPowerMode;

            // Get profile to check for custom icon
            const profile = profileId ?
                ProfileMatcher.getProfileById(this._settings, profileId) : null;

            let iconName;
            if (profile && profile.icon) {
                iconName = profile.icon;
            } else if (profileId === 'docked') {
                iconName = 'upm-docked-symbolic';
            } else if (profileId === 'travel') {
                iconName = 'upm-travel-symbolic';
            } else {
                // Use power mode icon
                const modeConfig = POWER_MODES[powerMode];
                iconName = modeConfig ? modeConfig.icon : 'power-profile-balanced-symbolic';
            }

            this._indicator.gicon = this._getIcon(iconName);
        } else {
            this._indicator.visible = false;
        }
    }

    _updateLastIndicatorPosition() {
        let pos = -1;
        const nbItems = QuickSettingsMenu._indicators.get_n_children();

        for (let i = 0; i < nbItems; i++) {
            const targetIndicator = QuickSettingsMenu._indicators.get_child_at_index(i);
            if (targetIndicator.is_visible())
                pos += 1;
        }
        this._settings.set_int('indicator-position-max', pos);
    }

    _incrementIndicatorPosIndex() {
        if (this._lastIndicatorPosition < this._indicatorPosition)
            this._indicatorIndex += 1;
        else
            this._indicatorIndex -= 1;
    }

    _updateIndicatorPosition() {
        this._updateLastIndicatorPosition();
        const newPosition = this._settings.get_int('indicator-position');

        if (this._indicatorPosition !== newPosition) {
            this._indicatorPosition = newPosition;
            this._incrementIndicatorPosIndex();

            let targetIndicator = QuickSettingsMenu._indicators.get_child_at_index(this._indicatorIndex);
            const maxIndex = QuickSettingsMenu._indicators.get_n_children();
            while (this._indicatorIndex < maxIndex && !targetIndicator.is_visible() && this._indicatorIndex > -1) {
                this._incrementIndicatorPosIndex();
                targetIndicator = QuickSettingsMenu._indicators.get_child_at_index(this._indicatorIndex);
            }

            if (this._indicatorPosition === 0)
                this._indicatorIndex = 0;

            this._lastIndicatorPosition = newPosition;

            QuickSettingsMenu._indicators.remove_child(this);
            QuickSettingsMenu._indicators.insert_child_at_index(this, this._indicatorIndex);
            this._settings.set_int('indicator-position-index', this._indicatorIndex);
        }
    }

    destroy() {
        if (this._stateManagerId) {
            this._stateManager.disconnect(this._stateManagerId);
            this._stateManagerId = null;
        }

        this._settings.disconnectObject(this);
        this.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._stateManager = null;
        this._settings = null;
        this._indicator = null;
        this.run_dispose();
    }
});
