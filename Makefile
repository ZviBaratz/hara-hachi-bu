# Makefile for Hara Hachi Bu extension

EXTENSION_UUID = hara-hachi-bu@ZviBaratz
# Detect if we are running in the installation directory
CURRENT_DIR = $(shell pwd)
INSTALL_BASE = $(HOME)/.local/share/gnome-shell/extensions
INSTALL_DIR = $(INSTALL_BASE)/$(EXTENSION_UUID)

# Flags for nested session
NESTED_SIZE = 1600x900

.PHONY: all dev nested schemas install pack clean logs pot help

all: dev

help:
	@echo "Available targets:"
	@echo "  make dev      - Compile schemas and start nested GNOME Shell"
	@echo "  make nested   - Start nested GNOME Shell only"
	@echo "  make schemas  - Compile GSettings schemas"
	@echo "  make install  - Install extension to local directory (if not already there)"
	@echo "  make pack     - Create release zip"
	@echo "  make pot      - Regenerate translation template"
	@echo "  make logs     - Show extension logs"
	@echo "  make clean    - Remove temporary files"

# Combined workflow: Compile schemas then run nested shell
dev: schemas nested

nested:
	@echo "Starting nested GNOME Shell..."
	@echo "Press Ctrl+C in this terminal to kill the session if closing the window doesn't work."
	@dbus-run-session gnome-shell --nested --wayland

schemas:
	@echo "Compiling schemas..."
	@if [ -d "schemas" ]; then glib-compile-schemas schemas/; fi

install: schemas
	@if [ "$(CURRENT_DIR)" = "$(INSTALL_DIR)" ]; then \
		echo "Already in install directory, skipping copy."; \
	else \
		echo "Installing to $(INSTALL_DIR)..."; \
		mkdir -p $(INSTALL_DIR); \
		cp -r extension.js prefs.js metadata.json stylesheet.css lib schemas icons resources LICENSE README.md $(INSTALL_DIR)/; \
		echo "Done."; \
	fi

pack:
	@./package.sh

logs:
	@echo "Following logs for gnome-shell... (Ctrl+C to stop)"
	@journalctl -f -o cat /usr/bin/gnome-shell

pot:
	@echo "Regenerating translation template..."
	@xgettext --from-code=UTF-8 \
		--keyword=_ --keyword=N_ --keyword=C_:1c,2 \
		--add-comments=Translators \
		--package-name="hara-hachi-bu" \
		--package-version="1.0.0" \
		--msgid-bugs-address="https://github.com/ZviBaratz/hara-hachi-bu/issues" \
		--copyright-holder="Zvi Baratz" \
		--output=hara-hachi-bu.pot \
		extension.js prefs.js lib/*.js lib/device/*.js

clean:
	@rm -f $(EXTENSION_UUID).zip
