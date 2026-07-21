# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the gazeCOM desktop app.

Freezes the FastAPI/uvicorn backend and bundles the read-only resources
it serves: the built frontend (frontend/dist), the workflow templates,
and the seed images. The launcher points Settings at these plus writable
per-user workflow and image directories, then starts uvicorn and opens the
browser.

Build:  pyinstaller gazecom.spec        (run from the repo root)
Output: dist/gazeCOM/  (onedir console app)
"""

from PyInstaller.utils.hooks import collect_submodules

# uvicorn dynamically imports its protocol/loop/lifespan implementations,
# which static analysis misses — pull them all in explicitly.
hiddenimports = collect_submodules("uvicorn")

a = Analysis(
    ["backend/gengaze/launcher.py"],
    pathex=["backend"],
    binaries=[],
    datas=[
        ("workflows", "workflows"),
        # Package only public seed images. The source images directory also
        # holds ignored user uploads/composites during development; bundling
        # the whole directory could leak those into a local release build.
        ("images/blank.png", "images"),
        ("images/girl_with_a_pearl_earring.jpg", "images"),
        ("images/renaissance_gentleman.jpg", "images"),
        ("frontend/dist", "frontend/dist"),
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Dev/build-only tools that may be present in the build venv but are
    # never used at runtime — keep them out of the shipped app.
    excludes=["mypy", "mypyc", "pytest", "_pytest", "ruff", "PyInstaller"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="gazeCOM",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Console app: the app runs in a terminal window that shows the URL and
    # logs, and closing it / Ctrl-C stops the server. This is the native idiom
    # for the local-AI ecosystem (ComfyUI, Ollama, …) and gives an obvious
    # quit + visible errors. On Windows the .exe opens its own console; on
    # macOS the onedir is launched via gazeCOM.command (Finder opens it in
    # Terminal).
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="gazeCOM",
)

# No macOS .app BUNDLE: a double-clicked .app can't attach a terminal, and a
# silent windowed app gave no way to quit or see errors. Both platforms ship
# the onedir `dist/gazeCOM/` instead — launched by gazeCOM.exe (Windows,
# console) or gazeCOM.command (macOS, opens Terminal). Packaging adds the
# .command; see scripts/build-app.sh and .github/workflows/release.yml.
