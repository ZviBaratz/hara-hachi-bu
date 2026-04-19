#!/usr/bin/env bash
# Package script for Hara Hachi Bu extension
# Creates a zip file suitable for extensions.gnome.org submission

set -eu

EXTENSION_UUID="hara-hachi-bu@ZviBaratz"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/${EXTENSION_UUID}.zip"

# Remove existing package
rm -f "$OUTPUT_FILE"

# Create zip excluding development files and helper scripts
# Note: resources/ contains helper files that require manual installation
cd "$SCRIPT_DIR"
zip -r "$OUTPUT_FILE" \
    extension.js \
    prefs.js \
    metadata.json \
    stylesheet.css \
    LICENSE \
    schemas/org.gnome.shell.extensions.hara-hachi-bu.gschema.xml \
    icons/ \
    lib/ \
    resources/ \
    -x "*.pyc" \
    -x "*__pycache__*" \
    -x "*.swp" \
    -x "*~" \
    -x "lib/device/MockDevice.js"

echo "Package created: $OUTPUT_FILE"
echo ""
echo "The resources/ directory is shipped inside the zip. Battery threshold control"
echo "requires installing these three files to system paths (done by the one-liner"
echo "the extension copies to your clipboard from the Quick Settings panel, or see"
echo "README.md):"
echo "  - resources/hhb-power-ctl -> /usr/local/bin/hhb-power-ctl"
echo "  - resources/10-hara-hachi-bu.rules -> /etc/polkit-1/rules.d/"
echo "  - resources/org.gnome.shell.extensions.hara-hachi-bu.policy -> /usr/share/polkit-1/actions/"
