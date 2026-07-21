# Development

Everything you need to build gazeCOM from source, understand its layout, and
run it while hacking on it. For installing and using the app, see the
[README](../README.md).

## Repo layout

```
<repo>/
├── backend/        FastAPI + websocket ComfyUI client (Python 3.11+)
├── frontend/       Vite + React + TypeScript SPA
├── workflows/      ComfyUI workflow JSON templates
├── images/         reference images served at /images/*
├── scripts/        build-app.{sh,ps1} — one-command app freeze
├── gazecom.spec    PyInstaller spec (desktop app freeze)
├── .env.example    config template (dev)
└── .github/        CI (ci.yml) + release build (release.yml)
```

## The two run modes (dev vs packaged)

This trips people up, so it's worth stating plainly. There are two ways the
app runs, and they are different *kinds* of thing:

**Development — two servers.** Vite serves the frontend on
`http://localhost:5173` with hot-reload, and uvicorn serves the API on
`:8000`. Vite **proxies** `/api/*` and `/images/*` to the backend, so the
frontend fetches same-origin relative URLs while you still hit the real API.
You open the Vite link. Vite is a *dev instrument* — it compiles your
TypeScript/JSX on the fly per request and hot-swaps modules as you edit; none
of it ships.

**Packaged — one server.** `pnpm build` compiles the frontend into static
files (`frontend/dist`) once. The PyInstaller app freezes only the **backend**;
at launch, uvicorn serves the built SPA at `/`, the API at `/api/*`, and images
at `/images/*` — all from one process on one port (see
[`main.py`](../backend/gengaze/main.py): the `if frontend_dist.is_dir()` mount).
No Vite, no proxy, no Node.

The frontend code is identical across both — it always calls relative `/api/…`.
Only *who answers `/api`* differs: Vite's proxy in dev, uvicorn directly in the
frozen app. That's why the same source runs both ways.

## Building the app from source

One command wraps the three steps (frontend build → backend+PyInstaller install
→ freeze):

```powershell
scripts\build-app.ps1     # Windows  → dist\gazeCOM\ (gazeCOM.exe, console)
```
```bash
scripts/build-app.sh      # macOS    → dist/gazeCOM/ (+ gazeCOM.command launcher)
```

Both platforms ship the onedir `dist/gazeCOM/`. The spec builds a **console**
app (see `console=True` in `gazecom.spec`): on Windows the `.exe` opens its own
console; on macOS `gazeCOM.command` opens it in Terminal. There is deliberately
no macOS `.app` — a double-clicked bundle can't attach a terminal, and a silent
windowed app left no way to quit or see errors. Quit by closing the window /
Ctrl-C.

Prerequisites: Python 3.11+, Node 20+, pnpm. The script creates `backend/.venv`
on first run and installs the `build` extra (PyInstaller). PyInstaller
**cannot cross-compile** — a Windows build must run on Windows, a macOS build
on macOS. The release CI does exactly this on both runners (see below).

## Backend (`backend/gengaze/`)

The import package keeps its historical `gengaze` name for compatibility;
the product, distribution package, and command-line entry point use gazeCOM.

- `main.py` — FastAPI app factory; mounts routers, `/images`, and (in
  production) `frontend/dist`.
- `launcher.py` — packaged-app entry point: seeds a writable images dir,
  picks a free port, starts uvicorn, opens the browser.
- `config.py` — typed `Settings` from `.env` (no hardcoded paths).
- `comfy_client.py` — websocket client for ComfyUI; subscribes to `executed`
  events to fetch outputs (no filesystem polling).
- `workflow.py` — pure placeholder substitution (unit-tested).
- `routes/` — `config`, `workflows`, `images`, `generate`, and `llm`
  (`/api/llm/enhance`, `/describe`, `/point`, `/models`).

## Frontend (`frontend/src/`)

- `store/` — Zustand store, single source of truth; persists to localStorage
  via subscription middleware.
- `canvas/` — `Composite.ts` (pure expanding-canvas math), `Heatmap.ts`
  (gradient styles + COM), `HeatmapInstance.ts` (h337 wrapper),
  `CompositeBounds.ts` (bounds/COM clamping), `PullTool.tsx` (1024² crop).
- `trackers/` — seven sources behind one `Tracker` interface: WebGazer,
  Handpose, Roam, Adaptive Roam, MSI saliency, Cursor, and **VLM** (the vision model
  reports a point; `VLMTracker` renders `store.vlmPoint` through the normal
  heatmap sink). Factory in `trackers/index.ts`.
