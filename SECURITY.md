# Security Policy

## Security Model

Unified Power Manager implements a layered security architecture to safely provide privileged battery threshold control in a GNOME Shell extension.

### Architecture

- **Extension Code**: JavaScript runs unprivileged in the GNOME Shell process. All device queries and display operations occur without elevation.
- **Privileged Operations**: Battery threshold writes to `/sys/class/power_supply/` require privilege escalation via polkit (pkexec).
- **Helper Script**: `unified-power-ctl` runs as root through the polkit authorization system and implements strict validation before writing to sysfs.

### Input Validation (4-Layer Defense)

The helper script implements defense-in-depth validation to prevent injection and path traversal attacks:

1. **Input Sanitization**: All inputs are validated against the regex `[a-zA-Z0-9_-]` (alphanumeric, underscore, hyphen). Any invalid character is rejected immediately.

2. **Filename Whitelist**: Only three sysfs filenames are allowed:
   - `charge_control_start_threshold`
   - `charge_control_end_threshold`
   - `charge_behaviour`

   This prevents writing to other sysfs files or unintended battery attributes.

3. **Path Canonicalization**: The resolved path is computed using `realpath -e`, which:
   - Resolves all symbolic links
   - Verifies the file exists
   - Returns the absolute canonical path
   - Fails if the path does not exist (protecting against TOCTOU attacks)

4. **Prefix Validation**: The canonical path is verified to begin with `/sys/` before writing. This prevents the helper from writing to other parts of the filesystem.

### Polkit Authorization

The polkit rules (`10-unified-power-manager.rules`) enforce:
- User must be in the `sudo` or `wheel` group
- Session must be active (not locked or suspended)
- Authentication occurs in the user's local session only

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.** Instead, report privately using GitHub Security Advisories.

### How to Report

1. Visit: https://github.com/ZviBaratz/unified-power-manager/security/advisories/new
2. Provide the following information:
   - **Vulnerability Description**: Clear explanation of the issue
   - **Reproduction Steps**: Steps to reproduce the vulnerability
   - **Affected Versions**: Which extension versions are impacted
   - **Potential Impact**: What an attacker could accomplish
   - **Suggested Fix** (optional): If you have a mitigation in mind

### Response Timeline

You can expect a response within **7 days** of submission. The maintainers will:
- Acknowledge receipt of your report
- Confirm or dispute the vulnerability
- Discuss a timeline for patching (if applicable)
- Coordinate a public disclosure and release plan

## Scope

### In Scope

The following attack vectors are considered within scope and will be evaluated for fixes:

- **Helper Script Validation Bypass**: Circumventing input sanitization, filename whitelisting, or path canonicalization
- **Sysfs Path Traversal**: Exploiting symlink resolution or canonicalization logic to write outside `/sys/`
- **Pkexec Command Injection**: Injecting shell metacharacters or crafted arguments to pkexec
- **Polkit Policy Weaknesses**: Issues with group membership validation or session state checks
- **Extension-to-Helper Communication**: Vulnerabilities in how the extension invokes the helper

### Out of Scope

The following are **not** considered vulnerabilities in this extension:

- **Attacks Requiring Root Access**: Issues that only manifest if the attacker already has root privileges
- **Physical Access Attacks**: Attacks requiring physical access to the computer or filesystem
- **Denial of Service via UI**: Repeatedly invoking pkexec dialogs (a user friction issue, not a security vulnerability)
- **Power Profiles Daemon Vulnerabilities**: Issues in upstream `power-profiles-daemon` are reported to that project
- **UPower Vulnerabilities**: Issues in the UPower daemon are reported to that project
- **GNOME Shell/Polkit Vulnerabilities**: Issues in core infrastructure are reported to those projects

## Supported Versions

Currently, **version 1.x** receives security updates. All vulnerability reports apply to the latest release. Users should always upgrade to the newest version to receive security fixes.

---

**Questions?** Contact the maintainers via GitHub Security Advisories or open a discussion in the repository's Discussions tab (for non-security topics only).
