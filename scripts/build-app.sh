#!/usr/bin/env bash
#
# Build the frozen gazeCOM desktop app: the same three steps the release CI
# runs, wrapped in one command.
#
#   1. compile the frontend into a static bundle (frontend/dist)
#   2. install the backend + PyInstaller into backend/.venv
#   3. freeze everything into a standalone app
#
# Output: dist/gazeCOM/ (onedir). On macOS a gazeCOM.command Terminal launcher
# is placed inside it; on Linux run the gazeCOM binary directly.
#
# Prerequisites: Python 3.11+, Node 20+, and pnpm on PATH.
#
set -euo pipefail

# Repo root = the parent of this script's directory, so the script works no
# matter where it's invoked from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VENV="$ROOT/backend/.venv"
PY="$VENV/bin/python"

echo "==> [1/3] Building frontend bundle"
( cd frontend && pnpm install && pnpm build )

echo "==> [2/3] Preparing Python build environment"
if [ ! -x "$PY" ]; then
  echo "    creating venv at backend/.venv"
  python3 -m venv "$VENV"
fi
"$PY" -m pip install --upgrade pip >/dev/null
( cd backend && "$PY" -m pip install ".[build]" )

echo "==> [3/3] Freezing the app with PyInstaller"
"$PY" -m PyInstaller gazecom.spec --noconfirm
cp "$ROOT/LICENSE" "$ROOT/dist/gazeCOM/LICENSE"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$ROOT/dist/gazeCOM/THIRD_PARTY_NOTICES.md"

echo
if [ "$(uname)" = "Darwin" ] && [ -f "$ROOT/scripts/gazeCOM.command" ]; then
  cp "$ROOT/scripts/gazeCOM.command" "$ROOT/dist/gazeCOM/gazeCOM.command"
  chmod +x "$ROOT/dist/gazeCOM/gazeCOM.command"
  echo "Done → $ROOT/dist/gazeCOM/  (double-click gazeCOM.command to launch)"
else
  echo "Done → $ROOT/dist/gazeCOM/  (run the gazeCOM binary inside it)"
fi
