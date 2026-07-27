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
[`main.py`](../backend/gazecom/main.py): the `if frontend_dist.is_dir()` mount).
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

## Backend (`backend/gazecom/`)

The import package, distribution package, and command-line entry point all use
the gazeCOM namespace.

- `main.py` — FastAPI app factory; mounts routers, `/images`, and (in
  production) `frontend/dist`.
- `launcher.py` — packaged-app entry point: seeds a writable images dir,
  picks a free port, starts uvicorn, opens the browser.
- `config.py` — typed `Settings` from `.env` (no hardcoded paths).
- `comfy_client.py` — websocket client for ComfyUI; subscribes to `executed`
  events to fetch outputs (no filesystem polling).
- `workflow.py` — pure placeholder substitution (unit-tested).
- `routes/` — `config`, `workflows`, `images`, `generate`, and `llm`
  (`/api/llm/enhance`, `/describe`, `/point`, `/decision`, `/models`). The
  models endpoint reports Ollama's installed tags, advertised capabilities,
  and family-derived thinking modes.
  `/decision` accepts the current canvas plus strategy-specific history. Guide
  Rotate requires structured `{x, y}` output, Select requires
  `{x, y, prompt_id}` constrained to the submitted candidate IDs, Compose
  requires `{x, y, instruction}`, and Hybrid requires
  `{x, y, source, prompt_id, instruction}` with a strictly valid pool or write
  branch. None substitutes a fallback decision.

## Frontend (`frontend/src/`)

- `store/` — Zustand store, single source of truth; persists to localStorage
  via subscription middleware and owns fresh-install section resets.
- `canvas/` — `Composite.ts` (pure expanding-canvas math), `Heatmap.ts`
  (gradient styles + COM), `HeatmapInstance.ts` (h337 wrapper),
  `CompositeBounds.ts` (bounds/COM clamping), `PullTool.tsx` (1024² crop).
- `trackers/` — seven sources behind one `Tracker` interface: WebGazer,
  Handpose, Roam, Adaptive Roam, MSI saliency, Cursor, and **VLM** (the vision
  model reports a frame-local/canvas point or chooses the next Pull location in
  Guide behavior, where it can rotate, select, compose, or combine prompt
  sources;
  `VLMTracker` renders the resulting local
  `store.vlmPoint` through the normal heatmap sink). Factory in
  `trackers/index.ts`.
- `generation/` — `pipeline.ts` (single `generateOnce` entry point),
  `workflows.ts` (weighted-random selection), `captureHeatmap.ts`, `llm.ts`
  (Ollama-backed provider), `api.ts` (typed fetch wrappers).
- `prompts/` — built-in prompt lists + placeholder substitution.
- `ui/` — React components (`ControlPanel`, `HeatmapView`, `CompositeView`,
  `MainActions`, `WelcomeModal`) and hooks (`useTracker`, `useHeatmap`,
  `useGenerate`, `useIterativeLoop`).
- `lib/persistence.ts` — typed localStorage helpers plus the validated,
  versioned JSON settings export/import format. Imports replace frontend
  preferences atomically; backend service bindings and asset files are not
  part of the file.

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

The Settings drawer's General section changes the same hosts at runtime. Keep
`OLLAMA_KEEP_MODEL_LOADED` off when Ollama shares VRAM with Comfy/Flux; turn it
on for a separate machine to avoid expensive reloads.

## Run (development)

```bash
# Terminal 1 — backend
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn gazecom.main:app --reload --port 8000
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
cd ../backend && uvicorn gazecom.main:app --host 127.0.0.1 --port 8000
```

The backend then serves the SPA at `/` and the API at `/api/*` from one
process — the same shape as the frozen app, minus the launcher.

## Testing

```bash
cd backend && pytest && ruff check .
```
```bash
cd frontend && pnpm typecheck && pnpm test
pnpm test:e2e                                # Playwright smoke (npx playwright install once)
```

