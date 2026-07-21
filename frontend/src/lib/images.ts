/**
 * Helpers for turning a server-served image URL into a 1024×1024 PNG data
 * URL ready to seed the generation pipeline.
 *
 * Replaces legacy image-processor.js:385-435 (processInitialImage). Same
 * crop-to-largest-centered-square + resize-to-target-square logic, kept
 * pure (no DOM lookups, no store touches — caller wires those).
 */

const TARGET = 1024;

export async function processImageURLToBaseSquare(
  imageURL: string,
): Promise<string> {
  const img = await loadImage(imageURL);
  const side = Math.min(img.width, img.height);
  if (side === 0) {
    throw new Error("processImageURLToBaseSquare: image has zero dimensions");
  }
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TARGET;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("processImageURLToBaseSquare: no 2D context");
  }
  ctx.drawImage(img, sx, sy, side, side, 0, 0, TARGET, TARGET);
  return canvas.toDataURL("image/png");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error(`loadImage: failed for ${src.slice(0, 80)}`));
    img.src = src;
  });
}
