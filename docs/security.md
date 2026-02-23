# Security

## Security Model

Hara Hachi Bu implements a layered security architecture to safely provide privileged battery threshold control from a GNOME Shell extension.

### Architecture

- **Extension code**: JavaScript runs unprivileged in the GNOME Shell process. All device queries and display operations occur without elevation.
- **Privileged operations**: Battery threshold writes to `/sys/class/power_supply/` require privilege escalation via polkit (pkexec).
- **Helper script**: `hhb-power-ctl` runs as root through the polkit authorization system and implements strict validation before writing to sysfs.

### Input Validation (4-Layer Defense)

The helper script implements defense-in-depth validation to prevent injection and path traversal attacks:

**1. Input Sanitization**

All inputs are validated against the regex `[a-zA-Z0-9_-]` (alphanumeric, underscore, hyphen). Any invalid character is rejected immediately.

**2. Filename Whitelist**

Only three sysfs filenames are allowed:

- `charge_control_start_threshold`
- `charge_control_end_threshold`
- `charge_behaviour`

This prevents writing to other sysfs files or unintended battery attributes.

**3. Path Canonicalization**

The resolved path is computed using `realpath -e`, which:

- Resolves all symbolic links
- Verifies the file exists
- Returns the absolute canonical path
- Fails if the path does not exist (protecting against TOCTOU attacks)

**4. Prefix Validation**

The canonical path is verified to begin with `/sys/` before writing. This prevents the helper from writing to other parts of the filesystem.

### Polkit Authorization

The polkit rules (`10-hara-hachi-bu.rules`) enforce:

- User must be in the `sudo` or `wheel` group
- Session must be active (not locked or suspended)
- Authentication occurs in the user's local session only

This is intentional for UX — constantly prompting for a password when changing power modes would be disruptive. The trade-off is that any process running as your user in an active local session can change battery thresholds.

Remote and inactive sessions require admin authentication (or are blocked entirely on legacy polkit).

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Instead, report privately using GitHub Security Advisories.

### How to Report

1. Visit: [github.com/ZviBaratz/hara-hachi-bu/security/advisories/new](https://github.com/ZviBaratz/hara-hachi-bu/security/advisories/new)
2. Provide:
   - **Description**: Clear explanation of the issue
   - **Reproduction steps**: Steps to reproduce the vulnerability
   - **Affected versions**: Which extension versions are impacted
   - **Potential impact**: What an attacker could accomplish
   - **Suggested fix** (optional): If you have a mitigation in mind

### Response Timeline

You can expect a response within **7 days** of submission. The maintainers will acknowledge receipt, confirm or dispute the vulnerability, discuss a patching timeline, and coordinate public disclosure.

## Scope

### In Scope

- **Helper Script Validation Bypass**: Circumventing input sanitization, filename whitelisting, or path canonicalization
- **Sysfs Path Traversal**: Exploiting symlink resolution or canonicalization logic to write outside `/sys/`
- **Pkexec Command Injection**: Injecting shell metacharacters or crafted arguments to pkexec
- **Polkit Policy Weaknesses**: Issues with group membership validation or session state checks
- **Extension-to-Helper Communication**: Vulnerabilities in how the extension invokes the helper

### Out of Scope

- **Attacks Requiring Root Access**: Issues that only manifest if the attacker already has root privileges
- **Physical Access Attacks**: Attacks requiring physical access to the computer or filesystem
- **Denial of Service via UI**: Repeatedly invoking pkexec dialogs (a user friction issue, not a security vulnerability)
- **Upstream Vulnerabilities**: Issues in `power-profiles-daemon`, UPower, GNOME Shell, or polkit — report these to those projects

## Supported Versions

Currently, **version 1.x** receives security updates. Users should always upgrade to the newest version to receive security fixes.
