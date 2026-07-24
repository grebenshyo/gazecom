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

export const PULL_PATCH_SIZE = 1024;

export interface PullPosition {
  x: number;
  y: number;
}

type PullHandler = (position?: PullPosition) => Promise<void>;

let pullHandler: PullHandler | null = null;
let homeHandler: (() => void) | null = null;

export const pullHandle = {
  /** PullTool calls this on mount with its handler, and again with `null` on unmount. */
  register(fn: PullHandler | null): void {
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
  /** Move the bbox and pull from an explicit composite-space top-left. */
  triggerAt(position: PullPosition): Promise<void> {
    if (!pullHandler) {
      return Promise.reject(new Error("Pull tool is unavailable."));
    }
    return pullHandler(position);
  },
  /** Move the bbox back to the current first-patch position. */
  triggerHome(): void {
    homeHandler?.();
  },
};
