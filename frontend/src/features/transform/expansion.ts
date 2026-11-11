import type { TransformExpansion, TransformRect } from "@/shared/types";

export const MAX_TRANSFORM_PIXELS = 64 * 1024 * 1024;
export const MAX_TRANSFORM_DIMENSION = 16384;

export function validateTransformFrame(frame: TransformRect): TransformRect {
  if (![frame.x, frame.y, frame.width, frame.height].every(Number.isSafeInteger)
    || frame.width < 1 || frame.height < 1
    || frame.width > MAX_TRANSFORM_DIMENSION || frame.height > MAX_TRANSFORM_DIMENSION
    || frame.width * frame.height > MAX_TRANSFORM_PIXELS) {
    throw new Error("The frame must use whole pixels, fit within 16,384 px per side and contain at most 64 megapixels.");
  }
  return frame;
}

export function normalizeTransformExpansion(value: unknown): TransformExpansion | null {
  if (value == null) return null;
  const raw = value as TransformExpansion;
  if (!raw || typeof raw !== "object" || !raw.base) throw new Error("Invalid expansion frame.");
  const base = validateTransformFrame({ ...raw.base });
  if (![raw.left, raw.top, raw.right, raw.bottom, raw.transition].every(v => Number.isSafeInteger(v) && v >= 0)
    || raw.transition > MAX_TRANSFORM_DIMENSION) throw new Error("Padding and transition must be nonnegative whole pixels.");
  const next = { base, left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom, transition: raw.transition };
  expansionFrame(next);
  return next;
}

export function expansionFrame(expansion: TransformExpansion): TransformRect {
  const { base, left, top, right, bottom } = expansion;
  return validateTransformFrame({ x: base.x - left, y: base.y - top,
    width: base.width + left + right, height: base.height + top + bottom });
}

/** Coverage is independent of alpha: 0 preserves, 255 generates. */
export function expansionCoverage(expansion: TransformExpansion, rgba?: Uint8ClampedArray): Uint8ClampedArray {
  const frame = expansionFrame(expansion);
  if (rgba && rgba.length !== frame.width * frame.height * 4) throw new Error("Composition dimensions do not match the frame.");
  const coverage = new Uint8ClampedArray(frame.width * frame.height);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const px = x - expansion.left, py = y - expansion.top;
      const outside = px < 0 || py < 0 || px >= expansion.base.width || py >= expansion.base.height;
      // Feather only an edge that was expanded. Pixel centers make this symmetric.
      const distance = Math.min(expansion.left ? px + .5 : Infinity,
        expansion.right ? expansion.base.width - px - .5 : Infinity,
        expansion.top ? py + .5 : Infinity,
        expansion.bottom ? expansion.base.height - py - .5 : Infinity);
      const seam = expansion.transition ? Math.round(255 * Math.max(0, 1 - distance / expansion.transition)) : 0;
      const i = y * frame.width + x;
      coverage[i] = outside ? 255 : Math.max(seam, rgba ? 255 - rgba[i * 4 + 3]! : 0);
    }
  }
  return coverage;
}

/** Preserve manual changes in document coordinates while rebuilding the automatic border. */
export function reprojectCoverageEdits(nextBase: Uint8ClampedArray, nextFrame: TransformRect,
  previous: Uint8ClampedArray, previousFrame: TransformRect, previousBase?: Uint8ClampedArray): Uint8ClampedArray {
  validateTransformFrame(previousFrame);
  validateTransformFrame(nextFrame);
  if (previous.length !== previousFrame.width * previousFrame.height
    || (previousBase && previousBase.length !== previous.length)
    || nextBase.length !== nextFrame.width * nextFrame.height) throw new Error("Mask dimensions do not match its saved frame.");
  const next = nextBase.slice();
  for (let y = Math.max(nextFrame.y, previousFrame.y); y < Math.min(nextFrame.y + nextFrame.height, previousFrame.y + previousFrame.height); y++) {
    for (let x = Math.max(nextFrame.x, previousFrame.x); x < Math.min(nextFrame.x + nextFrame.width, previousFrame.x + previousFrame.width); x++) {
      const oldIndex = (y - previousFrame.y) * previousFrame.width + x - previousFrame.x;
      const index = (y - nextFrame.y) * nextFrame.width + x - nextFrame.x;
      if (previousBase) {
        if (previous[oldIndex] !== previousBase[oldIndex]) next[index] = previous[oldIndex]!;
      } else {
        // An ordinary imported mask contributes generation coverage in its original location.
        next[index] = Math.max(next[index]!, previous[oldIndex]!);
      }
    }
  }
  return next;
}