- `generation/` — `pipeline.ts` (single `generateOnce` entry point),
  `workflows.ts` (weighted-random selection), `captureHeatmap.ts`, `llm.ts`
  (Ollama-backed provider), `api.ts` (typed fetch wrappers).
- `prompts/` — built-in prompt lists + placeholder substitution.
- `ui/` — React components (`ControlPanel`, `HeatmapView`, `CompositeView`,
  `MainActions`, `WelcomeModal`) and hooks (`useTracker`, `useHeatmap`,
  `useGenerate`, `useIterativeLoop`).

Architecture invariants (one tracker interface, one store, one generation
entry point, pure/tested functions for the canvas + COM math) are documented
in [CLAUDE.md](../CLAUDE.md).

## Configure (dev)

```bash
cp .env.example .env
# COMFY_HOST   — ComfyUI host:port (default 127.0.0.1:8188)
# OLLAMA_HOST  — Ollama host:port  (default 127.0.0.1:11434)
# OLLAMA_KEEP_MODEL_LOADED=true if Ollama runs off the Flux GPU
```

The Settings drawer changes the same hosts at runtime. Keep
`OLLAMA_KEEP_MODEL_LOADED` off when Ollama shares VRAM with Comfy/Flux; turn it
on for a separate machine to avoid expensive reloads.

## Run (development)

```bash
# Terminal 1 — backend
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn gengaze.main:app --reload --port 8000
```
```bash
# Terminal 2 — frontend
cd frontend
pnpm install
pnpm dev
```

Open <http://localhost:5173>. Vite proxies `/api/*` and `/images/*` to `:8000`.

## Run (production, from source)

```bash
cd frontend && pnpm build            # writes dist/
cd ../backend && uvicorn gengaze.main:app --host 127.0.0.1 --port 8000
```

The backend then serves the SPA at `/` and the API at `/api/*` from one
process — the same shape as the frozen app, minus the launcher.

## Testing

```bash
cd backend && pytest && ruff check .   # 68 tests
```
```bash
cd frontend && pnpm typecheck && pnpm test   # 176 vitest tests
pnpm test:e2e                                # Playwright smoke (npx playwright install once)
```

`ci.yml` runs ruff + pytest + tsc + vitest on every push to `main`.

## Releases

`release.yml` builds Apple Silicon macOS, Intel macOS, and Windows archives,
gated on `v*` tags, and attaches the zipped artifacts to a GitHub Release.
`workflow_dispatch` builds the artifacts without publishing (for smoke-testing
the freeze). Tag a version to cut a release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## Workflows

Workflow categories are a strict, deliberately small contract:

```text
workflows/
├── img/          base image + heatmap, or a COM crop
├── edit/         plain image-conditioned patch, or a COM crop
└── inpainting/   alpha-mask input for in-/outpainting
```

Templates must be ComfyUI **API-format** JSON and live directly inside one of
those three lowercase folders. The backend scans them on page load, groups them
alphabetically, and reports structural errors to the workflow picker.

`{input_image}` is required and must feed the workflow's image loader. Optional
placeholders are `{prompt}`, `{seed}` and `{output_prefix}`. A workflow
controlled by the Steps field declares its own default in the same token, for
example `{steps:6}`. The graph must terminate in `SaveImage` or `PreviewImage`;
gazeCOM returns the first image from that output.

Inpainting workflows receive one PNG rather than separate image and mask
uploads, so their graph must consume the mask output of `LoadImage`. Model
names, LoRAs, samplers, schedulers, CFG, denoise and other model-specific values
remain owned by the workflow itself.

Source development scans the repository's `workflows/` directory. Packaged
builds additionally scan the writable per-user directory created at launch:

- macOS: `~/Library/Application Support/gazeCOM/workflows/`
- Windows: `%APPDATA%\gazeCOM\workflows\`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/gazeCOM/workflows/`

Both roots share the same visible category/name key. A user workflow with the
same key overrides the bundled workflow. Prompt enhancement and vision call
Ollama directly through `/api/llm/*`; they do not use ComfyUI workflows.

## Lineage

gazeCOM is the first public *software* release, a complete rewrite and
expansion of a 2025 prototype. The earlier stage is kept separately as a local
archive, not as a published branch of this repository.
