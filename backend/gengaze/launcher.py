"""Entry point for the packaged (PyInstaller) desktop app.

Bundled read-only resources (workflows, the built frontend) live next to
the executable; writable user workflows and images live in the per-user data
directory. This points ``Settings`` at those locations via environment
variables — set *before* importing the app so config reads them — picks a free
port, starts uvicorn, and opens the browser once the server is accepting.

Also runnable in dev: ``python -m gengaze.launcher`` (resolves resources
from the repo checkout instead of a bundle).
"""

from __future__ import annotations

import atexit
import os
import shutil
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path


def _bundle_dir() -> Path:
    """Root of bundled read-only resources.

    Frozen: PyInstaller's extraction/bundle dir (``sys._MEIPASS``). Dev:
    the repo root (backend/gengaze/launcher.py → three parents up).
    """
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent.parent.parent


def _ensure_images_dir() -> Path:
    """Writable per-user images dir, seeded from bundled defaults once."""
    from gengaze.user_config import config_dir  # no Settings import → safe

    dst = config_dir() / "images"
    dst.mkdir(parents=True, exist_ok=True)
    seed = _bundle_dir() / "images"
    if seed.is_dir():
        for f in seed.iterdir():
            if f.is_file() and not (dst / f.name).exists():
                shutil.copy2(f, dst / f.name)
    return dst


def _ensure_workflows_dir() -> Path:
    """Writable workflow root for user-added templates in packaged builds."""
    from gengaze.user_config import config_dir  # no Settings import -> safe

    dst = config_dir() / "workflows"
    for category in ("img", "edit", "inpainting"):
        (dst / category).mkdir(parents=True, exist_ok=True)
    return dst


def _pick_port(preferred: int = 8000) -> int:
    """Return `preferred` if free, otherwise an OS-assigned free port."""
    for candidate in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", candidate))
                return s.getsockname()[1]
            except OSError:
                continue
    return preferred


def _open_when_ready(url: str, port: int, timeout: float = 15.0) -> None:
    """Poll the port until the server accepts, then open the browser."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                webbrowser.open(url)
                return
        time.sleep(0.25)


def main() -> None:
    from gengaze.instance import (
        probe_alive,
        read_lock,
        remove_lock,
        write_lock,
    )

    bundle = _bundle_dir()
    # Point Settings at bundled/writable resources BEFORE importing the app.
    os.environ.setdefault("WORKFLOWS_DIR", str(bundle / "workflows"))
    os.environ.setdefault("USER_WORKFLOWS_DIR", str(_ensure_workflows_dir()))
    os.environ["IMAGES_DIR"] = str(_ensure_images_dir())

    # Single-instance guard: if an instance is already serving, focus it in
    # the browser and exit — don't spawn a second rival server on a new port.
    existing = read_lock()
    if existing and probe_alive(int(existing.get("port") or 0)):
        url = f"http://127.0.0.1:{existing['port']}"
        if not os.environ.get("GENGAZE_NO_BROWSER"):
            webbrowser.open(url)
        print(f"gazeCOM already running at {url}")
        return
    remove_lock()  # clear any stale lock before starting fresh

    host = os.environ.get("HOST", "127.0.0.1")
    port = _pick_port(int(os.environ.get("PORT", "8000")))
    os.environ["HOST"] = host
    os.environ["PORT"] = str(port)

    # Record the live instance; clear it on a clean exit. Ctrl-C / closing the
    # terminal → uvicorn shuts down gracefully, uvicorn.run() returns here, and
    # atexit fires. A hard kill leaves a stale lock, which the next launch's
    # probe_alive() detects as dead and clears.
    write_lock(port)
    atexit.register(remove_lock)

    import uvicorn

    from gengaze.main import app

    url = f"http://127.0.0.1:{port}"
    # GENGAZE_NO_BROWSER=1 skips auto-opening the browser (headless/testing).
    if not os.environ.get("GENGAZE_NO_BROWSER"):
        threading.Thread(
            target=_open_when_ready, args=(url, port), daemon=True
        ).start()
    print(f"gazeCOM running at {url}")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
