#!/bin/bash
# Installation script for Unified Power Manager helper components
# Run with: sudo ./install-helper.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_USER="${SUDO_USER:-$USER}"

echo "Installing Unified Power Manager helper components..."

# Install the helper script
echo "Installing unified-power-ctl to /usr/local/bin..."
cp "${SCRIPT_DIR}/resources/unified-power-ctl" /usr/local/bin/unified-power-ctl
chmod +x /usr/local/bin/unified-power-ctl

# Check polkit version for rules format
POLKIT_VERSION=$(pkaction --version 2>/dev/null | cut -d' ' -f3 || echo "0.100")

# Compare versions - 0.106 and above use JavaScript rules
if printf '%s\n%s' "0.106" "$POLKIT_VERSION" | sort -V | head -n1 | grep -q "0.106"; then
    echo "Using modern polkit rules format..."
    cp "${SCRIPT_DIR}/resources/10-unified-power-manager.rules" /etc/polkit-1/rules.d/
else
    echo "Using legacy polkit policy format..."
    # For legacy polkit, use the policy file
    cp "${SCRIPT_DIR}/resources/org.gnome.shell.extensions.unified-power-manager.policy" \
        /usr/share/polkit-1/actions/
fi

echo ""
echo "Installation complete!"
echo ""
echo "To enable the extension, run:"
echo "  gnome-extensions enable unified-power-manager@zvi"
echo ""
echo "Then log out and log back in, or restart GNOME Shell (Alt+F2, type 'r', press Enter)"
