/**
 * Prompt-slot pool helpers.
 *
 * Unlike the workflow pool (`Record<string, number>` — keys ARE the
 * workflow paths), each prompt slot is an ordered struct: the user
 * types into editable textareas, each carrying its own weight AND its
 * own user-resized height in px. Slots may also opt into automatic LLM
 * enhancement when they are picked. Order matters (slot 0 is the protected
 * base), slots can be temporarily muted without changing their authored
 * relative weights, and ResizeObserver feedback writes back per-slot.
 *
 * Conventions mirror the workflow pool:
 *   - Weights are integers 0–100.
 *   - Weights are relative and normalized implicitly during selection.
 *   - The pool is valid when at least one positive slot is unmuted.
 *   - All helpers are pure and preserve slot order.
 */

export interface PromptSlot {
  text: string;
  weight: number;
  /** Temporarily exclude this slot from weighted selection. */
  muted?: boolean;
  /** User-set textarea height in px. Null = use CSS `rows={3}` default. */
  height: number | null;
  /** Auto-run slot enhancement when this slot is picked for generation. */
  autoEnhanceMode?: PromptAutoEnhanceMode;
  /** Use this slot's text as a VLM instruction before text enhancement. */
  visionEnabled?: boolean;
  /** Last automated prompt produced from this slot's text/instruction. */
  derivedText?: string;
  /** User-set derived-output height in px. Null = use CSS default. */
  derivedHeight?: number | null;
}

export type PromptSlots = PromptSlot[];
export type PromptAutoEnhanceMode = "off" | "send" | "evolve";

/** Empty-pool sentinel for fresh-install initial state. */
export const EMPTY_SLOT: PromptSlot = {
  text: "",
  weight: 0,
  muted: false,
  height: null,
  autoEnhanceMode: "off",
  visionEnabled: false,
  derivedText: "",
  derivedHeight: null,
};

/**
 * Append a new empty slot (`text: ""`, `weight: 0`, `height: null`).
 * The new slot defaults to weight 0 so adding it doesn't affect selection
 * until the user deliberately gives it weight.
 * Returns a new array; the input is not mutated.
 */
export function addPromptSlot(slots: PromptSlots): PromptSlots {
  return [...slots, { ...EMPTY_SLOT }];
}

/**
 * Remove the slot at the given index. Refuses to drop index 0 (the
 * base slot is protected by contract). Returns a new array.
 */
export function removePromptSlot(
  slots: PromptSlots,
  index: number,
): PromptSlots {
  if (index === 0 || index < 0 || index >= slots.length) {
    return slots.slice();
  }
  return [...slots.slice(0, index), ...slots.slice(index + 1)];
}

/** Update one slot's text. */
export function setPromptSlotText(
  slots: PromptSlots,
  index: number,
  text: string,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], text };
  return next;
}

export function setPromptSlotDerivedText(
  slots: PromptSlots,
  index: number,
  derivedText: string,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], derivedText };
  return next;
}

export function setPromptSlotDerivedHeight(
  slots: PromptSlots,
  index: number,
  derivedHeight: number | null,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], derivedHeight };
  return next;
}

export function promptSlotsForPersistence(slots: PromptSlots): PromptSlots {
  return slots.map((slot) => ({ ...slot, derivedText: "" }));
}

/**
 * Update one slot's relative weight. Clamps to integer 0–100.
 */
export function setPromptSlotWeight(
  slots: PromptSlots,
  index: number,
  weight: number,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const clamped = Math.max(0, Math.min(100, Math.round(weight)));
  const next = slots.slice();
  next[index] = { ...next[index], weight: clamped };
  return next;
}

export function promptSlotMuted(slot: PromptSlot | undefined): boolean {
  return slot?.muted === true;
}

export function setPromptSlotMuted(
  slots: PromptSlots,
  index: number,
  muted: boolean,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], muted };
  return next;
}

/**
 * Update one slot's persisted height (px). Called from the per-row
 * ResizeObserver debounce; the textarea applies this via `style.height`
 * on render to restore the user's resize across reloads.
 */
export function setPromptSlotHeight(
  slots: PromptSlots,
  index: number,
  height: number | null,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], height };
  return next;
}

export function promptSlotAutoEnhanceMode(
  slot: PromptSlot | undefined,
): PromptAutoEnhanceMode {
  const mode = slot?.autoEnhanceMode;
  return mode === "send" || mode === "evolve" ? mode : "off";
}

export function nextPromptAutoEnhanceMode(
  mode: PromptAutoEnhanceMode | undefined,
): PromptAutoEnhanceMode {
  switch (mode) {
    case "send":
      return "evolve";
    case "evolve":
      return "off";
    default:
      return "send";
  }
}

export function setPromptSlotAutoEnhanceMode(
  slots: PromptSlots,
  index: number,
  autoEnhanceMode: PromptAutoEnhanceMode,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], autoEnhanceMode };
  return next;
}

export function promptSlotVisionEnabled(slot: PromptSlot | undefined): boolean {
  return slot?.visionEnabled === true;
}

export function setPromptSlotVisionEnabled(
  slots: PromptSlots,
  index: number,
  visionEnabled: boolean,
): PromptSlots {
  if (index < 0 || index >= slots.length) return slots.slice();
  const next = slots.slice();
  next[index] = { ...next[index], visionEnabled };
  return next;
}

/** True when selection has at least one positive, unmuted slot. */
export function promptPoolIsValid(slots: PromptSlots): boolean {
  return promptPoolHasActiveSlot(slots);
}

export function promptPoolHasActiveSlot(slots: PromptSlots): boolean {
  return slots.some((slot) => !promptSlotMuted(slot) && slot.weight > 0);
}

/**
 * Weighted random pick over positive, unmuted slots. Returns the original
 * slot index so downstream transforms keep addressing the correct row.
 */
export function pickPromptSlot(
  slots: PromptSlots,
  rng: () => number = Math.random,
): { text: string; index: number } | null {
  const active = slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => !promptSlotMuted(slot) && slot.weight > 0);
  if (active.length === 0) return null;

  const total = active.reduce((sum, { slot }) => sum + slot.weight, 0);

  let r = rng() * total;
  for (const { slot, index } of active) {
    r -= slot.weight;
    if (r <= 0) return { text: slot.text, index };
  }
  // Belt-and-suspenders for floating-point edge cases.
  const last = active[active.length - 1];
  return { text: last.slot.text, index: last.index };
}
