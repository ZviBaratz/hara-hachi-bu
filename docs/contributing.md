# Contributing

Thank you for your interest in contributing! This guide covers development setup, conventions, and the pull request process.

## Quick Start

**Prerequisites:**

- GNOME Shell 46, 47, 48, or 49
- `glib-compile-schemas` (from `libglib2.0-dev` or equivalent)
- `power-profiles-daemon` (for power profile features)

!!! note
    If you already have the extension installed from extensions.gnome.org, disable and remove it first to avoid conflicts:
    `gnome-extensions disable hara-hachi-bu@ZviBaratz`

```bash
# Clone the repository
git clone https://github.com/ZviBaratz/hara-hachi-bu.git \
    ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz

# Compile schemas
cd ~/.local/share/gnome-shell/extensions/hara-hachi-bu@ZviBaratz
make schemas
```

## Mock Mode

Test the extension without battery hardware by enabling mock mode:

```bash
mkdir -p ~/.config/hara-hachi-bu
touch ~/.config/hara-hachi-bu/use_mock
```

This activates an in-memory device backend that simulates threshold and force-discharge controls. Remove the file to return to real hardware.

## Development Workflow

### Makefile Targets

| Target | Description |
|--------|-------------|
| `make dev` | Compile schemas and start a nested GNOME Shell session |
| `make nested` | Start a nested GNOME Shell session only |
| `make schemas` | Compile GSettings schemas |
| `make install` | Install extension to `~/.local/share/gnome-shell/extensions/` |
| `make pack` | Create release zip via `package.sh` |
| `make logs` | Follow GNOME Shell logs (`journalctl`) |
| `make clean` | Remove temporary/build files |

### Testing on X11 vs Wayland

- **X11:** Reload the extension with Alt+F2 → `r` → Enter.
- **Wayland:** JavaScript changes require a full **logout and login**. Disabling/enabling the extension alone does not reload code.

### Viewing Logs

```bash
# Follow all GNOME Shell logs
make logs

# Filter for extension output
journalctl -o cat /usr/bin/gnome-shell --since "5 minutes ago" | grep -i hara-hachi-bu
```

## Helper Script

Battery threshold control requires a privileged helper script. To test threshold features:

```bash
sudo ./install-helper.sh
```

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature or user-facing functionality |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `style` | Formatting, whitespace, missing semicolons (no logic change) |
| `docs` | Documentation only |
| `chore` | Build process, packaging, dependencies, tooling |
| `ci` | CI/CD changes |
| `test` | Adding or updating tests |

### Scopes

| Scope | Component |
|-------|-----------|
| `prefs` | Preferences UI (`prefs.js`) |
| `panel` | Quick Settings panel (`quickSettingsPanel.js`) |
| `state` | StateManager |
| `power` | PowerProfileController |
| `battery` | BatteryThresholdController |
| `device` | Device backends |
| `profiles` | ProfileMatcher, profile management |
| `rules` | RuleEvaluator, ParameterDetector |
| `helper` | Helper script and utilities |
| `schema` | GSettings schema |
| `i18n` | Translations and internationalization |

### Examples

```
feat(panel): add battery health percentage to status display
fix(battery): correct threshold write ordering for end-only devices
refactor(state): extract profile validation into separate method
chore: update metadata for GNOME 47 compatibility
docs: document multi-battery support in README
```

### Breaking Changes

Append `!` after the type/scope and include a `BREAKING CHANGE:` footer:

```
feat(schema)!: remove legacy profile settings

BREAKING CHANGE: Removed profile-docked and profile-travel settings.
Profiles are now stored exclusively in custom-profiles JSON format.
```

## Architecture Overview

The extension follows a Controllers → StateManager → UI signal flow:

1. Hardware controllers (`PowerProfileController`, `BatteryThresholdController`) detect changes and emit signals
2. `StateManager` aggregates these into a unified `state-changed` signal
3. The Quick Settings panel subscribes to `StateManager` for UI updates

See [Hardware Compatibility](hardware/compatibility.md) for device backend information.

## Key Code Patterns

- **Async `_destroyed` flag**: Controllers set `this._destroyed = true` at the start of `destroy()`. All async callbacks and promise chains check this flag before accessing object state.
- **Resource cleanup in `destroy()`**: Timeouts, signal connections, file monitors, and D-Bus proxies must all be cleaned up.
- **Threshold write ordering**: When changing battery thresholds, start and end values must be written in the correct order to avoid kernel errors. See `GenericSysfsDevice.setThresholds()`.

## Translations

The extension uses GNU gettext for internationalization.

### Adding a New Language

```bash
mkdir -p po
cp hara-hachi-bu.pot po/<LANG>.po
# e.g., po/de.po for German, po/fr.po for French
```

Edit the `.po` file with a translation editor ([Poedit](https://poedit.net/), [GNOME Translation Editor](https://wiki.gnome.org/Apps/Gtranslator), or any text editor) and submit a pull request.

### Updating the Template

After adding or changing translatable strings:

```bash
make pot
```

Commit the updated `.pot` alongside your code changes.

## Pull Request Guidelines

1. **One logical change per PR** — separate unrelated fixes into different PRs
2. **Follow the commit convention** described above
3. **Test on real hardware or mock mode** — mention which you used in the PR description
4. **Compile schemas** if you changed the GSettings schema (`make schemas`)
5. **Check logs** for warnings or errors after your changes (`make logs`)

Issues and pull requests welcome at [github.com/ZviBaratz/hara-hachi-bu](https://github.com/ZviBaratz/hara-hachi-bu).

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0-or-later](https://github.com/ZviBaratz/hara-hachi-bu/blob/main/LICENSE) license.
