/**
 * Workflow utilities: strict category detection and weighted-pool helpers.
 *
 * The legacy model had three orthogonal mechanisms (single-pick, random
 * with category weights, auto-mode within a directory subtree). Those
 * collapsed into one concept: a user-managed pool of `path → weight`,
 * where any positive total is normalized at selection time. One pin = single
 * workflow. Many pins = weighted rotation. Zero pins = generation disabled.
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
 * Pin map shape used everywhere: workflow path → relative weight
 * (integer 0–100). Values do not need to sum to 100.
 */
export type PinnedPool = Record<string, number>;

/**
 * Return the selectable subset of a configured pool. Muting is deliberately
 * separate from authored weights: unmuting restores the exact prior mix, while
 * `pickFromPool` naturally normalizes the remaining positive weights.
 */
export function activePool(
  pinned: PinnedPool,
  mutedPaths: readonly string[],
): PinnedPool {
  const muted = new Set(mutedPaths);
  return Object.fromEntries(
    Object.entries(pinned).filter(
      ([path, weight]) => !muted.has(path) && weight > 0,
    ),
  );
}

/**
 * Weighted random pick from the pool. Any positive total is normalized
 * implicitly. Returns `null` when the pool is empty or has no positive weight.
 * `rng` is injectable for deterministic tests.
 */
export function pickFromPool(
  pinned: PinnedPool,
  rng: () => number = Math.random,
): string | null {
  const entries = Object.entries(pinned);
  if (entries.length === 0) return null;

  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return null;

  let r = rng() * total;
  for (const [path, weight] of entries) {
    r -= weight;
    if (r <= 0) return path;
  }
  return entries[entries.length - 1][0];
}

/**
 * Add a workflow to the pool. First pin gets weight 100; subsequent pins
 * default to 0 so adding one does not immediately alter selection. No-op
 * (returns a copy) if the path is already pinned.
 */
export function addToPool(pinned: PinnedPool, path: string): PinnedPool {
  if (Object.hasOwn(pinned, path)) return { ...pinned };
  if (Object.keys(pinned).length === 0) return { [path]: 100 };
  return { ...pinned, [path]: 0 };
}

/**
 * Remove a workflow from the pool without rescaling the remaining relative
 * weights.
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
 * Set one pinned workflow's relative weight directly. Clamps to integer
 * 0–100 and leaves other entries untouched. Returns a new object preserving
 * the input's key order; no-op (returns a copy) if `path` isn't pinned.
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

/** Remove unavailable pins while preserving every remaining weight. */
export function reconcilePool(
  pinned: PinnedPool,
  availablePaths: ReadonlySet<string>,
): PinnedPool {
  const kept = Object.entries(pinned).filter(([path]) => availablePaths.has(path));
  if (kept.length === Object.keys(pinned).length) return { ...pinned };
  return Object.fromEntries(kept);
}
