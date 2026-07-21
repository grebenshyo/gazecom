import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During development, the FastAPI backend runs on :8000 and the Vite dev
// server proxies /api requests to it. In production, the backend serves the
// built frontend statically (see backend/main.py mount).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/images": "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "happy-dom",
    globals: true,
    // Playwright specs in e2e/ also end in .spec.ts; keep them out of vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
