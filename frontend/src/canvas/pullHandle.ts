/**
 * Pull-tool action handle.
 *
 * The Pull button lives in the actions bar (MainActions) but the bbox state
 * — image-space position, drag deltas — lives inside `PullTool`. Lifting
 * `pos` into the store would force a Zustand re-render on every pointer
 * move during a drag; we don't want that.
 *
 * Instead PullTool registers its handlers here on mount, and external UI
 * buttons call through this module. Module-level singleton because there is
 * exactly one PullTool in the tree.
 */

let pullHandler: (() => Promise<void>) | null = null;
let homeHandler: (() => void) | null = null;

export const pullHandle = {
  /** PullTool calls this on mount with its handler, and again with `null` on unmount. */
  register(fn: (() => Promise<void>) | null): void {
    pullHandler = fn;
  },
  /** PullTool calls this on mount with its bbox-home handler. */
  registerHome(fn: (() => void) | null): void {
    homeHandler = fn;
  },
  /** No-op if no PullTool is mounted. */
  trigger(): Promise<void> {
    return pullHandler ? pullHandler() : Promise.resolve();
  },
  /** Move the bbox back to the current first-patch position. */
  triggerHome(): void {
    homeHandler?.();
  },
};
