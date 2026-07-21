/**
 * LLM provider abstraction.
 *
 * gazeCOM enhances prompts through its backend, which calls Ollama's local
 * HTTP API directly. The frontend keeps this tiny provider layer so a
 * future backend can be swapped without rewriting UI components.
 */

import {
  describeImageRequest,
  enhancePromptRequest,
  pointFromImageRequest,
  type VLMPoint,
} from "./api";
import type { LLMModel } from "../store";

export interface LLMProvider {
  /**
   * Enhance the prompt according to `template`. Returns trimmed text.
   * `signal` (optional) lets callers abort the in-flight request.
   */
  enhance(
    prompt: string,
    template: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export class OllamaLLMProvider implements LLMProvider {
  constructor(private readonly model: LLMModel) {}

  async enhance(
    prompt: string,
    template = "",
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await enhancePromptRequest(
      { prompt, model: this.model, template },
      signal,
    );
    return text.trim() || prompt;
  }
}

export class OllamaVLMProvider {
  constructor(private readonly model: LLMModel) {}

  async describe(
    image: Blob,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await describeImageRequest(
      {
        image,
        imageName: "vision_input.png",
        prompt,
        model: this.model,
      },
      signal,
    );
    return text.trim();
  }

  /**
   * Locate the single most salient point in `image`. `prompt` overrides the
   * backend's default instruction (empty string keeps the default). Returns
   * `null` when the model produced no parseable coordinates, so callers can
   * resubmit rather than treat it as an error.
   */
  async point(
    image: Blob,
    prompt = "",
    signal?: AbortSignal,
  ): Promise<VLMPoint | null> {
    return pointFromImageRequest(
      {
        image,
        imageName: "vision_input.png",
        prompt,
        model: this.model,
      },
      signal,
    );
  }
}
