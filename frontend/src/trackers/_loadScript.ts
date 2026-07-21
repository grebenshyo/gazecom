/**
 * Lazy <script> tag loader. Used by WebGazer, Handpose, and Saliency
 * trackers — each loads its dependency from a CDN on first use so the
 * other trackers don't pay the bundle cost.
 *
 * The legacy code reimplemented this same loader in three different files
 * (webgazer.js:113, handpose.js, saliency.js); now there's one.
 */

const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  if (loaded.has(src)) return Promise.resolve();
  const existing = inflight.get(src);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = src;
    tag.async = true;
    tag.onload = () => {
      loaded.add(src);
      inflight.delete(src);
      resolve();
    };
    tag.onerror = () => {
      inflight.delete(src);
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(tag);
  });

  inflight.set(src, promise);
  return promise;
}
