import {
  createRasterPixelSampler,
  type RasterPixelSampler,
  RasterTileTransaction,
  pixelateRect,
  type RasterBounds,
  type RasterTileDiff,
} from "@/features/transform/rasterEngine";
import { recordRasterReadback } from "@/features/transform/rasterDiagnostics";

export type TransformRasterSelection = {
  bounds: RasterBounds;
  /** Full-canvas byte mask. Omitted for a solid rectangular selection. */
  mask?: Uint8Array | null;
};

function clippedBounds(
  bounds: RasterBounds,
  width: number,
  height: number,
): RasterBounds | null {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(width, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(height, Math.ceil(bounds.y + bounds.height));
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

function isSelected(
  selection: TransformRasterSelection,
  canvasWidth: number,
  x: number,
  y: number,
): boolean {
  return !selection.mask || selection.mask[y * canvasWidth + x] !== 0;
}

export function selectionFromMask(
  mask: Uint8Array,
  bounds: RasterBounds | null,
): TransformRasterSelection | null {
  return bounds && bounds.width > 0 && bounds.height > 0
    ? { bounds, mask }
    : null;
}

export function extractRasterSelection(
  context: CanvasRenderingContext2D,
  selection: TransformRasterSelection,
): HTMLCanvasElement | null {
  const bounds = clippedBounds(
    selection.bounds,
    context.canvas.width,
    context.canvas.height,
  );
  if (!bounds) {
    return null;
  }
  const imageData = context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
  if (selection.mask) {
    for (let localY = 0; localY < bounds.height; localY += 1) {
      for (let localX = 0; localX < bounds.width; localX += 1) {
        const sourceX = bounds.x + localX;
        const sourceY = bounds.y + localY;
        if (isSelected(selection, context.canvas.width, sourceX, sourceY)) {
          continue;
        }
        const offset = (localY * bounds.width + localX) * 4;
        imageData.data[offset] = 0;
        imageData.data[offset + 1] = 0;
        imageData.data[offset + 2] = 0;
        imageData.data[offset + 3] = 0;
      }
    }
  }
  const result = document.createElement("canvas");
  result.width = bounds.width;
  result.height = bounds.height;
  result.getContext("2d")?.putImageData(imageData, 0, 0);
  return result;
}

export function deleteRasterSelection(
  context: CanvasRenderingContext2D,
  selection: TransformRasterSelection,
  transaction?: RasterTileTransaction | null,
): void {
  const bounds = clippedBounds(
    selection.bounds,
    context.canvas.width,
    context.canvas.height,
  );
  if (!bounds) {
    return;
  }
  transaction?.touch(bounds);
  const imageData = context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
  for (let localY = 0; localY < bounds.height; localY += 1) {
    for (let localX = 0; localX < bounds.width; localX += 1) {
      const sourceX = bounds.x + localX;
      const sourceY = bounds.y + localY;
      if (!isSelected(selection, context.canvas.width, sourceX, sourceY)) {
        continue;
      }
      const offset = (localY * bounds.width + localX) * 4;
      imageData.data[offset] = 0;
      imageData.data[offset + 1] = 0;
      imageData.data[offset + 2] = 0;
      imageData.data[offset + 3] = 0;
    }
  }
  context.putImageData(imageData, bounds.x, bounds.y);
}

export function moveRasterSelection(
  context: CanvasRenderingContext2D,
  selection: TransformRasterSelection,
  deltaX: number,
  deltaY: number,
  transaction?: RasterTileTransaction | null,
): TransformRasterSelection | null {
  const dx = Math.round(deltaX);
  const dy = Math.round(deltaY);
  if (!dx && !dy) {
    return selection;
  }
  const sourceBounds = clippedBounds(
    selection.bounds,
    context.canvas.width,
    context.canvas.height,
  );
  if (!sourceBounds) {
    return null;
  }
  const extracted = extractRasterSelection(context, selection);
  if (!extracted) {
    return null;
  }
  const targetBounds = clippedBounds(
    {
      x: sourceBounds.x + dx,
      y: sourceBounds.y + dy,
      width: sourceBounds.width,
      height: sourceBounds.height,
    },
    context.canvas.width,
    context.canvas.height,
  );
  transaction?.touch(sourceBounds);
  if (targetBounds) {
    transaction?.touch(targetBounds);
  }
  deleteRasterSelection(context, selection);
  context.drawImage(extracted, sourceBounds.x + dx, sourceBounds.y + dy);

  const movedMask = selection.mask
    ? new Uint8Array(context.canvas.width * context.canvas.height)
    : null;
  if (movedMask && selection.mask) {
    for (let y = sourceBounds.y; y < sourceBounds.y + sourceBounds.height; y += 1) {
      for (let x = sourceBounds.x; x < sourceBounds.x + sourceBounds.width; x += 1) {
        if (!selection.mask[y * context.canvas.width + x]) {
          continue;
        }
        const targetX = x + dx;
        const targetY = y + dy;
        if (
          targetX >= 0 &&
          targetY >= 0 &&
          targetX < context.canvas.width &&
          targetY < context.canvas.height
        ) {
          movedMask[targetY * context.canvas.width + targetX] = 255;
        }
      }
    }
  }
  return targetBounds
    ? {
      bounds: targetBounds,
      mask: movedMask,
    }
    : null;
}

export function pixelateRasterSelection(
  target: CanvasRenderingContext2D,
  source: CanvasRenderingContext2D,
  selection: TransformRasterSelection,
  blockSizePx: number,
  transaction?: RasterTileTransaction | null,
): void {
  if (!selection.mask) {
    pixelateRect(target, source, selection.bounds, blockSizePx, transaction);
    return;
  }
  const bounds = clippedBounds(
    selection.bounds,
    target.canvas.width,
    target.canvas.height,
  );
  if (!bounds) {
    return;
  }
  const targetData = target.getImageData(bounds.x, bounds.y, bounds.width, bounds.height);
  recordRasterReadback(bounds.width, bounds.height);
  transaction?.touch(bounds);
  const sampler: RasterPixelSampler = createRasterPixelSampler(source);
  const blockSize = Math.max(2, Math.round(blockSizePx));
  const firstBlock = {
    x: Math.floor(bounds.x / blockSize) * blockSize,
    y: Math.floor(bounds.y / blockSize) * blockSize,
  };
  for (let blockY = firstBlock.y; blockY < bounds.y + bounds.height; blockY += blockSize) {
    for (let blockX = firstBlock.x; blockX < bounds.x + bounds.width; blockX += blockSize) {
      const [red, green, blue, alpha] = sampler.sampleBlock(
        blockX,
        blockY,
        blockSize,
        blockSize,
      );
      const sourceAlpha = alpha / 255;
      for (let y = Math.max(bounds.y, blockY); y < Math.min(bounds.y + bounds.height, blockY + blockSize); y += 1) {
        for (let x = Math.max(bounds.x, blockX); x < Math.min(bounds.x + bounds.width, blockX + blockSize); x += 1) {
          if (!selection.mask[y * target.canvas.width + x]) {
            continue;
          }
          const offset = ((y - bounds.y) * bounds.width + x - bounds.x) * 4;
          const destinationAlpha = targetData.data[offset + 3] / 255;
          const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
          if (outputAlpha <= 0) {
            targetData.data[offset] = 0;
            targetData.data[offset + 1] = 0;
            targetData.data[offset + 2] = 0;
            targetData.data[offset + 3] = 0;
            continue;
          }
          targetData.data[offset] = Math.round((red * sourceAlpha + targetData.data[offset] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
          targetData.data[offset + 1] = Math.round((green * sourceAlpha + targetData.data[offset + 1] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
          targetData.data[offset + 2] = Math.round((blue * sourceAlpha + targetData.data[offset + 2] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
          targetData.data[offset + 3] = Math.round(outputAlpha * 255);
        }
      }
    }
  }
  target.putImageData(targetData, bounds.x, bounds.y);
}

export function commitRasterSelectionTransaction(
  transaction: RasterTileTransaction,
): RasterTileDiff | null {
  return transaction.commit();
}
