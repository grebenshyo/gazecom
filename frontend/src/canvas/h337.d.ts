/**
 * Minimal type declarations for heatmap.js (h337).
 *
 * The package ships no types and `@types/heatmapjs` doesn't exist on the
 * registry. We declare only what we use.
 */

declare module "heatmap.js" {
  export interface HeatmapPoint {
    x: number;
    y: number;
    value: number;
    /** Per-point radius override (px). Falls back to the config radius. */
    radius?: number;
  }

  export interface HeatmapData {
    max: number;
    data: HeatmapPoint[];
  }

  export interface HeatmapConfig {
    container: HTMLElement;
    radius?: number;
    maxOpacity?: number;
    minOpacity?: number;
    blur?: number;
    gradient?: Record<string, string>;
  }

  export interface HeatmapInstance {
    addData(point: HeatmapPoint | HeatmapPoint[]): void;
    setData(data: HeatmapData): void;
    getData(): HeatmapData;
    getValueAt(point: { x: number; y: number }): number;
    repaint(): void;
  }

  export function create(config: HeatmapConfig): HeatmapInstance;

  const h337: { create: typeof create };
  export default h337;
}
