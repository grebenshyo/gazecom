/**
 * Workflow utilities: strict category detection and weighted-pool helpers.
 *
 * The legacy model had three orthogonal mechanisms (single-pick, random
 * with category weights, auto-mode within a directory subtree). Those
 * collapsed into one concept: a user-managed pool of `path → weight`,
 * with weights summing to 100. One pin = single workflow. Many pins =
 * weighted rotation. Zero pins = generation disabled.
 *
 * Functions exported here:
 *   - `determineWorkflowType` — pure path-classifier (still used by the
 *     pipeline to branch on in-/outpainting / edit / standard)
 *   - `pickFromPool` — weighted random pick from the pinned pool
 *   - pool mutation helpers and stale-pin reconciliation
 */

export type WorkflowType = "standard" | "inpainting" | "edit";
export type WorkflowCategory = "img" | "edit" | "inpainting";

export interface WorkflowDescriptor {
  path: string;
  label: string;
  category: WorkflowCategory | null;
  type: WorkflowType | null;
  default_steps: number | null;
  placeholders: string[];
  output_node: string | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function determineWorkflowType(workflow: string): WorkflowType {
  const category = workflow.split("/", 1)[0];
  if (category === "img") return "standard";
  if (category === "edit") return "edit";
  if (category === "inpainting") return "inpainting";
  throw new Error(`Unknown workflow category: ${workflow}`);
}

// ── Pool ────────────────────────────────────────────────────────────────

/**
 * Pin map shape used everywhere: workflow path → weight (integer 0–100).
 * The invariant is that the sum of all values equals 100 whenever the
 * pool is non-empty. The rebalance helpers below all preserve this.
 */
export type PinnedPool = Record<string, number>;

/**
 * Weighted random pick from the pool. Returns `null` only on an empty
 * pool — callers (the pipeline) translate that into a "No workflow
 * selected" error. `rng` is injectable for deterministic tests.
 *
 * If every weight is 0 (degenerate — shouldn't happen if we maintain the
 * sum-100 invariant), falls back to a uniform pick over the keys so
 * we don't infinite-loop on rejection sampling.
 */
export function pickFromPool(
  pinned: PinnedPool,
  rng: () => number = Math.random,
): string | null {
  const entries = Object.entries(pinned);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) {
    return entries[Math.floor(rng() * entries.length)][0];
  }

  let r = rng() * total;
  for (const [path, weight] of entries) {
    r -= weight;
    if (r <= 0) return path;
  }
  return entries[entries.length - 1][0];
}

/**
 * Add a workflow to the pool. First pin gets weight 100 (forms a valid
 * single-pin pool); subsequent pins default to 0 so they don't disturb
 * the existing sum. The user is responsible for raising the new pin's
 * weight and lowering others to keep `poolSum` at 100. No-op (returns
 * a copy) if the path is already pinned.
 */
export function addToPool(pinned: PinnedPool, path: string): PinnedPool {
  if (Object.hasOwn(pinned, path)) return { ...pinned };
  if (Object.keys(pinned).length === 0) return { [path]: 100 };
  return { ...pinned, [path]: 0 };
}

/**
 * Remove a workflow from the pool. No rescaling — the remaining entries
 * keep their current weights, which may leave `poolSum !== 100` and
 * surface a warning in the UI until the user fixes it.
 */
export function removeFromPool(
  pinned: PinnedPool,
  path: string,
): PinnedPool {
  if (!Object.hasOwn(pinned, path)) return { ...pinned };
  const next: PinnedPool = {};
  for (const k of Object.keys(pinned)) {
    if (k !== path) next[k] = pinned[k];
  }
  return next;
}

/**
 * Set one pinned workflow's weight directly. Clamps to integer 0–100.
 * Other entries are untouched — keeping the sum at 100 is the user's
 * job. Returns a new object preserving the input's key order; no-op
 * (returns a copy) if `path` isn't pinned.
 */
export function setPoolWeight(
  pinned: PinnedPool,
  path: string,
  newWeight: number,
): PinnedPool {
  if (!Object.hasOwn(pinned, path)) return { ...pinned };
  const clamped = Math.max(0, Math.min(100, Math.round(newWeight)));
  return { ...pinned, [path]: clamped };
}

/** Sum of all pinned weights. Empty pool returns 0. */
export function poolSum(pinned: PinnedPool): number {
  return Object.values(pinned).reduce((s, w) => s + w, 0);
}

/**
 * True iff the pool is non-empty AND weights sum to exactly 100. The
 * UI's Generate-button disabled gate and the on-screen "100% required"
 * warning both read this.
 */
export function poolIsValid(pinned: PinnedPool): boolean {
  return Object.keys(pinned).length > 0 && poolSum(pinned) === 100;
}

/** Remove unavailable pins and proportionally restore the 100% invariant. */
export function reconcilePool(
  pinned: PinnedPool,
  availablePaths: ReadonlySet<string>,
): PinnedPool {
  const kept = Object.entries(pinned).filter(([path]) => availablePaths.has(path));
  if (kept.length === Object.keys(pinned).length) return { ...pinned };
  if (kept.length === 0) return {};

  const total = kept.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
  const shares = kept.map(([path, weight], index) => {
    const raw = total > 0 ? (Math.max(0, weight) / total) * 100 : 100 / kept.length;
    const base = Math.floor(raw);
    return { path, index, base, fraction: raw - base };
  });
  let remainder = 100 - shares.reduce((sum, share) => sum + share.base, 0);
  for (const share of [...shares].sort(
    (a, b) => b.fraction - a.fraction || a.index - b.index,
  )) {
    if (remainder <= 0) break;
    share.base += 1;
    remainder -= 1;
  }
  return Object.fromEntries(shares.map(({ path, base }) => [path, base]));
}
