#!/usr/bin/env bash
# Package script for Unified Power Manager extension
# Creates a zip file suitable for extensions.gnome.org submission

set -eu

EXTENSION_UUID="unified-power-manager@zvi"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/${EXTENSION_UUID}.zip"

# Remove existing package
rm -f "$OUTPUT_FILE"

# Create zip excluding development files and helper scripts
# Note: resources/ contains helper scripts that require manual installation
cd "$SCRIPT_DIR"
zip -r "$OUTPUT_FILE" \
    extension.js \
    prefs.js \
    metadata.json \
    stylesheet.css \
    LICENSE \
    README.md \
    schemas/org.gnome.shell.extensions.unified-power-manager.gschema.xml \
    icons/ \
    lib/ \
    -x "*.pyc" \
    -x "*__pycache__*" \
    -x "*.swp" \
    -x "*~"

echo "Package created: $OUTPUT_FILE"
echo ""
echo "Note: The following files are NOT included in the package and require manual installation:"
echo "  - resources/unified-power-ctl (helper script)"
echo "  - resources/10-unified-power-manager.rules (polkit rules)"
echo "  - resources/org.gnome.shell.extensions.unified-power-manager.policy (polkit policy)"
echo ""
echo "See README.md for installation instructions."
