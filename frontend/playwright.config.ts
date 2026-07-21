import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the gazeCOM frontend smoke test.
 *
 * The test runs against the Vite dev server (auto-started). The backend
 * is *not* started here — the smoke test mocks /api/* responses with
 * Playwright route handlers so it doesn't need ComfyUI or the FastAPI
 * server running.
 *
 * For a full integration test against a real ComfyUI you'd run:
 *   cd backend && uvicorn gengaze.main:app --port 8000 &
 *   cd frontend && pnpm dev &
 *   pnpm test:e2e
 * (and remove the route mocks below).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
