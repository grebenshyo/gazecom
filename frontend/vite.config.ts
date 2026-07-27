import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { marked } from "marked";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const GUIDE_PATH = fileURLToPath(new URL("../docs/GUIDE.md", import.meta.url));
const GUIDE_MODULE_ID = "virtual:gazecom-guide";
const RESOLVED_GUIDE_MODULE_ID = `\0${GUIDE_MODULE_ID}`;

function guideHeadingId(label: string): string {
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `guide-${slug}`;
}

function compileGuideModule(): string {
  const markdown = readFileSync(GUIDE_PATH, "utf8");
  const sections = Array.from(markdown.matchAll(/^##\s+(.+?)\s*$/gm), (match) => ({
    id: guideHeadingId(match[1]),
    label: match[1],
  }));
  let sectionIndex = 0;
  let html = marked.parse(markdown, { async: false, gfm: true });

  // The section list and rendered IDs come from the same headings, keeping the
  // in-app jump menu synchronized with the canonical Markdown document.
  html = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (heading) => {
    const section = sections[sectionIndex++];
    return section
      ? heading.replace("<h2>", `<h2 id="${section.id}">`)
      : heading;
  });
  html = html.replace(
    /<a href="/g,
    '<a target="_blank" rel="noreferrer" href="',
  );
  const firstSection = html.indexOf("<h2");
  const headerHtml = firstSection >= 0 ? html.slice(0, firstSection) : html;
  const bodyHtml = firstSection >= 0 ? html.slice(firstSection) : "";

  return [
    `export const guideHeaderHtml = ${JSON.stringify(headerHtml)};`,
    `export const guideHtml = ${JSON.stringify(bodyHtml)};`,
    `export const guideSections = ${JSON.stringify(sections)};`,
  ].join("\n");
}

function guideMarkdownPlugin(): Plugin {
  return {
    name: "gazecom-guide-markdown",
    resolveId(id) {
      return id === GUIDE_MODULE_ID ? RESOLVED_GUIDE_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_GUIDE_MODULE_ID) return null;
      this.addWatchFile(GUIDE_PATH);
      return compileGuideModule();
    },
    configureServer(server) {
      server.watcher.add(GUIDE_PATH);
      server.watcher.on("change", (path) => {
        if (resolve(path) !== resolve(GUIDE_PATH)) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_GUIDE_MODULE_ID);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      });
    },
  };
}

// During development, the FastAPI backend runs on :8000 and the Vite dev
// server proxies /api requests to it. In production, the backend serves the
// built frontend statically (see backend/main.py mount).
export default defineConfig({
  plugins: [guideMarkdownPlugin(), react()],
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
