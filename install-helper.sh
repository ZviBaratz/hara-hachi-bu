#!/bin/bash
# Installation script for Unified Power Manager helper components
# Run with: sudo ./install-helper.sh [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_USER="${SUDO_USER:-$USER}"

function show_help() {
    echo "Unified Power Manager Helper Installer"
    echo ""
    echo "Usage: sudo ./install-helper.sh [options]"
    echo ""
    echo "Options:"
    echo "  --uninstall   Remove the helper script and polkit rules"
    echo "  --help        Show this help message"
    echo ""
}

function uninstall() {
    echo "Uninstalling Unified Power Manager helper components..."
    
    if [ -f "/usr/local/bin/unified-power-ctl" ]; then
        echo "Removing /usr/local/bin/unified-power-ctl..."
        rm -f "/usr/local/bin/unified-power-ctl"
    else
        echo "/usr/local/bin/unified-power-ctl not found, skipping."
    fi
    
    if [ -f "/etc/polkit-1/rules.d/10-unified-power-manager.rules" ]; then
        echo "Removing /etc/polkit-1/rules.d/10-unified-power-manager.rules..."
        rm -f "/etc/polkit-1/rules.d/10-unified-power-manager.rules"
    fi

    if [ -f "/usr/share/polkit-1/actions/org.gnome.shell.extensions.unified-power-manager.policy" ]; then
        echo "Removing /usr/share/polkit-1/actions/org.gnome.shell.extensions.unified-power-manager.policy..."
        rm -f "/usr/share/polkit-1/actions/org.gnome.shell.extensions.unified-power-manager.policy"
    fi
    
    echo ""
    echo "Uninstallation complete."
    exit 0
}

# Parse arguments
if [[ "$1" == "--uninstall" ]]; then
    uninstall
elif [[ "$1" == "--help" || "$1" == "-h" ]]; then
    show_help
    exit 0
fi

echo "Installing Unified Power Manager helper components..."

# Install the helper script
echo "Installing unified-power-ctl to /usr/local/bin..."
cp "${SCRIPT_DIR}/resources/unified-power-ctl" /usr/local/bin/unified-power-ctl
chmod +x /usr/local/bin/unified-power-ctl

# Check polkit version for rules format
POLKIT_VERSION=$(pkaction --version 2>/dev/null | cut -d' ' -f3 || echo "0.100")

# Compare versions - 0.106 and above use JavaScript rules
RULES_INSTALLED=false
if printf '%s\n%s' "0.106" "$POLKIT_VERSION" | sort -V | head -n1 | grep -q "0.106"; then
    echo "Using modern polkit rules format..."
    if [ -d "/etc/polkit-1/rules.d" ]; then
        cp "${SCRIPT_DIR}/resources/10-unified-power-manager.rules" /etc/polkit-1/rules.d/
        if [ -f "/etc/polkit-1/rules.d/10-unified-power-manager.rules" ]; then
            RULES_INSTALLED=true
            echo "Polkit rules installed successfully."
        else
            echo "WARNING: Failed to install polkit rules to /etc/polkit-1/rules.d/"
        fi
    else
        echo "WARNING: /etc/polkit-1/rules.d directory not found."
        echo "         You may need to create it or polkit may not support JavaScript rules."
    fi
else
    echo "WARNING: Polkit version $POLKIT_VERSION is older than 0.106."
    echo "         JavaScript rules are not supported. You may need to enter your password"
    echo "         each time battery thresholds are changed."
fi

# Always install the policy file (defines the Action ID and path mapping)
echo "Installing policy action..."
if [ -d "/usr/share/polkit-1/actions" ]; then
    cp "${SCRIPT_DIR}/resources/org.gnome.shell.extensions.unified-power-manager.policy" \
        /usr/share/polkit-1/actions/
    if [ -f "/usr/share/polkit-1/actions/org.gnome.shell.extensions.unified-power-manager.policy" ]; then
        echo "Policy action installed successfully."
    else
        echo "WARNING: Failed to install policy action file."
    fi
else
    echo "WARNING: /usr/share/polkit-1/actions directory not found."
fi

echo ""
echo "Installation complete!"
echo ""
echo "To enable the extension, run:"
echo "  gnome-extensions enable unified-power-manager@baratzz"

echo "" 

echo "Then log out and log back in, or restart GNOME Shell (Alt+F2, type 'r', press Enter)"
