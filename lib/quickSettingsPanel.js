/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as ProfileMatcher from './profileMatcher.js';
import {getIconFromPath} from './helper.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

const {BATTERY_MODES, POWER_MODES} = ProfileMatcher;

const PowerManagerToggle = GObject.registerClass(
class PowerManagerToggle extends QuickSettings.QuickMenuToggle {
    constructor(settings, extensionObject, stateManager) {
        super();
        this._settings = settings;
        this._stateManager = stateManager;
        this._extensionObject = extensionObject;
        this._iconFolder = extensionObject.dir.get_child('icons/hicolor/scalable/actions').get_path();

        this.title = _('Power');
        this._updateSubtitle();

        // Set up menu header
        this.menu.setHeader('power-profile-balanced-symbolic', _('Power'));

        // Create menu sections
        this._profileSection = new PopupMenu.PopupMenuSection();
        this._powerModeSection = new PopupMenu.PopupMenuSection();
        this._batteryModeSection = new PopupMenu.PopupMenuSection();

        // Add section headers and items
        this._buildProfileSection();
        this._buildPowerModeSection();
        this._buildBatteryModeSection();

        // Create scrollable container for main content sections
        const scrollView = new St.ScrollView({
            style_class: 'upm-menu-scroll-section',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        this._scrollBox = new St.BoxLayout({vertical: true});
        scrollView.set_child(this._scrollBox);

        // Add content to the scroll box
        this._scrollBox.add_child(this._profileSection.actor);

        const sep1 = new PopupMenu.PopupSeparatorMenuItem();
        this._scrollBox.add_child(sep1.actor);

        this._scrollBox.add_child(this._powerModeSection.actor);

        // Only show battery section if battery threshold control is available or helper is needed
        this._batteryControlAvailable = this._stateManager.availableBatteryModes.length > 0 || this._stateManager.batteryNeedsHelper;
        if (this._batteryControlAvailable) {
            const sep2 = new PopupMenu.PopupSeparatorMenuItem();
            this._scrollBox.add_child(sep2.actor);
            this._scrollBox.add_child(this._batteryModeSection.actor);
        }

        // Add the scroll view to the menu via a wrapper section
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollSection);

        // Force discharge toggle (if supported)
        if (this._stateManager.supportsForceDischarge &&
            this._settings.get_boolean('show-force-discharge')) {
            this._addForceDischargeToggle();
        }

        // Settings shortcut at the bottom
        this._addSettingsShortcut();

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
        return getIconFromPath(this._iconFolder, iconName);
    }

    _buildProfileSection() {
        // Section header
        const headerItem = new PopupMenu.PopupMenuItem(_('PROFILE'), {
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
        const headerItem = new PopupMenu.PopupMenuItem(_('POWER MODE'), {
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
        const headerItem = new PopupMenu.PopupMenuItem(_('BATTERY MODE'), {
            reactive: false,
            style_class: 'popup-menu-section-header',
        });
        headerItem.sensitive = false;
        this._batteryModeSection.addMenuItem(headerItem);

        // Helper missing warning
        if (this._stateManager.batteryNeedsHelper) {
            const item = new PopupMenu.PopupMenuItem(_('Setup Required (Click for Info)'));
            item.connectObject('activate', () => {
                Main.panel.closeQuickSettings();
                
                const extDir = this._extensionObject.dir.get_path();
                const command = `sudo "${extDir}/install-helper.sh"`;
                
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);
                
                Main.notify(
                    _('Unified Power Manager'),
                    _('Install command copied to clipboard!\nOpen a terminal and paste to enable battery features.')
                );
            }, this);
            this._batteryModeSection.addMenuItem(item);
            return;
        }

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

    _addForceDischargeToggle() {
        if (this._forceDischargeItem)
            return;

        this._forceDischargeSeparator = new PopupMenu.PopupSeparatorMenuItem();
        const forceDischargeState = this._stateManager.forceDischargeEnabled;
        this._forceDischargeItem = new PopupMenu.PopupSwitchMenuItem(_('Force Discharge'), forceDischargeState);
        this._forceDischargeItem.setOrnament(PopupMenu.Ornament.HIDDEN);

        this._scrollBox.add_child(this._forceDischargeSeparator.actor);
        this._scrollBox.add_child(this._forceDischargeItem.actor);

        this._forceDischargeItem.activate = _ => {
            if (this._forceDischargeItem._switch.mapped)
                this._forceDischargeItem.toggle();
        };
        this._forceDischargeItem.connectObject('toggled', (o, state) => {
            this._stateManager.setForceDischarge(state);
        });
    }

    _addSettingsShortcut() {
        // Add separator and settings item outside of scroll area (footer)
        const separator = new PopupMenu.PopupSeparatorMenuItem();
        const settingsItem = new PopupMenu.PopupImageMenuItem(
            _('Extension Settings'),
            'emblem-system-symbolic'
        );
        settingsItem.connectObject('activate', () => {
            Main.panel.closeQuickSettings();
            this._extensionObject.openPreferences();
        }, this);

        // Add to menu as footer (outside scrollable area)
        this.menu.addMenuItem(separator);
        this.menu.addMenuItem(settingsItem);
    }

    _removeForceDischargeToggle() {
        if (this._forceDischargeItem) {
            this._forceDischargeItem.destroy();
            this._forceDischargeItem = null;
        }
        if (this._forceDischargeSeparator) {
            this._forceDischargeSeparator.destroy();
            this._forceDischargeSeparator = null;
        }
    }

    _cycleProfile() {
        const profiles = this._stateManager.availableProfiles;
        if (!profiles || profiles.length === 0) {
            console.warn('Unified Power Manager: No profiles available to cycle');
            return;
        }

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
        this._updateForceDischargeToggle();
        this._updateIcon();

        // Update checked state based on profile match
        this.checked = this._stateManager.currentProfile !== null;
    }

    _getBatteryStatusText() {
        const batteryLevel = this._stateManager.batteryLevel;
        const batteryStatus = this._stateManager.getBatteryStatus();

        let statusText = `${batteryLevel}%`;

        if (batteryStatus === 'Charging') {
            statusText += _(' \u2022 Charging');
        } else if (batteryStatus === 'Discharging') {
            if (this._stateManager.forceDischargeEnabled)
                statusText += _(' \u2022 Force discharging');
            else
                statusText += _(' \u2022 Discharging');
        } else if (batteryStatus === 'Not charging') {
            statusText += _(' \u2022 Charging inhibited');
        } else if (batteryStatus === 'Full') {
            statusText += _(' \u2022 Full');
        }

        return statusText;
    }

    _updateSubtitle() {
        this.subtitle = this._getBatteryStatusText();
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

    _updateForceDischargeToggle() {
        if (this._forceDischargeItem) {
            const state = this._stateManager.forceDischargeEnabled;
            if (this._forceDischargeItem._switch.state !== state)
                this._forceDischargeItem._switch.state = state;
        }
    }

    _updateIcon() {
        const powerMode = this._stateManager.currentPowerMode;

        // Use power mode icon for the toggle
        const modeConfig = POWER_MODES[powerMode];
        if (modeConfig)
            this.gicon = Gio.ThemedIcon.new(modeConfig.icon);
        else
            this.gicon = Gio.ThemedIcon.new('power-profile-balanced-symbolic');

        // Update header with battery status
        this.menu.setHeader(this.gicon, _('Power'), this._getBatteryStatusText());
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

        const quickSettingsMenu = Main.panel.statusArea.quickSettings;

        // Create toggle
        this.quickSettingsItems.push(new PowerManagerToggle(this._settings, extensionObject, this._stateManager));
        quickSettingsMenu.addExternalIndicator(this);
        
        // Restore position if possible
        try {
            if (this._indicatorIndex >= 0 && this._indicatorIndex < quickSettingsMenu._indicators.get_n_children()) {
                quickSettingsMenu._indicators.remove_child(this);
                quickSettingsMenu._indicators.insert_child_at_index(this, this._indicatorIndex);
            }
        } catch (e) {
            console.warn(`Unified Power Manager: Failed to restore indicator position: ${e}`);
        }

        this._updateLastIndicatorPosition();

        // Connect to state changes using connectObject for consistency
        this._stateManager.connectObject('state-changed', () => {
            this._updateIndicator();
        }, this);

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
        return getIconFromPath(this._iconFolder, iconName);
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
        const quickSettingsMenu = Main.panel.statusArea.quickSettings;
        const nbItems = quickSettingsMenu._indicators.get_n_children();

        for (let i = 0; i < nbItems; i++) {
            const targetIndicator = quickSettingsMenu._indicators.get_child_at_index(i);
            if (targetIndicator.is_visible())
                pos += 1;
        }
        this._settings.set_int('indicator-position-max', pos);
    }

    _incrementIndicatorPosIndex(maxIndex) {
        const delta = this._lastIndicatorPosition < this._indicatorPosition ? 1 : -1;
        this._indicatorIndex = Math.max(0, Math.min(maxIndex - 1, this._indicatorIndex + delta));
    }

    _updateIndicatorPosition() {
        this._updateLastIndicatorPosition();
        const newPosition = this._settings.get_int('indicator-position');

        if (this._indicatorPosition !== newPosition) {
            this._indicatorPosition = newPosition;

            const quickSettingsMenu = Main.panel.statusArea.quickSettings;
            const maxIndex = quickSettingsMenu._indicators.get_n_children();

            this._incrementIndicatorPosIndex(maxIndex);

            let targetIndicator = quickSettingsMenu._indicators.get_child_at_index(this._indicatorIndex);
            let iterations = 0;
            while (this._indicatorIndex < maxIndex &&
                   this._indicatorIndex >= 0 &&
                   targetIndicator && !targetIndicator.is_visible() &&
                   iterations < maxIndex) {
                this._incrementIndicatorPosIndex(maxIndex);
                targetIndicator = quickSettingsMenu._indicators.get_child_at_index(this._indicatorIndex);
                iterations++;
            }

            if (this._indicatorPosition === 0)
                this._indicatorIndex = 0;

            this._lastIndicatorPosition = newPosition;

            quickSettingsMenu._indicators.remove_child(this);
            quickSettingsMenu._indicators.insert_child_at_index(this, this._indicatorIndex);
            this._settings.set_int('indicator-position-index', this._indicatorIndex);
        }
    }

    destroy() {
        this._stateManager?.disconnectObject(this);
        this._settings?.disconnectObject(this);

        this.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._stateManager = null;
        this._settings = null;
        this._indicator = null;
        this.run_dispose();
    }
});
