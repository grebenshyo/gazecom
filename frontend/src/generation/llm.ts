/**
 * LLM provider abstraction.
 *
 * gazeCOM enhances prompts through its backend, which calls Ollama's local
 * HTTP API directly. The frontend keeps this tiny provider layer so a
 * future backend can be swapped without rewriting UI components.
 */

import {
  composeDecisionFromImageRequest,
  describeImageRequest,
  guideDecisionFromImageRequest,
  hybridDecisionFromImageRequest,
  selectDecisionFromImageRequest,
  enhancePromptRequest,
  pointFromImageRequest,
  type VLMComposeDecision,
  type VLMGuideDecision,
  type VLMHybridDecision,
  type VLMHybridHistoryItem,
  type VLMSelectDecision,
  type VLMSelectHistoryItem,
  type VLMPoint,
  type OllamaThink,
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
  constructor(
    private readonly model: LLMModel,
    private readonly think?: OllamaThink,
  ) {}

  async enhance(
    prompt: string,
    template = "",
    signal?: AbortSignal,
  ): Promise<string> {
    const text = await enhancePromptRequest(
      { prompt, model: this.model, template, think: this.think },
      signal,
    );
    return text.trim() || prompt;
  }
}

export class OllamaVLMProvider {
  constructor(
    private readonly model: LLMModel,
    private readonly think?: OllamaThink,
  ) {}

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
        think: this.think,
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
        think: this.think,
      },
      signal,
    );
  }

  /** Choose the next canvas location, with bounded retries handled by the pipeline. */
  async compose(
    image: Blob,
    prompt: string,
    history: VLMComposeDecision[],
    signal?: AbortSignal,
  ): Promise<VLMComposeDecision | null> {
    return composeDecisionFromImageRequest(
      {
        image,
        imageName: "vision_canvas.png",
        prompt,
        model: this.model,
        history,
        behavior: "compose",
        think: this.think,
      },
      signal,
    );
  }

  async guide(
    image: Blob,
    prompt: string,
    history: VLMGuideDecision[],
    signal?: AbortSignal,
  ): Promise<VLMGuideDecision | null> {
    return guideDecisionFromImageRequest(
      {
        image,
        imageName: "vision_canvas.png",
        prompt,
        model: this.model,
        history,
        behavior: "guide",
        think: this.think,
      },
      signal,
    );
  }

  async select(
    image: Blob,
    prompt: string,
    promptIds: number[],
    history: VLMSelectHistoryItem[],
    signal?: AbortSignal,
  ): Promise<VLMSelectDecision | null> {
    return selectDecisionFromImageRequest(
      {
        image,
        imageName: "vision_canvas.png",
        prompt,
        model: this.model,
        history,
        behavior: "select",
        promptIds,
        think: this.think,
      },
      signal,
    );
  }

  async hybrid(
    image: Blob,
    prompt: string,
    promptIds: number[],
    history: VLMHybridHistoryItem[],
    signal?: AbortSignal,
  ): Promise<VLMHybridDecision | null> {
    return hybridDecisionFromImageRequest(
      {
        image,
        imageName: "vision_canvas.png",
        prompt,
        model: this.model,
        history,
        behavior: "hybrid",
        promptIds,
        think: this.think,
      },
      signal,
    );
  }
}
