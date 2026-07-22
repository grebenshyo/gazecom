/**
 * Prompt module barrel.
 *
 * The pool model is now an ordered array of editable slots
 * (`PromptSlots = { text, weight, height, autoEnhanceMode, visionEnabled, derivedText }[]`) — see `./pool.ts`.
 * Generation picks a slot by weight via `pickPromptSlot` and runs the
 * slot's text through `replaceAllPlaceholders`. Templates from
 * `promptLists` are no longer "pinned" — they're a separate
 * fill-this-field affordance in the panel (the List + Template
 * dropdowns write into whichever slot the user has focused).
 */

import {
  PROMPT_LIST_NAMES,
  promptLists,
  type PromptListName,
} from "./lists";
import { replaceAllPlaceholders } from "./placeholders";

export { PROMPT_LIST_NAMES, promptLists, replaceAllPlaceholders };
export type { PromptListName };

export {
  EMPTY_SLOT,
  addPromptSlot,
  nextPromptAutoEnhanceMode,
  pickPromptSlot,
  promptPoolHasActiveSlot,
  promptSlotAutoEnhanceMode,
  promptSlotMuted,
  promptSlotVisionEnabled,
  promptSlotsForPersistence,
  promptPoolIsValid,
  removePromptSlot,
  setPromptSlotAutoEnhanceMode,
  setPromptSlotDerivedHeight,
  setPromptSlotDerivedText,
  setPromptSlotHeight,
  setPromptSlotMuted,
  setPromptSlotText,
  setPromptSlotVisionEnabled,
  setPromptSlotWeight,
} from "./pool";
export type { PromptAutoEnhanceMode, PromptSlot, PromptSlots } from "./pool";
