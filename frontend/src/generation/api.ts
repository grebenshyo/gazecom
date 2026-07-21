/**
 * Backend API client.
 *
 * Wraps `POST /api/generate` and `POST /api/upload`. The previous frontend
 * built FormData inline at the call site (legacy generation-engine.js:496-532
 * and ui-controller.js:760-810) — here it's a typed module the rest of the
 * pipeline depends on.
 */

import type { WorkflowDescriptor } from "./workflows";

export interface GenerateRequest {
  /** PNG bytes encoded as a Blob. */
  image: Blob;
  /** Filename hint sent to the backend (informational; backend renames). */
  imageName: string;
  /** Merged workflow-catalog key (e.g. "img/SDXL-TURBO.json"). */
  workflow: string;
  prompt: string;
  steps: number;
  /**
   * When true, the backend swallows execution errors from known
   * cloud-provider nodes and
   * returns 204 No Content. The caller treats that as a `skipped`
   * response — no image, no error, iterative loop continues.
   */
  skipProviderErrors?: boolean;
}

export interface LLMResponse {
  text: string;
}

export interface LLMEnhanceRequest {
  prompt: string;
  model: string;
  template?: string;
}

export interface VLMDescribeRequest {
  image: Blob;
  imageName: string;
  prompt: string;
  model: string;
}

export interface VLMPointRequest {
  image: Blob;
  imageName: string;
  /** Instruction override; empty string uses the backend default. */
  prompt: string;
  model: string;
}

/** Salient point normalized to [0, 1] over the submitted image. */
export interface VLMPoint {
  x: number;
  y: number;
}

export type GenerateResponse =
  | { kind: "image"; blob: Blob; objectURL: string }
  | { kind: "skipped" };

const API_BASE = ""; // same-origin via Vite proxy in dev, mounted in prod

async function responseMessage(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string") return body.detail;
  } catch {
    // Plain-text backend errors are fine; fall through to the raw body.
  }
  return text;
}

async function httpError(resp: Response, fallback: string): Promise<Error> {
  const text = await responseMessage(resp);
  return new Error(
    `${fallback}: HTTP ${resp.status}${text ? " - " + text : ""}`,
  );
}

export async function generateRequest(
  req: GenerateRequest,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const fd = new FormData();
  fd.append("image", req.image, req.imageName);
  fd.append("workflow", req.workflow);
  fd.append("prompt", req.prompt);
  fd.append("steps", String(req.steps));
  if (req.skipProviderErrors) {
    fd.append("skip_provider_errors", "true");
  }

  const resp = await fetch(`${API_BASE}/api/generate`, {
    method: "POST",
    body: fd,
    signal,
  });

  // 204 = backend swallowed a known provider-error (Gemini policy refusal
  // etc.) at the caller's request. The pipeline treats this as "do
  // nothing, no error" so iterative mode can carry on.
  if (resp.status === 204) {
    return { kind: "skipped" };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Generation failed: HTTP ${resp.status} ${resp.statusText}${text ? " — " + text : ""}`,
    );
  }

  const blob = await resp.blob();
  return { kind: "image", blob, objectURL: URL.createObjectURL(blob) };
}

export async function uploadImage(file: File): Promise<{ filename: string }> {
  const fd = new FormData();
  fd.append("image", file);
  const resp = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    body: fd,
  });
  if (!resp.ok) {
    throw new Error(`Upload failed: HTTP ${resp.status}`);
  }
  return resp.json() as Promise<{ filename: string }>;
}

export async function fetchWorkflows(): Promise<WorkflowDescriptor[]> {
  const resp = await fetch(`${API_BASE}/api/workflows`);
  if (!resp.ok) throw new Error(`Workflows failed: HTTP ${resp.status}`);
  return resp.json() as Promise<WorkflowDescriptor[]>;
}

export async function fetchImages(): Promise<string[]> {
  const resp = await fetch(`${API_BASE}/api/images`);
  if (!resp.ok) throw new Error(`Images failed: HTTP ${resp.status}`);
  return resp.json() as Promise<string[]>;
}

export interface AppConfig {
  /** Effective ComfyUI host:port the backend is using. */
  comfy_host: string;
  /** Effective Ollama host:port the backend is using. */
  ollama_host: string;
  /** Whether Ollama keeps the selected LLM resident after enhancement. */
  ollama_keep_model_loaded: boolean;
  /** User-entered override, or null when the effective host is a setup default. */
  comfy_host_override: string | null;
  /** User-entered override, or null when the effective host is a setup default. */
  ollama_host_override: string | null;
}

/** Read the backend's effective runtime config (ComfyUI host, …). */
export async function fetchConfig(): Promise<AppConfig> {
  const resp = await fetch(`${API_BASE}/api/config`);
  if (!resp.ok) throw new Error(`Config failed: HTTP ${resp.status}`);
  return resp.json() as Promise<AppConfig>;
}

/** Delete runtime overrides and return the environment/default config. */
export async function resetConfig(): Promise<AppConfig> {
  const resp = await fetch(`${API_BASE}/api/config`, { method: "DELETE" });
  if (!resp.ok) throw await httpError(resp, "Config reset failed");
  return resp.json() as Promise<AppConfig>;
}

/** Persist the ComfyUI host (per-user, server-side). Returns the effective config. */
export async function setComfyHost(host: string): Promise<AppConfig> {
  const resp = await fetch(`${API_BASE}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comfy_host: host }),
  });
  if (!resp.ok) throw await httpError(resp, "Config save failed");
  return resp.json() as Promise<AppConfig>;
}

