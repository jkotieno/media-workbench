import type { TransformPaintedPixels } from "@/shared/types";

export function normalizeMaskDraftPixels(
  bytes: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const coverage = new Uint8ClampedArray(width * height);
  let nonOpaque = 0;
  let grayscale = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    if (bytes[index + 3] < 250) {
      nonOpaque += 1;
    }
    if (
      Math.abs(bytes[index] - bytes[index + 1]) <= 3 &&
      Math.abs(bytes[index + 1] - bytes[index + 2]) <= 3
    ) {
      grayscale += 1;
    }
  }
  const pixelCount = Math.max(1, width * height);
  const alphaCarriesCoverage = nonOpaque / pixelCount > 0.001;
  const grayscaleCarriesCoverage = grayscale / pixelCount > 0.98;
  for (let index = 0; index < coverage.length; index += 1) {
    const rgbaIndex = index * 4;
    if (alphaCarriesCoverage) {
      coverage[index] = bytes[rgbaIndex + 3];
    } else if (grayscaleCarriesCoverage) {
      coverage[index] = Math.round(
        bytes[rgbaIndex] * 0.2126 +
        bytes[rgbaIndex + 1] * 0.7152 +
        bytes[rgbaIndex + 2] * 0.0722,
      );
    } else {
      // Legacy checker drafts were opaque wherever coverage existed.
      const luminance =
        bytes[rgbaIndex] * 0.2126 +
        bytes[rgbaIndex + 1] * 0.7152 +
        bytes[rgbaIndex + 2] * 0.0722;
      coverage[index] = luminance < 248 ? 255 : 0;
    }
  }
  return coverage;
}

export function coverageToOutputBytes(
  coverage: Uint8ClampedArray,
  paintedPixels: TransformPaintedPixels,
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(coverage.length);
  for (let index = 0; index < coverage.length; index += 1) {
    output[index] = paintedPixels === "white" ? coverage[index] : 255 - coverage[index];
  }
  return output;
}

export function coverageToOpaqueRgbaBytes(
  coverage: Uint8ClampedArray,
  paintedPixels: TransformPaintedPixels,
): Uint8ClampedArray {
  const output = coverageToOutputBytes(coverage, paintedPixels);
  const rgba = new Uint8ClampedArray(output.length * 4);
  for (let index = 0; index < output.length; index += 1) {
    const offset = index * 4;
    rgba[offset] = output[index];
    rgba[offset + 1] = output[index];
    rgba[offset + 2] = output[index];
    rgba[offset + 3] = 255;
  }
  return rgba;
}
