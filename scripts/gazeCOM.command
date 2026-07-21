#!/usr/bin/env bash
#
# gazeCOM launcher for macOS. Double-click in Finder → Finder opens it in
# Terminal and runs the gazeCOM binary sitting next to this file. The window
# shows the URL and logs; close it or press Ctrl-C to stop the server.
#
# This file is placed next to the onedir `gazeCOM` binary at packaging time
# (see scripts/build-app.sh and .github/workflows/release.yml).
#
cd "$(dirname "$0")" || exit 1

# First run on an unsigned download is quarantined by Gatekeeper; clear it on
# this folder so the binary launches without a right-click-Open dance. No-op
# if already cleared.
xattr -dr com.apple.quarantine . 2>/dev/null || true

exec ./gazeCOM
