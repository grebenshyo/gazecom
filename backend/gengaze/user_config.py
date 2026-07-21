"""Per-user runtime configuration, stored outside the app bundle.

Distinct from `config.py` (`Settings`, loaded from environment/.env at
process start): this holds values the user changes at runtime through the
app — currently the ComfyUI/Ollama hosts and Ollama keep-loaded behavior.
It lives in the OS-standard per-user data directory so it survives app updates
and doesn't require writing
inside the (possibly code-signed / read-only) app bundle:

  macOS:   ~/Library/Application Support/gazeCOM/config.json
  Windows: %APPDATA%\\gazeCOM\\config.json
  Linux:   $XDG_CONFIG_HOME/gazeCOM/config.json  (or ~/.config/gazeCOM)

Existing ``GenGaze`` data is copied to the renamed directory on first use.

Runtime config resolution: this file (if set) overrides the `Settings`
value (env/.env), which itself falls back to the built-in default. So the
dev/.env workflow is unchanged, and the packaged app is configured in-UI
without anyone editing a file by hand.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from gengaze.config import Settings

log = logging.getLogger(__name__)

_APP_NAME = "gazeCOM"
_LEGACY_APP_NAME = "GenGaze"


def _config_base() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def config_dir() -> Path:
    """Return the gazeCOM data directory, migrating the legacy name once."""
    base = _config_base()
    current = base / _APP_NAME
    legacy = base / _LEGACY_APP_NAME
    if current.exists() or not legacy.is_dir():
        return current

    try:
        shutil.copytree(legacy, current)
    except FileExistsError:
        pass
    except OSError as e:
        # A read-only parent should not make an existing installation lose
        # its settings or images. Keep using the legacy directory instead.
        log.warning("Could not migrate user data from %s to %s: %s", legacy, current, e)
        return legacy
    return current


def config_path() -> Path:
    return config_dir() / "config.json"


def load_config() -> dict[str, Any]:
    """Read the user config, returning {} on missing/unreadable/invalid."""
    path = config_path()
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        log.warning("Ignoring unreadable user config %s: %s", path, e)
        return {}


def save_config(update: dict[str, Any]) -> dict[str, Any]:
    """Merge ``update`` into the stored config and persist it atomically.

    Returns the merged config.
    """
    merged = {**load_config(), **update}
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2)
    tmp.replace(path)  # atomic on the same filesystem
    return merged


def clear_config() -> None:
    """Remove runtime overrides without touching other per-user data."""
    try:
        config_path().unlink()
    except FileNotFoundError:
        pass


def resolve_comfy_host(settings: Settings) -> str:
    """Effective ComfyUI host: the user-config override if set, else the
    ``Settings`` value (env/.env/default). Read per call so a change in the
    UI takes effect on the next generation without a restart."""
    host = load_config().get("comfy_host")
    if isinstance(host, str) and host.strip():
        return host.strip()
    return settings.comfy_host


def resolve_ollama_host(settings: Settings) -> str:
    """Effective Ollama host, using the same override chain as ComfyUI."""
    host = load_config().get("ollama_host")
    if isinstance(host, str) and host.strip():
        return host.strip()
    return settings.ollama_host


def resolve_ollama_keep_model_loaded(settings: Settings) -> bool:
    """Whether Ollama should keep the LLM resident after enhancement."""
    value = load_config().get("ollama_keep_model_loaded")
    if isinstance(value, bool):
        return value
    return settings.ollama_keep_model_loaded