`ci.yml` runs ruff + pytest + tsc + vitest on every push to `main`.

## Releases

`release.yml` builds Apple Silicon macOS, Intel macOS, and Windows archives,
gated on `v*` tags, and attaches the zipped artifacts to a GitHub Release.
`workflow_dispatch` builds the artifacts without publishing (for smoke-testing
the freeze). Tag a version to cut a release:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Workflows

The workflow catalog lives in `backend/gazecom/workflow_catalog.py`; frontend
selection and weighted pooling live under `frontend/src/workflows/`. Keep the
scanner, substitution code, tests, and user-facing contract aligned when
changing workflow behavior.

See [WORKFLOWS.md](WORKFLOWS.md) for the canonical category, input-routing,
placeholder, validation, dependency, and override contract.

## Ollama integration

Prompt enhancement and vision call Ollama directly through `/api/llm/*`; they
do not use ComfyUI workflows.
Installed Ollama tags populate both model menus, but selections begin blank and
remain explicit. Missing selections and unavailable models fail visibly rather
than falling back to another installed model. The frontend exposes independent,
model-specific effort controls only when the selected model advertises the
`thinking` capability. Generic thinking families use Ollama's boolean Off / On
values, GPT-OSS uses Low / Medium / High, and Gemma 4 also exposes Max. The
selected value is sent explicitly with every relevant request.

## VLM Guide orchestration

VLM Guide is orchestrated by `generation/pipeline.ts`. Before each generation it
requests a structured canvas decision and moves Pull there. Rotate resolves text
through the normal weighted prompt pool. Its optional Pool context setting
inserts a visible context block containing `{prompt_pool}` into the persisted
editable Rotate prompt. At request time that placeholder expands to positive,
unmuted prompt sources and normalized probabilities; no additional instruction
is injected. Rotate still returns coordinates only and leaves downstream random
selection unchanged. Select expands `{prompt_pool}` inside its persisted editable
prompt, asks for a valid candidate ID, and executes that exact prompt snapshot
through the selected slot's normal transforms. Compose uses a newly authored
instruction. Hybrid makes one structured request that either selects an eligible
prompt without rewriting it or writes a complete standalone prompt, optionally
drawing on concepts exposed in the pool. Select and Hybrid ignore weights and
use mute as candidate membership; hidden weights remain untouched. Hybrid may
write even when no candidates are available.

Guide visual memory is a separate, bounded comparison aid. When enabled, the
frontend retains the canvas observed by the previous accepted Guide decision
and submits it before the current canvas on the next `/api/llm/decision`
request. The current overview is capped at 1024px; the retained comparison copy
is capped at 512px to reduce two-image VLM overhead while preserving aspect
ratio and normalized coordinates. The user-visible memory clause is inserted
into every editable Guide prompt when the toggle is enabled and removed when
disabled. The backend adds no hidden instruction; it only preserves
previous/current image ordering. Failed, aborted, stale, cleared, or
reconfigured decisions do not advance the stored image, and only one previous
`Blob` is retained.

After compositing the result, the pipeline appends the applied decision to
bounded transient chat history, then requests and stores the next decision. The
backend reconstructs Ollama `messages` from coordinates for Rotate, coordinates
plus applied prompts for Select, coordinates plus instructions for Compose, and
source plus final applied prompt for Hybrid, attaching only the latest canvas
image.

`vlmGuideHistoryLimit` controls the retained decision count (20 by default, 0
disables history).

Bounded mode allocates the configured workspace once and centers existing
content; unbounded mode sends the current composite so edge Pulls can expand it.
Pending decisions, history, and workspace readiness are transient, while the
editable Point, Rotate, Select, Compose, and Hybrid instruction templates and
Rotate's Pool context and Guide visual-memory settings persist independently.

## Lineage

gazeCOM is the first public *software* release, a complete rewrite and
expansion of a 2025 prototype. The earlier stage is kept separately as a local
archive, not as a published branch of this repository.
