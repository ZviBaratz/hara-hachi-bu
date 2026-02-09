/*
 * Unified Power Manager - GNOME Shell Extension
 * Copyright (C) 2024 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as ProfileMatcher from './profileMatcher.js';
import {getIconFromPath} from './helper.js';

const _ = s => Gettext.dgettext('unified-power-manager', s);

const {BATTERY_MODES, POWER_MODES, isAutoManaged} = ProfileMatcher;

// Debounce delay for rebuilding battery mode items after threshold settings change
const BATTERY_MODE_REBUILD_DEBOUNCE_MS = 50;
const CLIPBOARD_FEEDBACK_TIMEOUT_MS = 2000;

const PowerManagerToggle = GObject.registerClass(
class PowerManagerToggle extends QuickSettings.QuickMenuToggle {
    constructor(settings, extensionObject, stateManager) {
        super();
        this._settings = settings;
        this._stateManager = stateManager;
        this._extensionObject = extensionObject;
        this._iconFolder = extensionObject.dir.get_child('icons/hicolor/scalable/actions').get_path();
        this._clipboardFeedbackTimeoutId = null;
        this._batteryModeRebuildTimeout = null;
        this._isLoading = false;
        this._cachedBatteryNeedsHelper = null;

        this.title = _('Power');
        this._isUnifiedPowerManager = true;

        // Add accessible name for screen readers
        if (this.accessible) {
            this.accessible.accessible_name = _('Unified Power Manager - Switch power modes, battery thresholds, and profiles');
        }

        this._updateSubtitle();

        // Set up menu header
        this.menu.setHeader('power-profile-balanced-symbolic', _('Power'));
        if (this.menu.accessible) {
            this.menu.accessible.accessible_description = _('Manage power profiles and battery charging modes');
        }

        // Create menu sections
        this._errorSection = new PopupMenu.PopupMenuSection();
        this._profileSection = new PopupMenu.PopupMenuSection();
        this._manualOverridesSection = new PopupMenu.PopupMenuSection();
        this._powerModeSection = new PopupMenu.PopupMenuSection();

        // Add section headers and items
        this._buildErrorSection();
        this._buildProfileSection();
        this._buildManualOverridesSection();

        // Create scrollable container for main content sections
        const scrollView = new St.ScrollView({
            style_class: 'upm-menu-scroll-section',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        this._scrollBox = new St.BoxLayout({vertical: true});
        scrollView.set_child(this._scrollBox);

        // Add content to the scroll box
        this._scrollBox.add_child(this._errorSection.actor);
        this._scrollBox.add_child(this._profileSection.actor);

        // Manual Overrides section (collapsible)
        const manualSep = new PopupMenu.PopupSeparatorMenuItem();
        this._scrollBox.add_child(manualSep.actor);
        this._scrollBox.add_child(this._manualOverridesSection.actor);

        // Add the scroll view to the menu via a wrapper section
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scrollView);
        this.menu.addMenuItem(scrollSection);

        // Force discharge toggle (if supported)
        if (this._stateManager.supportsForceDischarge &&
            this._settings.get_boolean('show-force-discharge')) {
            this._addForceDischargeToggle();
        }

        // Auto-management status and toggle
        this._addAutoManageSection();

        // Battery health display (if enabled)
        this._addBatteryHealthDisplay();

        // Listen for battery health settings changes (outside _addBatteryHealthDisplay
        // to avoid duplicate handlers on each rebuild)
        this._settings.connectObject(
            'changed::show-battery-health',
            () => this._rebuildBatteryHealthDisplay(),
            'changed::battery-health-threshold',
            () => this._rebuildBatteryHealthDisplay(),
            this
        );

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

        // Toggle click opens the menu
        this.connectObject('clicked', () => {
            this.menu.open();
        }, this);

        // Initial toggle state
        this.checked = this._stateManager.currentProfile !== null;

        this._updateUI();
    }

    _getIcon(iconName) {
        return getIconFromPath(this._iconFolder, iconName);
    }

    _buildErrorSection() {
        // Cancel any pending clipboard feedback timeout before rebuilding
        if (this._clipboardFeedbackTimeoutId) {
            GLib.Source.remove(this._clipboardFeedbackTimeoutId);
            this._clipboardFeedbackTimeoutId = null;
        }

        // Clear existing items
        this._errorSection.removeAll();

        // Helper missing warning
        if (this._stateManager.batteryNeedsHelper) {
            const item = new PopupMenu.PopupImageMenuItem(
                _('Battery Control: Install Helper Script'),
                'dialog-warning-symbolic'
            );
            item.add_style_class_name('upm-error-item');

            item.connectObject('activate', () => {
                const extDir = this._extensionObject.dir.get_path();
                const command = `sudo "${extDir}/install-helper.sh"`;

                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);

                // Visual feedback
                const originalLabel = item.label.text;
                item.label.text = _('Copied! Paste in terminal');
                item.label.add_style_class_name('success');

                if (this._clipboardFeedbackTimeoutId) {
                    GLib.Source.remove(this._clipboardFeedbackTimeoutId);
                    this._clipboardFeedbackTimeoutId = null;
                }

                this._clipboardFeedbackTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLIPBOARD_FEEDBACK_TIMEOUT_MS, () => {
                    this._clipboardFeedbackTimeoutId = null;
                    if (item.label) {
                        item.label.text = originalLabel;
                        item.label.remove_style_class_name('success');
                    }
                    return GLib.SOURCE_REMOVE;
                });

                Main.notify(
                    _('Unified Power Manager'),
                    _('Installation command copied to clipboard.\n\nOpen terminal and paste (Ctrl+Shift+V) to enable battery threshold control.')
                );
            }, this);

            this._errorSection.addMenuItem(item);
            this._errorSection.actor.visible = true;
        } else {
            this._errorSection.actor.visible = false;
        }
    }

    _buildProfileSection() {
        // Section header (separator with label for correct screen reader semantics)
        const headerItem = new PopupMenu.PopupSeparatorMenuItem(_('Profiles'));
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

        // Hide profile section when no profiles exist
        const profileHeader = this._profileSection._getMenuItems()[0];
        if (profileHeader)
            profileHeader.actor.visible = profiles.length > 0;

        for (const profile of profiles) {
            // Create label with optional "auto" badge
            let labelText = profile.name;
            const hasRules = isAutoManaged(profile);

            const item = new PopupMenu.PopupMenuItem(labelText);
            item.label.add_style_class_name('upm-profile-label');

            // Add "auto" badge if profile has rules
            if (hasRules) {
                const badge = new St.Label({
                    text: _('auto'),
                    style_class: 'upm-auto-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                    accessible_name: _('Automatically managed profile'),
                });
                item.add_child(badge);
            }

            // Set accessible role for screen readers
            item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
            item._isAutoManaged = hasRules;

            item.connectObject('activate', async () => {
                // Prevent double-clicks during loading
                if (this._isLoading)
                    return;

                // Show loading state
                this._setLoadingState(true, _('Applying %s...').format(profile.name));

                try {
                    await this._stateManager.setProfile(profile.id);
                } finally {
                    this._setLoadingState(false);
                }
            }, this);
            this._profileSection.addMenuItem(item);
            this._profileItems[profile.id] = item;
        }

        this._updateProfileOrnaments();
        this._updateAutoSwitchVisibility();
        this._updateManualOverridesExpanded();
    }

    _buildManualOverridesSection() {
        // Collapsible header for Manual Overrides
        this._manualOverridesExpanded = false;
        this._manualOverridesHeader = new PopupMenu.PopupMenuItem(_('Power & Battery'), {
            style_class: 'popup-menu-section-header upm-collapsible-header',
        });

        // Add expand/collapse indicator
        this._manualOverridesExpandIcon = new St.Icon({
            icon_name: 'pan-end-symbolic',
            style_class: 'popup-menu-arrow',
        });
        this._manualOverridesHeader.add_child(this._manualOverridesExpandIcon);

        this._manualOverridesHeader.connectObject('activate', () => {
            this._toggleManualOverrides();
        }, this);
        this._manualOverridesSection.addMenuItem(this._manualOverridesHeader);

        // Container for collapsible content
        this._manualOverridesContent = new PopupMenu.PopupMenuSection();
        this._manualOverridesSection.addMenuItem(this._manualOverridesContent);

        // Build power mode subsection
        this._buildPowerModeSection();
        // Build battery mode subsection
        this._buildBatteryModeSection();

        // Auto-expand when profiles section is empty or auto-switch is off
        this._updateManualOverridesExpanded();

        // Re-evaluate when auto-switch setting changes
        this._settings.connectObject('changed::auto-switch-enabled', () => {
            this._updateManualOverridesExpanded();
        }, this);
    }

    _toggleManualOverrides() {
        this._setManualOverridesExpanded(!this._manualOverridesExpanded);
    }

    _setManualOverridesExpanded(expanded) {
        this._manualOverridesExpanded = expanded;
        this._manualOverridesContent.actor.visible = expanded;
        this._manualOverridesExpandIcon.icon_name = expanded
            ? 'pan-down-symbolic'
            : 'pan-end-symbolic';

        // Update accessible expanded state for screen readers
        if (this._manualOverridesHeader) {
            this._manualOverridesHeader.accessible_name = expanded
                ? _('Power & Battery (expanded)')
                : _('Power & Battery (collapsed)');
        }
    }

    _updateManualOverridesExpanded() {
        if (!this._manualOverridesContent) return;
        const profiles = ProfileMatcher.getCustomProfiles(this._settings);
        const autoSwitchEnabled = this._settings.get_boolean('auto-switch-enabled');
        const shouldExpand = profiles.length === 0 || !autoSwitchEnabled;

        if (this._manualOverridesHeader)
            this._manualOverridesHeader.label.text = _('Power & Battery');

        this._setManualOverridesExpanded(shouldExpand);
    }

    _buildPowerModeSection() {
        // Section header (separator with label for correct screen reader semantics)
        const headerItem = new PopupMenu.PopupSeparatorMenuItem(_('Power Mode'));
        this._manualOverridesContent.addMenuItem(headerItem);

        // Power mode items
        this._powerModeItems = {};
        const powerModes = this._stateManager.availablePowerModes;

        for (const mode of powerModes) {
            const config = POWER_MODES[mode];
            const label = config ? _(config.label) : mode;
            const item = new PopupMenu.PopupImageMenuItem(label, config?.icon || 'power-profile-balanced-symbolic');
            item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
            item.connectObject('activate', async () => {
                // Prevent double-clicks during loading
                if (this._isLoading)
                    return;

                this._setLoadingState(true, _('Applying %s...').format(label));
                try {
                    // Manual mode change - this will pause auto-management
                    this._stateManager.pauseAutoManage();
                    await this._stateManager.setPowerMode(mode);
                } finally {
                    this._setLoadingState(false);
                }
            }, this);
            this._manualOverridesContent.addMenuItem(item);
            this._powerModeItems[mode] = item;
        }
    }

    _buildBatteryModeSection() {
        // Section header (separator with label doubles as visual separator)
        this._batteryModeHeader = new PopupMenu.PopupSeparatorMenuItem(_('Battery Mode'));
        this._manualOverridesContent.addMenuItem(this._batteryModeHeader);

        this._buildBatteryModeItems();

        // Rebuild battery mode items when threshold settings change (debounced)
        this._settings.connectObject(
            'changed::threshold-full-start', () => this._scheduleBatteryModeRebuild(),
            'changed::threshold-full-end', () => this._scheduleBatteryModeRebuild(),
            'changed::threshold-balanced-start', () => this._scheduleBatteryModeRebuild(),
            'changed::threshold-balanced-end', () => this._scheduleBatteryModeRebuild(),
            'changed::threshold-lifespan-start', () => this._scheduleBatteryModeRebuild(),
            'changed::threshold-lifespan-end', () => this._scheduleBatteryModeRebuild(),
            this
        );
    }

    _buildBatteryModeItems() {
        // Battery mode items
        this._batteryModeItems = {};
        const batteryModes = this._stateManager.availableBatteryModes;

        // Hide header when no battery modes available
        if (this._batteryModeHeader)
            this._batteryModeHeader.actor.visible = batteryModes.length > 0;

        for (const mode of batteryModes) {
            const config = BATTERY_MODES[mode];
            const start = this._settings.get_int(config.startKey);
            const end = this._settings.get_int(config.endKey);
            const label = this._stateManager.hasStartThreshold
                ? `${_(config.label)} (${start}-${end}%)`
                : `${_(config.label)} (${_('charge to %d%%').format(end)})`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
            item.connectObject('activate', async () => {
                // Prevent double-clicks during loading
                if (this._isLoading)
                    return;

                this._setLoadingState(true, _('Applying %s...').format(_(config.label)));
                try {
                    // Manual mode change - this will pause auto-management
                    this._stateManager.pauseAutoManage();
                    await this._stateManager.setBatteryMode(mode);
                } finally {
                    this._setLoadingState(false);
                }
            }, this);
            this._manualOverridesContent.addMenuItem(item);
            this._batteryModeItems[mode] = item;
        }
    }

    _scheduleBatteryModeRebuild() {
        if (this._batteryModeRebuildTimeout) {
            GLib.Source.remove(this._batteryModeRebuildTimeout);
        }
        this._batteryModeRebuildTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATTERY_MODE_REBUILD_DEBOUNCE_MS, () => {
            this._batteryModeRebuildTimeout = null;
            this._rebuildBatteryModeItems();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildBatteryModeItems() {
        // Remove existing battery mode items
        for (const item of Object.values(this._batteryModeItems))
            item.destroy();
        this._buildBatteryModeItems();
        this._updateBatteryModeOrnaments();
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

        this._forceDischargeItem.connectObject('toggled', async (o, state) => {
            if (this._isLoading) return;
            this._stateManager.pauseAutoManage();
            this._setLoadingState(true, _('Applying force discharge...'));
            try {
                const success = await this._stateManager.setForceDischarge(state);
                if (!success)
                    this._updateForceDischargeToggle();
            } finally {
                this._setLoadingState(false);
            }
        }, this);

        // Update initial state
        this._updateForceDischargeState();
    }

    _updateForceDischargeState() {
        if (!this._forceDischargeItem)
            return;

        const onBattery = this._stateManager.onBattery;
        this._forceDischargeItem.sensitive = !onBattery;
        this._forceDischargeItem.label.text = onBattery
            ? _('Force Discharge (AC only)')
            : _('Force Discharge');
    }

    _addAutoManageSection() {
        this._autoManageSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._autoManageSeparator);

        // Auto-switch toggle
        this._autoSwitchToggle = new PopupMenu.PopupSwitchMenuItem(
            _('Auto-switch profiles'),
            this._settings.get_boolean('auto-switch-enabled')
        );

        this._autoSwitchToggle.connectObject('toggled', (item) => {
            this._settings.set_boolean('auto-switch-enabled', item.state);
        }, this);

        this.menu.addMenuItem(this._autoSwitchToggle);

        // Paused indicator/resume button
        this._pausedIndicator = new PopupMenu.PopupMenuItem(_('Auto-switch paused (manual override)'));
        this._pausedIndicator.add_style_class_name('upm-paused-indicator');

        // Add resume button
        const resumeButton = new St.Button({
            label: _('Resume'),
            style_class: 'upm-resume-button',
            can_focus: true,
            accessible_name: _('Resume automatic profile switching'),
        });
        resumeButton.connectObject('clicked', () => {
            this._stateManager.resumeAutoManage();
        }, this);
        this._pausedIndicator.add_child(resumeButton);

        this.menu.addMenuItem(this._pausedIndicator);

        // Initially hidden
        this._updatePausedIndicator();
        this._updateAutoSwitchVisibility();

        // Listen for setting changes from preferences
        this._settings.connectObject(
            'changed::auto-switch-enabled', () => {
                this._autoSwitchToggle.setToggleState(
                    this._settings.get_boolean('auto-switch-enabled')
                );
                this._updatePausedIndicator();
            },
            'changed::auto-manage-paused', () => {
                this._updatePausedIndicator();
            },
            this
        );

        // Listen for state manager paused changes
        this._stateManager.connectObject('auto-manage-paused-changed', (manager, paused) => {
            this._updatePausedIndicator();
        }, this);
    }

    _updateAutoSwitchVisibility() {
        const profiles = ProfileMatcher.getCustomProfiles(this._settings);
        const hasAutoManaged = profiles.some(p => isAutoManaged(p));
        if (this._autoManageSeparator)
            this._autoManageSeparator.actor.visible = hasAutoManaged;
        if (this._autoSwitchToggle)
            this._autoSwitchToggle.actor.visible = hasAutoManaged;
        if (!hasAutoManaged && this._pausedIndicator)
            this._pausedIndicator.actor.visible = false;
    }

    _updatePausedIndicator() {
        const autoSwitchEnabled = this._settings.get_boolean('auto-switch-enabled');
        const paused = this._stateManager.autoManagePaused;
        const profiles = ProfileMatcher.getCustomProfiles(this._settings);
        const hasAutoManaged = profiles.some(p => isAutoManaged(p));

        // Show paused indicator only if auto-switch is enabled, paused, and auto-managed profiles exist
        this._pausedIndicator.actor.visible = autoSwitchEnabled && paused && hasAutoManaged;
    }

    _addBatteryHealthDisplay() {
        // Check if we should show battery health
        const showHealth = this._settings.get_boolean('show-battery-health');
        const threshold = this._settings.get_int('battery-health-threshold');
        const health = this._stateManager.batteryHealth;

        if (!showHealth || health === null) {
            return; // Don't create display at all
        }

        // Only show if health is below threshold (unless threshold is 100)
        if (threshold < 100 && health >= threshold) {
            return;
        }

        this._batteryHealthSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._batteryHealthSeparator);

        this._batteryHealthItem = new PopupMenu.PopupMenuItem(
            _('Maximum Capacity: %d%%').format(health)
        );
        this._batteryHealthItem.sensitive = false;
        this.menu.addMenuItem(this._batteryHealthItem);

        // Apply initial color
        this._updateBatteryHealthColor(health);
    }

    _rebuildBatteryHealthDisplay() {
        // Destroy existing display if present
        if (this._batteryHealthSeparator) {
            this._batteryHealthSeparator.destroy();
            this._batteryHealthSeparator = null;
        }
        if (this._batteryHealthItem) {
            this._batteryHealthItem.destroy();
            this._batteryHealthItem = null;
        }

        // Recreate based on current settings
        this._addBatteryHealthDisplay();
    }

    _updateBatteryHealthDisplay() {
        if (!this._batteryHealthItem) {
            // Check if we should create it now
            this._rebuildBatteryHealthDisplay();
            return;
        }

        const health = this._stateManager.batteryHealth;
        const threshold = this._settings.get_int('battery-health-threshold');

        // Validate health value
        if (health === null || health < 0) {
            if (this._batteryHealthSeparator) {
                this._batteryHealthSeparator.destroy();
                this._batteryHealthSeparator = null;
            }
            this._batteryHealthItem.destroy();
            this._batteryHealthItem = null;
            return;
        }

        // Clamp invalid values
        const clampedHealth = Math.min(100, Math.max(0, health));

        // Check if we should hide based on threshold
        if (threshold < 100 && clampedHealth >= threshold) {
            if (this._batteryHealthSeparator) {
                this._batteryHealthSeparator.destroy();
                this._batteryHealthSeparator = null;
            }
            this._batteryHealthItem.destroy();
            this._batteryHealthItem = null;
            return;
        }

        this._batteryHealthItem.label.text = _('Maximum Capacity: %d%%').format(clampedHealth);

        // Update color
        this._updateBatteryHealthColor(clampedHealth);
    }

    _updateBatteryHealthColor(health) {
        if (!this._batteryHealthItem || !this._batteryHealthItem.label)
            return;

        // Remove all health color classes
        this._batteryHealthItem.label.remove_style_class_name('health-good');
        this._batteryHealthItem.label.remove_style_class_name('health-fair');
        this._batteryHealthItem.label.remove_style_class_name('health-poor');

        // Apply appropriate color and text descriptor based on health level
        let descriptor;
        if (health >= 85) {
            this._batteryHealthItem.label.add_style_class_name('health-good');
            descriptor = _('Good');
        } else if (health >= 70) {
            this._batteryHealthItem.label.add_style_class_name('health-fair');
            descriptor = _('Fair');
        } else {
            this._batteryHealthItem.label.add_style_class_name('health-poor');
            descriptor = _('Poor');
        }

        this._batteryHealthItem.label.text = _('Maximum Capacity: %d%% (%s)').format(health, descriptor);
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

    _updateUI() {
        // Only rebuild error section when batteryNeedsHelper state actually changes
        const needsHelper = this._stateManager.batteryNeedsHelper;
        if (needsHelper !== this._cachedBatteryNeedsHelper) {
            this._cachedBatteryNeedsHelper = needsHelper;
            this._buildErrorSection();
        }
        this._updateSubtitle();
        this._updateProfileOrnaments();
        this._updatePowerModeOrnaments();
        this._updateBatteryModeOrnaments();
        this._updateForceDischargeToggle();
        this._updateBatteryHealthDisplay();
        this._updatePausedIndicator();
        this._updateIcon();

        // Update checked state based on profile match
        this.checked = this._stateManager.currentProfile !== null;
    }

    _formatTime(seconds) {
        if (seconds <= 0)
            return '';

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours > 0)
            return _('%dh %dm').format(hours, minutes);
        return _('%dm').format(minutes);
    }

    _getBatteryStatusText() {
        const batteryLevel = this._stateManager.batteryLevel;
        const batteryStatus = this._stateManager.getBatteryStatus();

        const parts = [_('%d%%').format(batteryLevel)];

        if (batteryStatus === 'Charging') {
            const timeToFull = this._stateManager.timeToFull;
            if (timeToFull > 0)
                parts.push(_('Charging (%s remaining)').format(this._formatTime(timeToFull)));
            else
                parts.push(_('Charging'));
        } else if (batteryStatus === 'Discharging') {
            const timeToEmpty = this._stateManager.timeToEmpty;
            const isForce = this._stateManager.forceDischargeEnabled;
            if (timeToEmpty > 0) {
                parts.push(isForce
                    ? _('Force discharging (%s remaining)').format(this._formatTime(timeToEmpty))
                    : _('Discharging (%s remaining)').format(this._formatTime(timeToEmpty)));
            } else {
                parts.push(isForce ? _('Force discharging') : _('Discharging'));
            }
        } else if (batteryStatus === 'Not charging') {
            const endThreshold = this._stateManager.currentEndThreshold;
            if (endThreshold > 0)
                parts.push(_('Not charging (limit: %d%%)').format(endThreshold));
            else
                parts.push(_('Not charging'));
        } else if (batteryStatus === 'Full') {
            parts.push(_('Full'));
        }

        return parts.join(' \u2022 ');
    }

    _updateSubtitle() {
        this.subtitle = this._getBatteryStatusText();
    }

    _updateItemOrnaments(items, currentValue) {
        if (!items) return;
        for (const [value, item] of Object.entries(items)) {
            const isActive = (value === currentValue);
            item.setOrnament(isActive
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NONE);

            // Update accessible label for screen readers
            if (item.accessible && item.label) {
                let name = item.label.text;
                if (item._isAutoManaged)
                    name += ` (${_('auto-activates')})`;
                if (isActive)
                    name += ` (${_('active')})`;
                item.accessible.accessible_name = name;
            }
        }
    }

    _updateProfileOrnaments() {
        const currentProfile = this._stateManager.currentProfile;
        this._updateItemOrnaments(this._profileItems, currentProfile);
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
            this._forceDischargeItem.setToggleState(state);

            // Also update enabled/disabled state based on power source
            this._updateForceDischargeState();
        }
    }

    _setLoadingState(loading, message = null) {
        this._isLoading = loading;
        if (loading && message) {
            this._savedSubtitle = this.subtitle;
            this.subtitle = message;
            this.add_style_class_name('loading-state');
            this._setMenuItemsSensitive(false);
        } else if (!loading) {
            this._updateSubtitle();
            this._savedSubtitle = undefined;
            this.remove_style_class_name('loading-state');
            this._setMenuItemsSensitive(true);
        }
    }

    _setMenuItemsSensitive(sensitive) {
        // Disable/enable profile items
        if (this._profileItems) {
            for (const item of Object.values(this._profileItems)) {
                item.sensitive = sensitive;
            }
        }

        // Disable/enable power mode items
        if (this._powerModeItems) {
            for (const item of Object.values(this._powerModeItems)) {
                item.sensitive = sensitive;
            }
        }

        // Disable/enable battery mode items
        if (this._batteryModeItems) {
            for (const item of Object.values(this._batteryModeItems)) {
                item.sensitive = sensitive;
            }
        }

        // Disable/enable force discharge toggle
        if (this._forceDischargeItem) {
            this._forceDischargeItem.sensitive = sensitive;
        }

        // Disable/enable auto-switch toggle
        if (this._autoSwitchToggle) {
            this._autoSwitchToggle.sensitive = sensitive;
        }
    }

    _updateIcon() {
        const powerMode = this._stateManager.currentPowerMode;

        // Only recreate icon when power mode changes
        if (powerMode !== this._lastIconPowerMode) {
            this._lastIconPowerMode = powerMode;
            const modeConfig = POWER_MODES[powerMode];
            this.gicon = Gio.ThemedIcon.new(modeConfig?.icon || 'power-profile-balanced-symbolic');
        }

        // Update header with battery status
        this.menu.setHeader(this.gicon, _('Power'), this._getBatteryStatusText());
    }

    destroy() {
        // Clean up timeouts
        if (this._clipboardFeedbackTimeoutId) {
            GLib.Source.remove(this._clipboardFeedbackTimeoutId);
            this._clipboardFeedbackTimeoutId = null;
        }
        if (this._batteryModeRebuildTimeout) {
            GLib.Source.remove(this._batteryModeRebuildTimeout);
            this._batteryModeRebuildTimeout = null;
        }

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
        if (pos !== this._settings.get_int('indicator-position-max'))
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
        super.destroy();
    }
});
