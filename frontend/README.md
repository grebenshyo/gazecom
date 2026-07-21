# gazeCOM frontend

Vite + React + TypeScript. Talks to the FastAPI backend over `/api/*`.

## Setup

```bash
cd frontend
pnpm install              # or: npm install / yarn install
```

## Dev

In one terminal:

```bash
cd backend && uvicorn gengaze.main:app --reload --port 8000
```

In another:

```bash
cd frontend && pnpm dev
```

Open <http://localhost:5173>. Vite proxies `/api/*` and `/images/*` to :8000.

## Production build

```bash
pnpm build
```

The static bundle in `dist/` is served by the backend (mounted under `/`).

## Tests

```bash
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest unit tests
pnpm test:e2e        # playwright (after `pnpm dlx playwright install`)
```

## Status

This is the production gazeCOM interface. Runtime state lives in the Zustand
store; tracker, heatmap, generation, and compositing modules are documented in
[`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).