/** Persist the Ollama host (per-user, server-side). Returns the effective config. */
export async function setOllamaHost(host: string): Promise<AppConfig> {
  const resp = await fetch(`${API_BASE}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ollama_host: host }),
  });
  if (!resp.ok) {
    const err = await httpError(resp, "Config save failed");
    if (resp.status === 422 && err.message.includes("comfy_host")) {
      throw new Error(
        "Backend is still running the old config route. Restart gazeCOM/the backend, then save the Ollama host again.",
      );
    }
    throw err;
  }
  return resp.json() as Promise<AppConfig>;
}

/** Persist whether Ollama keeps the LLM loaded after prompt enhancement. */
export async function setOllamaKeepModelLoaded(
  keepLoaded: boolean,
): Promise<AppConfig> {
  const resp = await fetch(`${API_BASE}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ollama_keep_model_loaded: keepLoaded }),
  });
  if (!resp.ok) throw await httpError(resp, "Config save failed");
  return resp.json() as Promise<AppConfig>;
}

export async function fetchLlmModels(): Promise<string[]> {
  const resp = await fetch(`${API_BASE}/api/llm/models`);
  if (!resp.ok) throw new Error(`LLM models failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { models?: string[] };
  return body.models ?? [];
}

export async function enhancePromptRequest(
  req: LLMEnhanceRequest,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetch(`${API_BASE}/api/llm/enhance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!resp.ok) {
    const text = await responseMessage(resp);
    throw new Error(
      `LLM enhance failed: HTTP ${resp.status}${text ? " — " + text : ""}`,
    );
  }
  const body = (await resp.json()) as LLMResponse;
  return body.text;
}

export async function describeImageRequest(
  req: VLMDescribeRequest,
  signal?: AbortSignal,
): Promise<string> {
  const fd = new FormData();
  fd.append("image", req.image, req.imageName);
  fd.append("prompt", req.prompt);
  fd.append("model", req.model);

  const resp = await fetch(`${API_BASE}/api/llm/describe`, {
    method: "POST",
    body: fd,
    signal,
  });
  if (!resp.ok) {
    const text = await responseMessage(resp);
    throw new Error(
      `VLM describe failed: HTTP ${resp.status}${text ? " — " + text : ""}`,
    );
  }
  const body = (await resp.json()) as LLMResponse;
  return body.text;
}

/**
 * Ask the VLM for the single most salient point in `image`. Returns the
 * normalized point, or `null` when the model reached but produced no
 * parseable coordinates (backend 422) — the caller decides whether to
 * resubmit. Genuine transport failures (502 etc.) throw.
 */
export async function pointFromImageRequest(
  req: VLMPointRequest,
  signal?: AbortSignal,
): Promise<VLMPoint | null> {
  const fd = new FormData();
  fd.append("image", req.image, req.imageName);
  fd.append("prompt", req.prompt);
  fd.append("model", req.model);

  const resp = await fetch(`${API_BASE}/api/llm/point`, {
    method: "POST",
    body: fd,
    signal,
  });
  // 422 = the model answered but no coordinates could be parsed. Not an
  // error — signal "no point this time" so the caller can resubmit.
  if (resp.status === 422) {
    return null;
  }
  if (!resp.ok) {
    const text = await responseMessage(resp);
    throw new Error(
      `VLM point failed: HTTP ${resp.status}${text ? " — " + text : ""}`,
    );
  }
  return (await resp.json()) as VLMPoint;
}
