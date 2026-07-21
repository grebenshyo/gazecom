"""Single-instance coordination for the packaged desktop app.

The app is a headless server that opens the system browser, so launching it
twice used to start two rival servers on two ports (see launcher.py). A tiny
lock file records the running instance's port + pid; a fresh launch checks it
and, if a live instance answers, just focuses that one instead of spawning
another.

The probe hits ``/api/health`` rather than merely testing the port, so we
never mistake some *other* process on 8000 for a gazeCOM instance, and a
stale lock (hard-killed process, reused port) is treated as dead.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def _lock_path() -> Path:
    from gengaze.user_config import config_dir

    return config_dir() / "instance.json"


def read_lock() -> dict | None:
    """Return the recorded ``{"port", "pid"}`` lock, or None if absent/unreadable."""
    try:
        data = json.loads(_lock_path().read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_lock(port: int) -> None:
    try:
        path = _lock_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"port": port, "pid": os.getpid()}))
    except OSError:
        pass


def remove_lock() -> None:
    try:
        _lock_path().unlink()
    except OSError:
        pass


def probe_alive(port: int, timeout: float = 1.0) -> bool:
    """True if a gazeCOM instance answers /api/health on ``port``."""
    if not port:
        return False
    try:
        with urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=timeout
        ) as resp:
            body = json.loads(resp.read().decode())
    except (URLError, OSError, ValueError):
        return False
    return isinstance(body, dict) and body.get("status") == "ok"
