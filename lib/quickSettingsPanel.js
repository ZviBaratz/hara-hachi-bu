/*
 * Hara Hachi Bu - GNOME Shell Extension
 * Copyright (C) 2024-2026 zvi
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as ProfileMatcher from './profileMatcher.js';
import * as ScheduleUtils from './scheduleUtils.js';
import {getIconFromPath} from './helper.js';

const _ = (s) => Gettext.dgettext('hara-hachi-bu', s);

const {BATTERY_MODES, POWER_MODES, isAutoManaged, getProfileDisplayName, getProfileIcon} = ProfileMatcher;

// Debounce delay for rebuilding battery mode items after threshold settings change
const BATTERY_MODE_REBUILD_DEBOUNCE_MS = 50;
const CLIPBOARD_FEEDBACK_TIMEOUT_MS = 2000;
const SUCCESS_FEEDBACK_TIMEOUT_MS = 1500;

const RadioIconMenuItem = GObject.registerClass(
    {GTypeName: 'HhbRadioIconMenuItem'},
    class RadioIconMenuItem extends PopupMenu.PopupMenuItem {
        constructor(text, iconName) {
            super(text);
            this._icon = new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
            });
            // Insert between _ornamentIcon (index 0) and label (index 1),
            // giving [ornament][icon][label] layout.
            this.insert_child_below(this._icon, this.label);
        }
    }
);

const PowerManagerToggle = GObject.registerClass(
    {GTypeName: 'HhbPowerManagerToggle'},
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
            this._successFeedbackTimeoutId = null;
            this._showingSuccessFeedback = false;
            this._cachedBatteryNeedsHelper = null;

            this._destroyed = false;
            this.title = _('Power');
            this._isHaraHachiBu = true;

            // Add accessible name for screen readers
            if (this.accessible) {
                this.accessible.accessible_name = _(
                    'Hara Hachi Bu - Switch power modes, battery thresholds, and scenarios'
                );
            }

            this._updateSubtitle();

            // Set up menu header
            this.menu.setHeader('power-profile-balanced-symbolic', _('Power'));
            if (this.menu.accessible)
                this.menu.accessible.accessible_description = _('Manage power profiles and battery charging modes');

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
                style_class: 'hhb-menu-scroll-section',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
            });

            this._scrollBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
            scrollView.set_child(this._scrollBox);

            // Add content to the scroll box
            this._scrollBox.add_child(this._errorSection.actor);

            // Inline operation error (hidden by default, shown on failed operations)
            this._inlineOperationError = new PopupMenu.PopupMenuSection();
            this._inlineErrorItem = new PopupMenu.PopupImageMenuItem(
                _('Failed to apply — tap to dismiss'),
                'dialog-error-symbolic'
            );
            this._inlineErrorItem.add_style_class_name('hhb-inline-error');
            this._inlineErrorItem.connectObject(
                'activate',
                () => {
                    this._clearInlineError();
                },
                this
            );
            this._inlineOperationError.addMenuItem(this._inlineErrorItem);
            this._inlineOperationError.actor.visible = false;
            this._scrollBox.add_child(this._inlineOperationError.actor);

            // Auto-management toggle (prominent position near top)
            this._addAutoManageSection();

            // Boost charge toggle (Quick Action, before profiles)
            if (this._stateManager.batteryControlAvailable) this._addBoostChargeToggle();

            // Profiles
            this._scrollBox.add_child(this._profileSection.actor);

            // Manual Overrides section (collapsible)
            const manualSep = new PopupMenu.PopupSeparatorMenuItem();
            this._scrollBox.add_child(manualSep.actor);
            this._scrollBox.add_child(this._manualOverridesSection.actor);

            // Force discharge toggle (if supported)
            if (this._stateManager.supportsForceDischarge && this._settings.get_boolean('show-force-discharge'))
                this._addForceDischargeToggle();

            // Add the scroll view to the menu via a wrapper section
            const scrollSection = new PopupMenu.PopupMenuSection();
            scrollSection.actor.add_child(scrollView);
            this.menu.addMenuItem(scrollSection);

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
            this._stateManager.connectObject(
                'state-changed',
                () => {
                    this._updateUI();
                },
                this
            );

            this._settings.connectObject(
                'changed::show-force-discharge',
                () => {
                    if (this._settings.get_boolean('show-force-discharge')) this._addForceDischargeToggle();
                    else this._removeForceDischargeToggle();
                },
                this
            );

            this._stateManager.connectObject(
                'boost-charge-changed',
                () => {
                    this._updateBoostChargeToggle();
                    this._updateBoostChargeState();
                },
                this
            );

            // Toggle click opens the menu
            this.connectObject(
                'clicked',
                () => {
                    this.menu.open();
                },
                this
            );

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
                    _('Setup Required — tap to copy install command'),
                    'dialog-warning-symbolic'
                );
                item.add_style_class_name('hhb-error-item');

                item.connectObject(
                    'activate',
                    () => {
                        const extDir = this._extensionObject.dir.get_path();
                        const command = `sudo "${extDir}/install-helper.sh"`;

                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, command);

                        // Visual feedback
                        const originalLabel = item.label.text;
                        item.label.text = _('Copied! Paste in terminal');
                        item.label.add_style_class_name('hhb-success');

                        if (this._clipboardFeedbackTimeoutId) {
                            GLib.Source.remove(this._clipboardFeedbackTimeoutId);
                            this._clipboardFeedbackTimeoutId = null;
                        }

                        this._clipboardFeedbackTimeoutId = GLib.timeout_add(
                            GLib.PRIORITY_DEFAULT,
                            CLIPBOARD_FEEDBACK_TIMEOUT_MS,
                            () => {
                                this._clipboardFeedbackTimeoutId = null;
                                if (item.label) {
                                    item.label.text = originalLabel;
                                    item.label.remove_style_class_name('hhb-success');
                                }
                                return GLib.SOURCE_REMOVE;
                            }
                        );

                        Main.notify(
                            _('Hara Hachi Bu'),
                            _(
                                'Installation command copied to clipboard.\n\nOpen terminal and paste (Ctrl+Shift+V) to enable battery threshold control.'
                            )
                        );
                    },
                    this
                );

                this._errorSection.addMenuItem(item);
                this._errorSection.actor.visible = true;
            } else {
                this._errorSection.actor.visible = false;
            }
        }

        _buildProfileSection() {
            // Section header (separator with label for correct screen reader semantics)
            const headerItem = new PopupMenu.PopupSeparatorMenuItem(_('Scenarios'));
            this._profileSection.addMenuItem(headerItem);

            // Build dynamic profile items
            this._rebuildProfileItems();

            // Watch for profile list changes
            this._settings.connectObject(
                'changed::custom-profiles',
                () => {
                    this._rebuildProfileItems();
                },
                this
            );
        }

        _rebuildProfileItems() {
            // Clear existing items (except header) — includes save-as items
            const items = this._profileSection._getMenuItems();
            items.slice(1).forEach((item) => item.destroy());

            this._profileItems = {};
            this._saveAsScenarioSep = null;
            this._saveAsScenarioItem = null;
            const profiles = ProfileMatcher.getCustomProfiles(this._settings);

            // When no profiles exist, show guidance; otherwise show the header
            const profileHeader = this._profileSection._getMenuItems()[0];
            if (profileHeader) profileHeader.actor.visible = profiles.length > 0;

            if (profiles.length === 0) {
                const hint = new PopupMenu.PopupMenuItem(_('Create scenarios in Settings to save mode combinations'), {
                    style_class: 'popup-menu-status-item',
                });
                hint.sensitive = false;
                this._profileSection.addMenuItem(hint);
            }

            for (const profile of profiles) {
                // Create label with optional "auto" badge
                let labelText = getProfileDisplayName(profile);
                const hasRules = isAutoManaged(profile);

                const item = new PopupMenu.PopupMenuItem(labelText);
                item.label.add_style_class_name('hhb-profile-label');
                item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

                // Add "Auto" badge if profile has rules
                if (hasRules) {
                    // Translators: Badge label meaning "automatically managed"
                    const badge = new St.Label({
                        text: _('Auto'),
                        style_class: 'hhb-auto-badge',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    if (badge.accessible) badge.accessible.accessible_name = _('Automatically managed scenario');
                    item.add_child(badge);
                }

                // Set accessible role and name for screen readers
                item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
                if (item.accessible) item.accessible.accessible_name = labelText;
                item._isAutoManaged = hasRules;

                item.connectObject(
                    'activate',
                    async () => {
                        if (this._isLoading) return;

                        this._setLoadingState(true, _('Applying %s...').format(getProfileDisplayName(profile)));

                        try {
                            const success = await this._stateManager.setProfile(profile.id);
                            if (!this._destroyed) {
                                if (success) {
                                    this._showSuccessConfirmation();
                                } else {
                                    this._showInlineError(_('Failed to apply scenario'));
                                    this._updateUI();
                                }
                            }
                        } finally {
                            if (this._stateManager) this._setLoadingState(false);
                        }
                    },
                    this
                );
                this._profileSection.addMenuItem(item);
                this._profileItems[profile.id] = item;
            }

            // "Save as Scenario" option (shown when no profile matches current modes)
            this._saveAsScenarioSep = new PopupMenu.PopupSeparatorMenuItem();
            this._profileSection.addMenuItem(this._saveAsScenarioSep);

            this._saveAsScenarioItem = new PopupMenu.PopupMenuItem(_('Save as Scenario\u2026'));
            this._saveAsScenarioItem.connectObject(
                'activate',
                () => {
                    this._saveAsScenario();
                },
                this
            );
            this._profileSection.addMenuItem(this._saveAsScenarioItem);

            this._updateProfileOrnaments();
            this._updateAutoSwitchVisibility();
            this._updateManualOverridesExpanded();
        }

        _buildManualOverridesSection() {
            // Collapsible header for Manual Overrides
            this._manualOverridesExpanded = false;
            this._manualOverridesHeader = new PopupMenu.PopupMenuItem(_('Manual Controls'), {
                style_class: 'popup-menu-section-header hhb-collapsible-header',
            });

            // Add expand/collapse indicator
            this._manualOverridesExpandIcon = new St.Icon({
                icon_name: 'pan-end-symbolic',
                style_class: 'popup-menu-arrow',
            });
            this._manualOverridesHeader.add_child(this._manualOverridesExpandIcon);

            this._manualOverridesHeader.connectObject(
                'activate',
                () => {
                    this._toggleManualOverrides();
                },
                this
            );
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
            this._settings.connectObject(
                'changed::auto-switch-enabled',
                () => {
                    this._updateManualOverridesExpanded();
                },
                this
            );
        }

        _toggleManualOverrides() {
            this._setManualOverridesExpanded(!this._manualOverridesExpanded);
        }

        _setManualOverridesExpanded(expanded) {
            this._manualOverridesExpanded = expanded;
            this._manualOverridesContent.actor.visible = expanded;
            this._manualOverridesExpandIcon.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';

            // Update accessible expanded state for screen readers
            if (this._manualOverridesHeader?.accessible) {
                this._manualOverridesHeader.accessible.accessible_name = expanded
                    ? _('Manual Controls (expanded)')
                    : _('Manual Controls (collapsed)');
            }
        }

        _updateManualOverridesExpanded() {
            if (!this._manualOverridesContent) return;
            const profiles = ProfileMatcher.getCustomProfiles(this._settings);
            const autoSwitchEnabled = this._settings.get_boolean('auto-switch-enabled');

            // Expand when: no profiles, auto-switch off, or no auto-managed profile is active.
            // This ensures first-run users always see the power/battery mode controls.
            const currentProfile = this._stateManager?.currentProfile;
            const activeIsAutoManaged = currentProfile
                ? profiles.some((p) => p.id === currentProfile && isAutoManaged(p))
                : false;
            const shouldExpand = profiles.length === 0 || !autoSwitchEnabled || !activeIsAutoManaged;

            if (this._manualOverridesHeader) this._manualOverridesHeader.label.text = _('Manual Controls');

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
                const item = new RadioIconMenuItem(label, config?.icon || 'power-profile-balanced-symbolic');
                item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
                if (item.accessible) item.accessible.accessible_name = label;
                item.connectObject(
                    'activate',
                    async () => {
                        if (this._isLoading) return;

                        this._setLoadingState(true, _('Applying %s...').format(label));
                        try {
                            this._stateManager.pauseAutoManage();
                            const success = await this._stateManager.setPowerMode(mode);
                            if (!this._destroyed) {
                                if (success) {
                                    this._showSuccessConfirmation();
                                } else {
                                    this._showInlineError(_('Failed to apply power mode'));
                                    this._updateUI();
                                }
                            }
                        } finally {
                            if (this._stateManager) this._setLoadingState(false);
                        }
                    },
                    this
                );
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
                'changed::threshold-full-start',
                () => this._scheduleBatteryModeRebuild(),
                'changed::threshold-full-end',
                () => this._scheduleBatteryModeRebuild(),
                'changed::threshold-balanced-start',
                () => this._scheduleBatteryModeRebuild(),
                'changed::threshold-balanced-end',
                () => this._scheduleBatteryModeRebuild(),
                'changed::threshold-lifespan-start',
                () => this._scheduleBatteryModeRebuild(),
                'changed::threshold-lifespan-end',
                () => this._scheduleBatteryModeRebuild(),
                this
            );
        }

        _buildBatteryModeItems() {
            // Battery mode items
            this._batteryModeItems = {};
            const batteryModes = this._stateManager.availableBatteryModes;

            // Hide header when no battery modes available
            if (this._batteryModeHeader) this._batteryModeHeader.actor.visible = batteryModes.length > 0;

            for (const mode of batteryModes) {
                const config = BATTERY_MODES[mode];
                const start = this._settings.get_int(config.startKey);
                const end = this._settings.get_int(config.endKey);
                const range = this._stateManager.hasStartThreshold
                    ? _('%d\u2013%d%%').format(start, end)
                    : _('charge to %d%%').format(end);
                const label = `${_(config.label)} (${range})`;
                const item = new RadioIconMenuItem(label, config?.icon || 'battery-good-symbolic');
                item.accessible_role = Atk.Role.RADIO_MENU_ITEM;
                if (item.accessible) item.accessible.accessible_name = `${label} — ${_(config.description)}`;
                item.connectObject(
                    'activate',
                    async () => {
                        if (this._isLoading) return;

                        this._setLoadingState(true, _('Applying %s...').format(_(config.label)));
                        try {
                            this._stateManager.pauseAutoManage();
                            const success = await this._stateManager.setBatteryMode(mode);
                            if (!this._destroyed) {
                                if (success) {
                                    // When on battery with a restrictive threshold, show
                                    // what will happen when the user next plugs in
                                    if (this._stateManager.onBattery && end < 100) {
                                        this._showSuccessConfirmation(
                                            _('Applied \u2014 will charge to %d%%').format(end)
                                        );
                                    } else {
                                        this._showSuccessConfirmation();
                                    }
                                } else {
                                    this._showInlineError(_('Failed to apply battery mode'));
                                    this._updateUI();
                                }
                            }
                        } finally {
                            if (this._stateManager) this._setLoadingState(false);
                        }
                    },
                    this
                );
                this._manualOverridesContent.addMenuItem(item);
                this._batteryModeItems[mode] = item;
            }
        }

        _scheduleBatteryModeRebuild() {
            if (this._batteryModeRebuildTimeout) GLib.Source.remove(this._batteryModeRebuildTimeout);

            this._batteryModeRebuildTimeout = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                BATTERY_MODE_REBUILD_DEBOUNCE_MS,
                () => {
                    this._batteryModeRebuildTimeout = null;
                    this._rebuildBatteryModeItems();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        _rebuildBatteryModeItems() {
            // Remove existing battery mode items
            for (const item of Object.values(this._batteryModeItems)) item.destroy();
            this._buildBatteryModeItems();
            this._updateBatteryModeOrnaments();
        }

        _addForceDischargeToggle() {
            if (this._forceDischargeItem) return;

            this._forceDischargeSeparator = new PopupMenu.PopupSeparatorMenuItem();
            const forceDischargeState = this._stateManager.forceDischargeEnabled;
            this._forceDischargeItem = new PopupMenu.PopupSwitchMenuItem(
                _('Use Battery While Plugged In'),
                forceDischargeState
            );
            if (this._forceDischargeItem.accessible) {
                this._forceDischargeItem.accessible.accessible_name = _(
                    'Use Battery While Plugged In: force the laptop to drain battery even when connected to AC'
                );
            }
            this._forceDischargeItem.setOrnament(PopupMenu.Ornament.HIDDEN);

            this._scrollBox.add_child(this._forceDischargeSeparator.actor);
            this._scrollBox.add_child(this._forceDischargeItem.actor);

            this._forceDischargeItem.connectObject(
                'toggled',
                async (o, state) => {
                    if (this._isLoading) return;
                    this._stateManager.pauseAutoManage();
                    this._setLoadingState(true, _('Applying...'));
                    try {
                        const success = await this._stateManager.setForceDischarge(state);
                        if (!this._destroyed) {
                            if (success) {
                                this._showSuccessConfirmation();
                            } else {
                                this._showInlineError(_('Failed to apply'));
                                this._updateForceDischargeToggle();
                            }
                        }
                    } finally {
                        if (this._stateManager) this._setLoadingState(false);
                    }
                },
                this
            );

            // Update initial state
            this._updateForceDischargeState();
        }

        _updateForceDischargeState() {
            if (!this._forceDischargeItem) return;

            const onBattery = this._stateManager.onBattery;
            this._forceDischargeItem.sensitive = !onBattery;
            this._forceDischargeItem.label.text = onBattery
                ? _('Use Battery While Plugged In (requires AC)')
                : _('Use Battery While Plugged In');
        }

        _addAutoManageSection() {
            this._autoManageSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this._scrollBox.add_child(this._autoManageSeparator.actor);

            // Auto-switch toggle
            this._autoSwitchToggle = new PopupMenu.PopupSwitchMenuItem(
                _('Auto-switch scenarios'),
                this._settings.get_boolean('auto-switch-enabled')
            );

            if (this._autoSwitchToggle.accessible) {
                this._autoSwitchToggle.accessible.accessible_name = _(
                    'Auto-switch scenarios: automatically apply scenarios when system conditions change'
                );
            }

            this._autoSwitchToggle.connectObject(
                'toggled',
                (item) => {
                    this._settings.set_boolean('auto-switch-enabled', item.state);
                },
                this
            );

            this._scrollBox.add_child(this._autoSwitchToggle.actor);

            // Paused indicator/resume button
            this._pausedIndicator = new PopupMenu.PopupMenuItem(_('Auto-switching paused (manual override)'));
            this._pausedIndicator.add_style_class_name('hhb-paused-indicator');

            // Add resume button
            this._resumeButton = new St.Button({
                label: _('Resume'),
                style_class: 'hhb-resume-button',
                can_focus: true,
                accessible_name: _('Resume automatic scenario switching'),
            });
            this._resumeButton.connectObject(
                'clicked',
                () => {
                    this._stateManager.resumeAutoManage();
                },
                this
            );
            this._pausedIndicator.add_child(this._resumeButton);

            this._scrollBox.add_child(this._pausedIndicator.actor);

            // Initially hidden
            this._updatePausedIndicator();
            this._updateAutoSwitchVisibility();

            // Listen for setting changes from preferences
            this._settings.connectObject(
                'changed::auto-switch-enabled',
                () => {
                    this._autoSwitchToggle.setToggleState(this._settings.get_boolean('auto-switch-enabled'));
                    this._updatePausedIndicator();
                },
                'changed::auto-manage-paused',
                () => {
                    this._updatePausedIndicator();
                },
                this
            );

            // Listen for state manager paused changes
            this._stateManager.connectObject(
                'auto-manage-paused-changed',
                (_manager, _paused) => {
                    this._updatePausedIndicator();
                    this._updateSubtitle();
                },
                this
            );
        }

        _updateAutoSwitchVisibility() {
            const profiles = ProfileMatcher.getCustomProfiles(this._settings);
            const hasAutoManaged = profiles.some((p) => isAutoManaged(p));
            if (this._autoManageSeparator) this._autoManageSeparator.actor.visible = hasAutoManaged;
            if (this._autoSwitchToggle) this._autoSwitchToggle.actor.visible = hasAutoManaged;
            if (!hasAutoManaged && this._pausedIndicator) this._pausedIndicator.actor.visible = false;
        }

        _updatePausedIndicator() {
            const autoSwitchEnabled = this._settings.get_boolean('auto-switch-enabled');
            const paused = this._stateManager.autoManagePaused;
            const profiles = ProfileMatcher.getCustomProfiles(this._settings);
            const hasAutoManaged = profiles.some((p) => isAutoManaged(p));

            // Show paused indicator only if auto-switch is enabled, paused, and auto-managed profiles exist
            this._pausedIndicator.actor.visible = autoSwitchEnabled && paused && hasAutoManaged;
        }

        _addBatteryHealthDisplay() {
            // Check if we should show battery health
            const showHealth = this._settings.get_boolean('show-battery-health');
            const threshold = this._settings.get_int('battery-health-threshold');
            const health = this._stateManager.batteryHealth;

            if (!showHealth || health === null) return; // Don't create display at all

            // Only show if health is below threshold (unless threshold is 100)
            if (threshold < 100 && health >= threshold) return;

            this._batteryHealthSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._batteryHealthSeparator);

            this._batteryHealthItem = new PopupMenu.PopupMenuItem(_('Maximum Capacity: %d%%').format(health));
            this._batteryHealthItem.reactive = false;
            this._batteryHealthItem.can_focus = false;
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
            if (!this._batteryHealthItem || !this._batteryHealthItem.label) return;

            // Remove all health color classes
            this._batteryHealthItem.label.remove_style_class_name('hhb-health-good');
            this._batteryHealthItem.label.remove_style_class_name('hhb-health-fair');
            this._batteryHealthItem.label.remove_style_class_name('hhb-health-poor');

            // Apply appropriate color and text descriptor based on health level
            let descriptor;
            // Translators: Battery health descriptors shown next to capacity percentage
            if (health >= 85) {
                this._batteryHealthItem.label.add_style_class_name('hhb-health-good');
                descriptor = _('Good');
            } else if (health >= 70) {
                this._batteryHealthItem.label.add_style_class_name('hhb-health-fair');
                descriptor = _('Fair');
            } else {
                this._batteryHealthItem.label.add_style_class_name('hhb-health-poor');
                descriptor = _('Poor');
            }

            this._batteryHealthItem.label.text = _('Maximum Capacity: %d%% (%s)').format(health, descriptor);
        }

        _addSettingsShortcut() {
            // Add separator and settings item outside of scroll area (footer)
            const separator = new PopupMenu.PopupSeparatorMenuItem();
            const settingsItem = new PopupMenu.PopupImageMenuItem(
                _('Power Manager Settings'),
                'emblem-system-symbolic'
            );
            settingsItem.connectObject(
                'activate',
                () => {
                    Main.panel.closeQuickSettings();
                    this._extensionObject.openPreferences();
                },
                this
            );

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

        _addBoostChargeToggle() {
            if (this._boostChargeItem) return;

            this._boostChargeSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this._boostChargeSeparator.add_style_class_name('hhb-quick-action-separator');
            this._boostChargeItem = new PopupMenu.PopupSwitchMenuItem(
                _('Boost Charge'),
                this._stateManager.boostChargeActive
            );
            if (this._boostChargeItem.accessible)
                this._boostChargeItem.accessible.accessible_name = _('Boost Charge: temporarily charge to 100%');
            this._boostChargeItem.setOrnament(PopupMenu.Ornament.HIDDEN);

            // Replace single label with a two-line vertical layout (title + subtitle)
            const labelBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._boostChargeTitleLabel = new St.Label({text: _('Boost Charge')});
            this._boostChargeSubtitle = new St.Label({
                text: _('Temporarily charge to 100%'),
                style_class: 'hhb-boost-subtitle',
            });
            labelBox.add_child(this._boostChargeTitleLabel);
            labelBox.add_child(this._boostChargeSubtitle);
            this._boostChargeItem.replace_child(this._boostChargeItem.label, labelBox);
            this._boostChargeItem.label = this._boostChargeTitleLabel;

            this._scrollBox.add_child(this._boostChargeSeparator.actor);
            this._scrollBox.add_child(this._boostChargeItem.actor);

            this._boostChargeItem.connectObject(
                'toggled',
                async () => {
                    if (this._isLoading) return;
                    this._setLoadingState(true, _('Applying boost charge...'));
                    try {
                        const success = await this._stateManager.toggleBoostCharge();
                        if (!this._destroyed) {
                            if (success) {
                                this._showSuccessConfirmation();
                            } else {
                                this._showInlineError(_('Failed to toggle boost charge'));
                                this._updateBoostChargeToggle();
                            }
                        }
                    } finally {
                        if (this._stateManager) this._setLoadingState(false);
                    }
                },
                this
            );

            this._updateBoostChargeState();
        }

        async _saveAsScenario() {
            if (this._isLoading) return;

            const profiles = ProfileMatcher.getCustomProfiles(this._settings);
            if (profiles.length >= ProfileMatcher.MAX_PROFILES) {
                this._showInlineError(_('Maximum scenario limit reached'));
                return;
            }

            // Generate unique name and ID
            const existingIds = new Set(profiles.map((p) => p.id));
            const existingNames = new Set(profiles.map((p) => p.name.toLowerCase()));
            let num = 1;
            let id, name;
            do {
                id = `custom-${num}`;
                name = _('Custom %d').format(num);
                num++;
            } while (existingIds.has(id) || existingNames.has(name.toLowerCase()));

            const powerMode = this._stateManager.currentPowerMode;
            const batteryMode = this._stateManager.currentBatteryMode;

            this._setLoadingState(true, _('Saving scenario...'));
            try {
                const success = ProfileMatcher.createProfile(this._settings, id, name, powerMode, batteryMode);

                if (!this._destroyed) {
                    if (success) {
                        await this._stateManager.setProfile(id);
                        if (!this._destroyed) this._showSuccessConfirmation();
                    } else {
                        this._showInlineError(_('Failed to save scenario'));
                        this._updateUI();
                    }
                }
            } finally {
                if (this._stateManager) this._setLoadingState(false);
            }
        }

        _updateBoostChargeState() {
            if (!this._boostChargeItem) return;

            const onBattery = this._stateManager.onBattery;
            const active = this._stateManager.boostChargeActive;
            // Disable when on battery, unless already active (to allow deactivation)
            this._boostChargeItem.sensitive = !onBattery || active;

            // Title stays constant; subtitle conveys contextual state
            if (active) {
                const level = this._stateManager.batteryLevel;
                const endTime = this._stateManager.boostChargeEndTime;
                let timeRemaining = '';
                if (endTime) {
                    const nowMs = Date.now();
                    const remainMs = endTime.getTime() - nowMs;
                    if (remainMs > 0) {
                        const remainMin = Math.ceil(remainMs / 60000);
                        if (remainMin >= 60) {
                            const h = Math.floor(remainMin / 60);
                            const m = remainMin % 60;
                            // Translators: time remaining for boost charge, e.g. "1h 23m left"
                            timeRemaining = m > 0 ? _('%dh %dm left').format(h, m) : _('%dh left').format(h);
                        } else {
                            // Translators: minutes remaining for boost charge, e.g. "23m left"
                            timeRemaining = _('%dm left').format(remainMin);
                        }
                    }
                }
                if (level > 0 && timeRemaining) {
                    this._boostChargeSubtitle.text = _('Charging to 100%% (%d%%) \u2014 %s').format(
                        level,
                        timeRemaining
                    );
                } else if (level > 0) {
                    this._boostChargeSubtitle.text = _('Charging to 100%% (%d%%)').format(level);
                } else {
                    this._boostChargeSubtitle.text = _('Charging to 100%...');
                }
            } else {
                this._boostChargeSubtitle.text = onBattery ? _('Requires AC power') : _('Temporarily charge to 100%');
            }
        }

        _updateBoostChargeToggle() {
            if (this._boostChargeItem) this._boostChargeItem.setToggleState(this._stateManager.boostChargeActive);
        }

        _removeBoostChargeToggle() {
            if (this._boostChargeItem) {
                this._boostChargeItem.destroy();
                this._boostChargeItem = null;
                this._boostChargeTitleLabel = null;
                this._boostChargeSubtitle = null;
            }
            if (this._boostChargeSeparator) {
                this._boostChargeSeparator.destroy();
                this._boostChargeSeparator = null;
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
            this._updateBoostChargeToggle();
            this._updateBoostChargeState();
            this._updateBatteryHealthDisplay();
            this._updatePausedIndicator();
            this._updateIcon();

            // Update checked state based on profile match
            this.checked = this._stateManager.currentProfile !== null;
        }

        _formatTime(seconds) {
            if (seconds <= 0) return '';

            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);

            if (hours > 0) return _('%dh %dm').format(hours, minutes);
            return _('%dm').format(minutes);
        }

        _getBatteryStatusText() {
            const batteryLevel = this._stateManager.batteryLevel;
            const batteryStatus = this._stateManager.getBatteryStatus();

            // Primary line: profile name + battery %
            const primaryParts = [];
            const currentProfile = this._stateManager.currentProfile;
            const autoSwitchEnabled = this._settings.get_boolean('auto-switch-enabled');
            const paused = this._stateManager.autoManagePaused;

            if (currentProfile) {
                const profile = ProfileMatcher.getCustomProfiles(this._settings).find((p) => p.id === currentProfile);
                if (profile) {
                    let profileText = getProfileDisplayName(profile);
                    if (autoSwitchEnabled && paused) profileText = _('%s (manual)').format(profileText);
                    primaryParts.push(profileText);
                }
            } else {
                const profiles = ProfileMatcher.getCustomProfiles(this._settings);
                if (profiles.length > 0) {
                    // Profiles exist but none match current settings
                    primaryParts.push(_('Custom settings'));
                }
                // If no profiles exist, omit scenario reference entirely (just show battery %)
            }

            primaryParts.push(_('%d%%').format(batteryLevel));
            const primary = primaryParts.join(' \u2022 ');

            // Secondary line: single most relevant status detail
            let secondary = null;

            if (this._stateManager.boostChargeActive) {
                const level = this._stateManager.batteryLevel;
                secondary = level > 0 ? _('Boost — Charging (%d%%)').format(level) : _('Boost Charge');
            } else if (batteryStatus === 'Charging') {
                const timeToFull = this._stateManager.timeToFull;
                secondary = timeToFull > 0 ? _('Charging (%s)').format(this._formatTime(timeToFull)) : _('Charging');
            } else if (batteryStatus === 'Discharging') {
                const timeToEmpty = this._stateManager.timeToEmpty;
                const isForce = this._stateManager.forceDischargeEnabled;
                if (timeToEmpty > 0) {
                    secondary = isForce
                        ? _('Using battery (%s)').format(this._formatTime(timeToEmpty))
                        : _('Discharging (%s)').format(this._formatTime(timeToEmpty));
                } else {
                    secondary = isForce ? _('Using battery on AC') : _('Discharging');
                }
            } else if (batteryStatus === 'Not charging') {
                const endThreshold = this._stateManager.currentEndThreshold;
                secondary = endThreshold > 0 ? _('Not charging (limit: %d%%)').format(endThreshold) : _('Not charging');
            } else if (batteryStatus === 'Full') {
                // Translators: Battery status when fully charged
                secondary = _('Full');
            }

            return secondary ? `${primary}\n${secondary}` : primary;
        }

        _updateSubtitle() {
            if (this._showingSuccessFeedback) return;
            this.subtitle = this._getBatteryStatusText();
        }

        _updateItemOrnaments(items, currentValue) {
            if (!items) return;
            for (const [value, item] of Object.entries(items)) {
                const isActive = value === currentValue;
                item.setOrnament(isActive ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);

                // Update accessible label for screen readers
                if (item.accessible && item.label) {
                    let name = item.label.text;
                    if (item._isAutoManaged) name += ` (${_('applies automatically')})`;
                    if (isActive) name += ` (${_('active')})`;
                    item.accessible.accessible_name = name;
                }
            }
        }

        _updateProfileOrnaments() {
            const currentProfile = this._stateManager.currentProfile;
            this._updateItemOrnaments(this._profileItems, currentProfile);

            // Show "Save as Scenario" when no profile matches current modes
            if (this._saveAsScenarioItem) {
                const visible = currentProfile === null;
                this._saveAsScenarioSep.actor.visible = visible;
                this._saveAsScenarioItem.actor.visible = visible;
            }

            // Add schedule end time to active profile label
            if (currentProfile && this._profileItems?.[currentProfile]) {
                const profileConfig = ProfileMatcher.getProfileById(this._settings, currentProfile);
                if (profileConfig?.schedule?.enabled) {
                    const endTime = ScheduleUtils.getScheduleEndTimeToday(profileConfig.schedule);
                    if (endTime) {
                        const item = this._profileItems[currentProfile];
                        const baseName = getProfileDisplayName(profileConfig);
                        const daysSummary = ScheduleUtils.formatDaysSummary(profileConfig.schedule.days);
                        item.label.text = daysSummary
                            ? _('%s (%s until %s)').format(baseName, daysSummary, endTime)
                            : _('%s (until %s)').format(baseName, endTime);

                        // Update accessible name with schedule context
                        if (item.accessible) {
                            const scheduleDesc = daysSummary
                                ? _('Scheduled %s until %s').format(daysSummary, endTime)
                                : _('Scheduled until %s').format(endTime);
                            let name = `${baseName} (${scheduleDesc})`;
                            if (item._isAutoManaged) name += ` (${_('applies automatically')})`;
                            name += ` (${_('active')})`;
                            item.accessible.accessible_name = name;
                        }
                    }
                }
            }
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
                this._clearInlineError();
                this._clearSuccessConfirmation();
                this.subtitle = message;
                this.add_style_class_name('hhb-loading-state');
                this._setMenuItemsSensitive(false);
            } else if (!loading) {
                this._updateSubtitle();
                this.remove_style_class_name('hhb-loading-state');
                this._setMenuItemsSensitive(true);
            }
        }

        _setMenuItemsSensitive(sensitive) {
            // Disable/enable profile items
            if (this._profileItems) {
                for (const item of Object.values(this._profileItems)) item.sensitive = sensitive;
            }

            // Disable/enable power mode items
            if (this._powerModeItems) {
                for (const item of Object.values(this._powerModeItems)) item.sensitive = sensitive;
            }

            // Disable/enable battery mode items
            if (this._batteryModeItems) {
                for (const item of Object.values(this._batteryModeItems)) item.sensitive = sensitive;
            }

            // Disable/enable force discharge toggle (respect AC-only constraint)
            if (this._forceDischargeItem)
                this._forceDischargeItem.sensitive = sensitive && !this._stateManager.onBattery;

            // Disable/enable boost charge toggle (AC-only, unless active for deactivation)
            if (this._boostChargeItem) {
                this._boostChargeItem.sensitive =
                    sensitive && (!this._stateManager.onBattery || this._stateManager.boostChargeActive);
            }

            // Disable/enable auto-switch toggle
            if (this._autoSwitchToggle) this._autoSwitchToggle.sensitive = sensitive;

            // Disable/enable save-as-scenario item
            if (this._saveAsScenarioItem) this._saveAsScenarioItem.sensitive = sensitive;
        }

        _showInlineError(message) {
            if (!this._inlineErrorItem) return;
            this._inlineErrorItem.label.text = message || _('Failed to apply — tap to dismiss');
            this._inlineOperationError.actor.visible = true;
        }

        _clearInlineError() {
            if (this._inlineOperationError) this._inlineOperationError.actor.visible = false;
        }

        _showSuccessConfirmation(message = null) {
            if (this._successFeedbackTimeoutId) {
                GLib.Source.remove(this._successFeedbackTimeoutId);
                this._successFeedbackTimeoutId = null;
            }

            this._showingSuccessFeedback = true;
            // Translators: Brief confirmation shown after settings are successfully applied
            this.subtitle = message || _('Applied');
            this.add_style_class_name('hhb-success-state');

            this._successFeedbackTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                SUCCESS_FEEDBACK_TIMEOUT_MS,
                () => {
                    this._successFeedbackTimeoutId = null;
                    this._showingSuccessFeedback = false;
                    this.remove_style_class_name('hhb-success-state');
                    this._updateSubtitle();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        _clearSuccessConfirmation() {
            if (this._successFeedbackTimeoutId) {
                GLib.Source.remove(this._successFeedbackTimeoutId);
                this._successFeedbackTimeoutId = null;
            }
            this._showingSuccessFeedback = false;
            this.remove_style_class_name('hhb-success-state');
        }

        _updateIcon() {
            const powerMode = this._stateManager.currentPowerMode;

            // Only recreate icon when power mode changes
            if (powerMode !== this._lastIconPowerMode) {
                this._lastIconPowerMode = powerMode;
                const modeConfig = POWER_MODES[powerMode];
                this.gicon = Gio.ThemedIcon.new(modeConfig?.icon || 'power-profile-balanced-symbolic');
            }

            // Update header with battery status (single-line for menu header)
            const headerText = this._getBatteryStatusText().replace('\n', ' \u2022 ');
            this.menu.setHeader(this.gicon, _('Power'), headerText);
        }

        destroy() {
            this._destroyed = true;

            // Clean up timeouts
            if (this._clipboardFeedbackTimeoutId) {
                GLib.Source.remove(this._clipboardFeedbackTimeoutId);
                this._clipboardFeedbackTimeoutId = null;
            }
            if (this._successFeedbackTimeoutId) {
                GLib.Source.remove(this._successFeedbackTimeoutId);
                this._successFeedbackTimeoutId = null;
            }
            if (this._batteryModeRebuildTimeout) {
                GLib.Source.remove(this._batteryModeRebuildTimeout);
                this._batteryModeRebuildTimeout = null;
            }

            this._stateManager?.disconnectObject(this);
            this._settings?.disconnectObject(this);

            this._removeForceDischargeToggle();
            this._removeBoostChargeToggle();

            this._resumeButton?.destroy();
            this._resumeButton = null;

            this._settings = null;
            this._stateManager = null;
            super.destroy();
        }
    }
);

export const PowerManagerIndicator = GObject.registerClass(
    {GTypeName: 'HhbPowerManagerIndicator'},
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

            // Restore position if possible.
            // Note: _indicators is a private property of QuickSettingsMenu. There is
            // no public API for indicator reordering. Tested on GNOME 46–48.
            try {
                if (
                    this._indicatorIndex >= 0 &&
                    this._indicatorIndex < quickSettingsMenu._indicators.get_n_children()
                ) {
                    quickSettingsMenu._indicators.remove_child(this);
                    quickSettingsMenu._indicators.insert_child_at_index(this, this._indicatorIndex);
                }
            } catch (e) {
                console.warn(`Hara Hachi Bu: Failed to restore indicator position: ${e}`);
            }

            this._updateLastIndicatorPosition();

            // Connect to state changes using connectObject for consistency
            this._stateManager.connectObject(
                'state-changed',
                () => {
                    this._updateIndicator();
                },
                this
            );

            // Connect to settings
            this._settings.connectObject(
                'changed::show-system-indicator',
                () => {
                    this._updateIndicator();
                },
                'changed::indicator-position',
                () => {
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

                // Get profile to check for dedicated icon
                const profile = profileId ? ProfileMatcher.getProfileById(this._settings, profileId) : null;

                let iconName;
                const profileIcon = profile ? getProfileIcon(profile) : null;
                if (profileIcon) {
                    iconName = profileIcon;
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
                if (targetIndicator.is_visible()) pos += 1;
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
                while (
                    this._indicatorIndex < maxIndex &&
                    this._indicatorIndex >= 0 &&
                    targetIndicator &&
                    !targetIndicator.is_visible() &&
                    iterations < maxIndex
                ) {
                    this._incrementIndicatorPosIndex(maxIndex);
                    targetIndicator = quickSettingsMenu._indicators.get_child_at_index(this._indicatorIndex);
                    iterations++;
                }

                if (this._indicatorPosition === 0) this._indicatorIndex = 0;

                this._lastIndicatorPosition = newPosition;

                quickSettingsMenu._indicators.remove_child(this);
                quickSettingsMenu._indicators.insert_child_at_index(this, this._indicatorIndex);
                this._settings.set_int('indicator-position-index', this._indicatorIndex);
            }
        }

        destroy() {
            this._stateManager?.disconnectObject(this);
            this._settings?.disconnectObject(this);

            this.quickSettingsItems.forEach((item) => item.destroy());
            this._indicator.destroy();
            this._stateManager = null;
            this._settings = null;
            this._indicator = null;
            super.destroy();
        }
    }
);
