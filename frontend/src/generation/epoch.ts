/**
 * Generation epoch — a monotonic counter that lets the UI invalidate an
 * in-flight generation's APPLY step without aborting the network request
 * or stopping the iterative loop.
 *
 * Used by Pull and Clear in MainActions: those actions need to take
 * effect during a generation (the user shifted focus or wiped the
 * canvas mid-flight), but aborting the fetch has two undesirable
 * side-effects we want to avoid:
 *
 *   1. Iterative mode halts (because useIterativeLoop treats any throw
 *      from generate() as a fatal halt).
 *   2. The user feels like work was wasted: they clicked Pull while a
 *      slow generation was running, the request gets cancelled, and
 *      they have to wait for the next iteration to resume.
 *
 * Solution: let the network leg complete naturally, but record an epoch
 * at the start of each generation. When the result arrives, applyResult
 * compares its captured epoch to the live counter — if Pull or Clear
 * bumped it in between, the result is silently dropped (no canvas
 * update, no store writes). The iterative loop's tick then schedules
 * the next iteration against the fresh post-pull / post-clear state.
 *
 * Module-level singleton: not UI-reactive (no re-renders needed), pure
 * monotonic counter, lives until page reload.
 */

let counter = 0;

/** Read the current epoch. Called by the pipeline at generation start. */
export function getEpoch(): number {
  return counter;
}

/**
 * Bump the epoch. Called by Pull/Clear in MainActions when a generation
 * is in flight, signalling the pipeline to drop the result at apply
 * time. Safe to call when nothing is in flight — just increments a
 * counter that no one will read.
 */
export function bumpEpoch(): void {
  counter++;
}
