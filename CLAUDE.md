# gazeCOM AI Assistant Instructions

## Session Quickstart

- **Always read README.md first** for the overall project layout.
- **Check recent commits on `main`** to understand what landed last.
- The pre-rewrite prototype is kept in a separate local archive, not in this
  repository. Current behavior and architecture are documented here and in
  `docs/DEVELOPMENT.md`.

## Important Instructions

- Do NOT add Anthropic branding to git commits ("Generated with Claude
  Code", "Co-Authored-By: Claude", etc.).
- **Never commit without explicit user consent** — propose a message
  and wait.
- For destructive git operations (force push, hard reset, branch -D),
  ask first.

## Repo Layout

```
backend/      FastAPI + websocket ComfyUI client (Python 3.11+)
frontend/     Vite + React + TypeScript SPA
workflows/    ComfyUI workflow JSON templates
images/       reference images (served at /images/*)
.env.example  config template (paths, ComfyUI host, timeouts)
```

### Backend modules

- `gengaze/config.py` — pydantic-settings loaded from `.env`. **No
  hardcoded paths.**
- `gengaze/comfy_client.py` — `ComfyClient.run_for_image` opens a websocket
  to ComfyUI and listens for the `executed` event. **Do not reintroduce
  filesystem polling.**
- `gengaze/workflow_catalog.py` — scans bundled + user workflow roots,
  validates the three category contracts, and applies user overrides.
- `gengaze/workflow.py` — pure `substitute_placeholders` (unit-tested).
- `gengaze/routes/` — one file per resource; routers mounted in
  `main.create_app`. FastAPI route modules have `B008` ruff exemption.
- `gengaze/main.py` — app factory with CORS + static `/images` mount.
  Auto-mounts `frontend/dist/` in production.

### Frontend modules

```
src/
├── store/index.ts          # Zustand store, single source of truth
├── canvas/
│   ├── Composite.ts        # Pure planComposite + applyPlan (13 tests)
│   ├── Heatmap.ts          # Gradient styles + gazeCOM (11 tests)
│   ├── HeatmapInstance.ts  # h337 wrapper, implements HeatmapSink
│   ├── PullTool.tsx        # 1024² crop box (uses panzoom API directly)
│   └── h337.d.ts           # local types — no @types pkg exists
├── trackers/
│   ├── Tracker.ts          # interface: init/start/stop/dispose
│   ├── _trail.ts           # shared TrailBuffer (dedupes 4 legacy files)
│   ├── _loadScript.ts      # idempotent CDN script loader
│   ├── WebGazerTracker.ts
│   ├── HandposeTracker.ts
│   ├── SaliencyTracker.ts
│   ├── RoamTracker.ts      # 7 tests
│   ├── Roam2Tracker.ts     # 5 tests
│   ├── CursorTracker.ts    # 5 tests
│   └── index.ts            # createTracker(mode, ctx, refs) factory
├── generation/
│   ├── api.ts              # typed fetch wrappers
│   ├── workflows.ts        # strict type detection + weighted workflow pool
│   ├── captureHeatmap.ts   # replaces html2canvas
│   ├── llm.ts              # direct Ollama LLM/VLM providers
│   └── pipeline.ts         # SINGLE generateOnce(ctx) entry point
├── prompts/
│   ├── lists.ts
│   ├── placeholders.ts     # {cartoon character} etc. (7 tests)
│   └── index.ts            # weighted prompt-slot selection
├── lib/persistence.ts      # typed StorageKeys + readJSON/writeJSON
├── ui/
│   ├── App.tsx             # shell — threads heatmap ref → pipeline
│   ├── ControlPanel.tsx    # all toggles bound to store (replaces 1500-line legacy)
│   ├── HeatmapView.tsx     # owns HeatmapInstance + active tracker
│   ├── CompositeView.tsx   # panzoom + PullTool
│   ├── MainActions.tsx     # tracking + generate + download
│   ├── WelcomeModal.tsx
│   ├── components/         # controls + grouped WorkflowPicker
│   └── hooks/
│       ├── useHeatmap.ts
│       ├── useTracker.ts
│       └── useGenerate.ts  # generate() + useIterativeLoop
└── styles/global.css       # CSS vars for light/dark themes
```

## Architecture invariants

- **One source of truth.** State lives in `store/index.ts` (Zustand).
  Don't introduce `window.*` mirrors, don't read `document.getElementById`
  for state. Persistence to localStorage flows through the store's
  `subscribeWithSelector` middleware — no `localStorage.setItem` calls
  in components.
- **Pure functions where possible.** `Composite.planComposite`,
  `Heatmap.gazeCOM`, `workflows.pickFromPool`, `prompts.pickPromptSlot`
  — all pure, all unit-tested. Don't add DOM dependencies to these.
- **Trackers don't reach into `window.*`.** They take a `HeatmapSink`
  and a `getContainerSize` callback at construction. The React layer
  injects both. Don't add a global heatmap reference.
- **One generation entry point.** `generateOnce(ctx)` in
  `generation/pipeline.ts` handles all five workflow×COM combinations.
  Don't add a parallel `processX` method — extend `buildInput` if a new
  branch is needed.
- **Iterative loop is a `useEffect`.** `useIterativeLoop` in
  `ui/hooks/useGenerate.ts`. Delay changes auto-restart cleanly because
  the deps array includes `iterativeDelay`. Don't reintroduce a
  long-lived `setInterval` handle.
- **LLM/VLM calls Ollama directly.** Keep prompt enhancement and vision in
  the `/api/llm/*` routes and their frontend providers; do not route them
  through ComfyUI workflows again.

## Testing

- Backend: `cd backend && pytest` (67 tests). Pure functions and routes
  with `tmp_path` fixtures.
- Frontend unit: `cd frontend && pnpm test` (176 vitest tests).
- Frontend e2e: `cd frontend && pnpm test:e2e` (Playwright; requires
  `npx playwright install` once for browser binaries).
- CI runs ruff + pytest + tsc + vitest on push.

## Pitfalls (real ones)

- **`-0` vs `+0` in canvas math.** `Math.min(0, x)` where `x>=0` gives
  `+0`; negating it via `-minX` gives `-0` which fails strict equality.
  `Composite.ts` works around this; preserve the pattern.
- **Zustand persistence and module reset.** The store hydrates from
  localStorage at module-load time. Tests that need a clean store must
  call `vi.resetModules()` before importing.
- **MediaPipe Hands video element.** Owned by the React tree
  (`HeatmapView.tsx`), not by the tracker. Don't have the tracker
  inject a `<video>` into the DOM directly.

## What's safe to modify

- Adding a new tracker: implement `Tracker`, register in
  `trackers/index.ts`, add a case to `TrackingMode` in `store/index.ts`,
  add the dropdown option in `ControlPanel.tsx`. No other files needed.
- Adding a new prompt list: edit `prompts/lists.ts` and add the name to
  `PROMPT_LIST_NAMES`. No other files needed.
- Adding a new heatmap style: edit `canvas/Heatmap.ts`
  (`heatmapStyles`) and add the option to `ControlPanel.tsx`.
- Adding a workflow: place an API-format JSON directly in `img/`, `edit/`,
  or `inpainting/`, follow the placeholder contract in `docs/DEVELOPMENT.md`,
  and let the catalog scanner validate it.
