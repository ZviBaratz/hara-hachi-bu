#!/usr/bin/env bash
# Package script for Hara Hachi Bu extension
# Creates a zip file suitable for extensions.gnome.org submission

set -eu

EXTENSION_UUID="hara-hachi-bu@ZviBaratz"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/${EXTENSION_UUID}.zip"

# Remove existing package
rm -f "$OUTPUT_FILE"

# Compile schemas so manual installs work without glib-compile-schemas
echo "Compiling schemas..."
glib-compile-schemas schemas/

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
    install-helper.sh \
    schemas/org.gnome.shell.extensions.hara-hachi-bu.gschema.xml \
    schemas/gschemas.compiled \
    icons/ \
    lib/ \
    resources/ \
    -x "*.pyc" \
    -x "*__pycache__*" \
    -x "*.swp" \
    -x "*~"

echo "Package created: $OUTPUT_FILE"
echo ""
echo "Note: The resources/ directory IS included in the package, but the following files"
echo "require manual installation to system paths for battery threshold control to work:"
echo "  - resources/hhb-power-ctl -> /usr/local/bin/hhb-power-ctl"
echo "  - resources/10-hara-hachi-bu.rules -> /etc/polkit-1/rules.d/"
echo "  - resources/org.gnome.shell.extensions.hara-hachi-bu.policy -> /usr/share/polkit-1/actions/"
echo ""
echo "Run 'sudo ./install-helper.sh' or see README.md for installation instructions."
