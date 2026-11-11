import { clamp } from "@/features/transform/transformCanvasUtils";
import {
  recordRasterDiagnostics,
  recordRasterReadback,
} from "@/features/transform/rasterDiagnostics";

export type RasterPoint = {
  x: number;
  y: number;
  pressure?: number;
};

export type RasterBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RasterTilePatch = RasterBounds & {
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
};

export type RasterTileDiff = {
  layerId: string;
  tileSize: number;
  patches: RasterTilePatch[];
  byteLength: number;
};

const DEFAULT_TILE_SIZE = 128;

function intersectBounds(
  bounds: RasterBounds,
  width: number,
  height: number,
): RasterBounds | null {
  const x = clamp(Math.floor(bounds.x), 0, width);
  const y = clamp(Math.floor(bounds.y), 0, height);
  const right = clamp(Math.ceil(bounds.x + bounds.width), 0, width);
  const bottom = clamp(Math.ceil(bounds.y + bounds.height), 0, height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

export class RasterTileTransaction {
  readonly layerId: string;
  readonly tileSize: number;
  private context: CanvasRenderingContext2D;
  private beforeTiles = new Map<string, { bounds: RasterBounds; data: Uint8ClampedArray }>();
  private pendingDirtyBounds: RasterBounds | null = null;

  constructor(
    layerId: string,
    context: CanvasRenderingContext2D,
    tileSize = DEFAULT_TILE_SIZE,
  ) {
    this.layerId = layerId;
    this.context = context;
    this.tileSize = Math.max(32, Math.floor(tileSize));
  }

  touch(bounds: RasterBounds): void {
    const clipped = intersectBounds(
      bounds,
      this.context.canvas.width,
      this.context.canvas.height,
    );
    if (!clipped) {
      return;
    }
    if (this.pendingDirtyBounds) {
      const minX = Math.min(this.pendingDirtyBounds.x, clipped.x);
      const minY = Math.min(this.pendingDirtyBounds.y, clipped.y);
      const maxX = Math.max(
        this.pendingDirtyBounds.x + this.pendingDirtyBounds.width,
        clipped.x + clipped.width,
      );
      const maxY = Math.max(
        this.pendingDirtyBounds.y + this.pendingDirtyBounds.height,
        clipped.y + clipped.height,
      );
      this.pendingDirtyBounds = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    } else {
      this.pendingDirtyBounds = { ...clipped };
    }
    const firstTileX = Math.floor(clipped.x / this.tileSize);
    const firstTileY = Math.floor(clipped.y / this.tileSize);
    const lastTileX = Math.floor((clipped.x + clipped.width - 1) / this.tileSize);
    const lastTileY = Math.floor((clipped.y + clipped.height - 1) / this.tileSize);
    for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
      for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
        const key = `${tileX}:${tileY}`;
        if (this.beforeTiles.has(key)) {
          continue;
        }
        const x = tileX * this.tileSize;
        const y = tileY * this.tileSize;
        const width = Math.min(this.tileSize, this.context.canvas.width - x);
        const height = Math.min(this.tileSize, this.context.canvas.height - y);
        const imageData = this.context.getImageData(x, y, width, height);
        recordRasterReadback(width, height);
        recordRasterDiagnostics({ touchedHistoryTiles: 1 });
        this.beforeTiles.set(key, {
          bounds: { x, y, width, height },
          data: new Uint8ClampedArray(imageData.data),
        });
      }
    }
  }

  consumeDirtyBounds(): RasterBounds | null {
    const bounds = this.pendingDirtyBounds;
    this.pendingDirtyBounds = null;
    return bounds;
  }

  commit(): RasterTileDiff | null {
    if (!this.beforeTiles.size) {
      return null;
    }
    const patches: RasterTilePatch[] = [];
    let byteLength = 0;
    for (const { bounds, data: before } of this.beforeTiles.values()) {
      const after = new Uint8ClampedArray(
        this.context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height).data,
      );
      recordRasterReadback(bounds.width, bounds.height);
      let changed = false;
      for (let index = 0; index < before.length; index += 1) {
        if (before[index] !== after[index]) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        continue;
      }
      patches.push({ ...bounds, before, after });
      byteLength += before.byteLength + after.byteLength;
    }
    return patches.length
      ? {
        layerId: this.layerId,
        tileSize: this.tileSize,
        patches,
        byteLength,
      }
      : null;
  }
}

export function applyRasterTileDiff(
  context: CanvasRenderingContext2D,
  diff: RasterTileDiff,
  side: "before" | "after",
): void {
  for (const patch of diff.patches) {
    const bytes = side === "before" ? patch.before : patch.after;
    context.putImageData(
      new ImageData(new Uint8ClampedArray(bytes), patch.width, patch.height),
      patch.x,
      patch.y,
    );
  }
}

export type BrushDabOptions = {
  sizePx: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  color: string;
  compositeOperation?: GlobalCompositeOperation;
  pressureSize?: boolean;
  pressureOpacity?: boolean;
};

function drawSoftDab(
  context: CanvasRenderingContext2D,
  point: RasterPoint,
  options: BrushDabOptions,
): RasterBounds {
  const pressure = clamp(
    typeof point.pressure === "number" && point.pressure > 0 ? point.pressure : 1,
    0.05,
    1,
  );
  const size = Math.max(1, options.sizePx * (options.pressureSize ? pressure : 1));
  const radius = size / 2;
  const opacity =
    clamp(options.opacity, 0, 1) *
    clamp(options.flow, 0, 1) *
    (options.pressureOpacity ? pressure : 1);
  const hardness = clamp(options.hardness, 0, 1);

  context.save();
  context.globalCompositeOperation = options.compositeOperation ?? "source-over";
  context.globalAlpha = opacity;
  if (hardness >= 0.995 || radius <= 0.75) {
    context.fillStyle = options.color;
  } else {
    const gradient = context.createRadialGradient(
      point.x,
      point.y,
      radius * hardness,
      point.x,
      point.y,
      radius,
    );
    gradient.addColorStop(0, options.color);
    gradient.addColorStop(Math.max(hardness, 0.001), options.color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
  }
  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();
  context.restore();
  return {
    x: point.x - radius - 2,
    y: point.y - radius - 2,
    width: size + 4,
    height: size + 4,
  };
}

function interpolatePoints(
  from: RasterPoint,
  to: RasterPoint,
  distanceStep: number,
): RasterPoint[] {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const distance = Math.hypot(deltaX, deltaY);
  const steps = Math.max(1, Math.ceil(distance / Math.max(distanceStep, 0.5)));
  const result: RasterPoint[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    result.push({
      x: from.x + deltaX * ratio,
      y: from.y + deltaY * ratio,
      pressure:
        (from.pressure ?? 1) + ((to.pressure ?? 1) - (from.pressure ?? 1)) * ratio,
    });
  }
  return result;
}

export function drawBrushSegment(
  context: CanvasRenderingContext2D,
  from: RasterPoint,
  to: RasterPoint,
  options: BrushDabOptions,
  transaction?: RasterTileTransaction | null,
): void {
  const spacingPx = Math.max(0.5, options.sizePx * clamp(options.spacing, 0.02, 2));
  for (const point of interpolatePoints(from, to, spacingPx)) {
    drawBrushDab(context, point, options, transaction);
  }
}

export function drawBrushDab(
  context: CanvasRenderingContext2D,
  point: RasterPoint,
  options: BrushDabOptions,
  transaction?: RasterTileTransaction | null,
): void {
  const pressure = options.pressureSize ? point.pressure ?? 1 : 1;
  const size = Math.max(1, options.sizePx * pressure);
  transaction?.touch({
    x: point.x - size / 2 - 3,
    y: point.y - size / 2 - 3,
    width: size + 6,
    height: size + 6,
  });
  drawSoftDab(context, point, options);
}

export type RasterPixelSampler = {
  width: number;
  height: number;
  sampleBlock: (x: number, y: number, width: number, height: number) => [number, number, number, number];
};

type RasterSourceTile = {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/**
 * A stroke-scoped source snapshot. Each 256px tile is read once and then all
 * Pixelate blocks use the cached bytes, preserving source anchoring without a
 * full-image RGBA allocation.
 */
export class LazyTiledRasterSampler implements RasterPixelSampler {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  private readonly source: CanvasRenderingContext2D;
  private readonly tiles = new Map<string, RasterSourceTile>();

  constructor(
    source: CanvasRenderingContext2D,
    tileSize = 256,
  ) {
    this.source = source;
    this.width = source.canvas.width;
    this.height = source.canvas.height;
    this.tileSize = Math.max(32, Math.floor(tileSize));
  }

  private getTile(tileX: number, tileY: number): RasterSourceTile | null {
    const key = `${tileX}:${tileY}`;
    const cached = this.tiles.get(key);
    if (cached) {
      return cached;
    }
    const x = tileX * this.tileSize;
    const y = tileY * this.tileSize;
    const width = Math.min(this.tileSize, this.width - x);
    const height = Math.min(this.tileSize, this.height - y);
    if (width <= 0 || height <= 0) {
      return null;
    }
    const data = this.source.getImageData(x, y, width, height).data;
    recordRasterReadback(width, height);
    const tile = { x, y, width, height, data: new Uint8ClampedArray(data) };
    this.tiles.set(key, tile);
    return tile;
  }

  sampleBlock(
    x: number,
    y: number,
    width: number,
    height: number,
  ): [number, number, number, number] {
    const clipped = intersectBounds({ x, y, width, height }, this.width, this.height);
    if (!clipped) {
      return [0, 0, 0, 0];
    }
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    for (let sourceY = clipped.y; sourceY < clipped.y + clipped.height; sourceY += 1) {
      for (let sourceX = clipped.x; sourceX < clipped.x + clipped.width; sourceX += 1) {
        const tile = this.getTile(
          Math.floor(sourceX / this.tileSize),
          Math.floor(sourceY / this.tileSize),
        );
        if (!tile) {
          continue;
        }
        const offset = ((sourceY - tile.y) * tile.width + sourceX - tile.x) * 4;
        red += tile.data[offset];
        green += tile.data[offset + 1];
        blue += tile.data[offset + 2];
        alpha += tile.data[offset + 3];
      }
    }
    const pixelCount = Math.max(1, clipped.width * clipped.height);
    return [
      Math.round(red / pixelCount),
      Math.round(green / pixelCount),
      Math.round(blue / pixelCount),
      Math.round(alpha / pixelCount),
    ];
  }
}

export function createRasterPixelSampler(
  source: CanvasRenderingContext2D,
  tileSize = 256,
): LazyTiledRasterSampler {
  return new LazyTiledRasterSampler(source, tileSize);
}

function resolvePixelSampler(
  source: CanvasRenderingContext2D | RasterPixelSampler,
): RasterPixelSampler {
  return "sampleBlock" in source
    ? source
    : createRasterPixelSampler(source);
}

export type PixelateDabOptions = {
  brushSizePx: number;
  blockSizePx: number;
  footprint: "round" | "square";
  featherPx: number;
  visitedBlocks?: Set<string>;
  sampler?: RasterPixelSampler;
};

export function getPixelateFeatherBlend(
  distanceToEdge: number,
  featherPx: number,
): number {
  if (featherPx <= 0) {
    return 1;
  }
  const normalized = clamp(distanceToEdge / Math.max(0.001, featherPx), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

export function getSourceAnchoredPixelBlock(
  x: number,
  y: number,
  blockSizePx: number,
): RasterBounds {
  const blockSize = Math.max(2, Math.round(blockSizePx));
  return {
    x: Math.floor(x / blockSize) * blockSize,
    y: Math.floor(y / blockSize) * blockSize,
    width: blockSize,
    height: blockSize,
  };
}

export function drawPixelateDab(
  target: CanvasRenderingContext2D,
  source: CanvasRenderingContext2D | RasterPixelSampler,
  point: RasterPoint,
  options: PixelateDabOptions,
  transaction?: RasterTileTransaction | null,
): void {
  const sampler = options.sampler ?? resolvePixelSampler(source);
  const blockSize = Math.max(2, Math.round(options.blockSizePx));
  const radius = Math.max(blockSize / 2, options.brushSizePx / 2);
  const firstBlock = getSourceAnchoredPixelBlock(
    point.x - radius,
    point.y - radius,
    blockSize,
  );
  const lastBlock = getSourceAnchoredPixelBlock(
    point.x + radius,
    point.y + radius,
    blockSize,
  );
  const firstX = firstBlock.x;
  const firstY = firstBlock.y;
  const lastX = lastBlock.x;
  const lastY = lastBlock.y;
  for (let y = firstY; y <= lastY; y += blockSize) {
    for (let x = firstX; x <= lastX; x += blockSize) {
      const centerX = x + blockSize / 2;
      const centerY = y + blockSize / 2;
      if (
        options.footprint === "round" &&
        Math.hypot(centerX - point.x, centerY - point.y) > radius
      ) {
        continue;
      }
      const key = `${x}:${y}:${blockSize}`;
      if (options.visitedBlocks?.has(key)) {
        continue;
      }
      options.visitedBlocks?.add(key);
      transaction?.touch({ x, y, width: blockSize, height: blockSize });
      recordRasterDiagnostics({ pixelateBlocks: 1 });
      const [red, green, blue, alpha] = sampler.sampleBlock(
        x,
        y,
        blockSize,
        blockSize,
      );
      const edgeDistance = options.footprint === "round"
        ? radius - Math.hypot(centerX - point.x, centerY - point.y)
        : radius - Math.max(Math.abs(centerX - point.x), Math.abs(centerY - point.y));
      const blend = getPixelateFeatherBlend(edgeDistance, options.featherPx);
      target.save();
      target.globalAlpha = blend;
      target.fillStyle = `rgba(${red},${green},${blue},${alpha / 255})`;
      target.fillRect(x, y, blockSize, blockSize);
      target.restore();
    }
  }
}

export function drawPixelateSegment(
  target: CanvasRenderingContext2D,
  source: CanvasRenderingContext2D | RasterPixelSampler,
  from: RasterPoint,
  to: RasterPoint,
  options: PixelateDabOptions,
  transaction?: RasterTileTransaction | null,
): void {
  const spacing = Math.max(2, options.brushSizePx * 0.22);
  for (const point of interpolatePoints(from, to, spacing)) {
    drawPixelateDab(target, source, point, options, transaction);
  }
}

export function pixelateRect(
  target: CanvasRenderingContext2D,
  source: CanvasRenderingContext2D | RasterPixelSampler,
  bounds: RasterBounds,
  blockSizePx: number,
  transaction?: RasterTileTransaction | null,
): void {
  const clipped = intersectBounds(bounds, target.canvas.width, target.canvas.height);
  if (!clipped) {
    return;
  }
  transaction?.touch(clipped);
  const blockSize = Math.max(2, Math.round(blockSizePx));
  const sampler = resolvePixelSampler(source);
  const firstBlock = getSourceAnchoredPixelBlock(
    clipped.x,
    clipped.y,
    blockSize,
  );
  const firstX = firstBlock.x;
  const firstY = firstBlock.y;
  const right = clipped.x + clipped.width;
  const bottom = clipped.y + clipped.height;
  target.save();
  target.beginPath();
  target.rect(clipped.x, clipped.y, clipped.width, clipped.height);
  target.clip();
  for (let y = firstY; y < bottom; y += blockSize) {
    for (let x = firstX; x < right; x += blockSize) {
      recordRasterDiagnostics({ pixelateBlocks: 1 });
      const [red, green, blue, alpha] = sampler.sampleBlock(
        x,
        y,
        blockSize,
        blockSize,
      );
      target.fillStyle = `rgba(${red},${green},${blue},${alpha / 255})`;
      target.fillRect(x, y, blockSize, blockSize);
    }
  }
  target.restore();
}

export type SmudgeState = {
  patch: HTMLCanvasElement;
  dabCanvas: HTMLCanvasElement;
  maskCanvas: HTMLCanvasElement;
  sizePx: number;
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  recordRasterDiagnostics({
    smudgeScratchAllocations: 1,
    largeCanvasAllocations: width * height >= 1024 * 1024 ? 1 : 0,
  });
  return canvas;
}

function capturePatch(
  source: CanvasRenderingContext2D,
  point: RasterPoint,
  sizePx: number,
  patch = createCanvas(Math.max(2, Math.round(sizePx)), Math.max(2, Math.round(sizePx))),
): HTMLCanvasElement {
  const size = Math.max(2, Math.round(sizePx));
  if (patch.width !== size || patch.height !== size) {
    patch.width = size;
    patch.height = size;
  }
  const patchContext = patch.getContext("2d");
  patchContext?.drawImage(
    source.canvas,
    point.x - size / 2,
    point.y - size / 2,
    size,
    size,
    0,
    0,
    size,
    size,
  );
  return patch;
}

export function createSmudgeState(
  source: CanvasRenderingContext2D,
  point: RasterPoint,
  sizePx: number,
  hardness = 0.5,
  strength = 1,
): SmudgeState {
  const size = Math.max(2, Math.round(sizePx));
  const patch = capturePatch(source, point, size);
  const dabCanvas = createCanvas(size, size);
  const maskCanvas = createCanvas(size, size);
  const maskContext = maskCanvas.getContext("2d");
  if (maskContext) {
    const maskData = maskContext.createImageData(size, size);
    const radius = size / 2;
    const maskHardness = clamp(hardness, 0, 1);
    const maskStrength = clamp(strength, 0.01, 1);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const distanceFromCenter = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
        const normalized = distanceFromCenter / Math.max(1, radius);
        const weight = normalized <= maskHardness
          ? 1
          : clamp(1 - (normalized - maskHardness) / Math.max(0.001, 1 - maskHardness), 0, 1);
        const offset = (y * size + x) * 4;
        maskData.data[offset] = 255;
        maskData.data[offset + 1] = 255;
        maskData.data[offset + 2] = 255;
        maskData.data[offset + 3] = Math.round(weight * maskStrength * 255);
      }
    }
    maskContext.putImageData(maskData, 0, 0);
  }
  return {
    patch,
    dabCanvas,
    maskCanvas,
    sizePx: size,
  };
}

export type SmudgeOptions = {
  sizePx: number;
  hardness: number;
  strength: number;
};

export function drawSmudgeSegment(
  target: CanvasRenderingContext2D,
  source: CanvasRenderingContext2D,
  state: SmudgeState,
  from: RasterPoint,
  to: RasterPoint,
  options: SmudgeOptions,
  transaction?: RasterTileTransaction | null,
): void {
  const size = Math.max(2, options.sizePx);
  const spacing = Math.max(1, size * 0.12);
  for (const point of interpolatePoints(from, to, spacing)) {
    drawSmudgeDab(target, source, state, point, options, transaction);
  }
}

export function drawSmudgeDab(
  target: CanvasRenderingContext2D,
  source: CanvasRenderingContext2D,
  state: SmudgeState,
  point: RasterPoint,
  options: SmudgeOptions,
  transaction?: RasterTileTransaction | null,
): void {
  const size = Math.max(2, options.sizePx);
  const radius = size / 2;
  const strength = clamp(options.strength, 0.01, 1);
  transaction?.touch({
    x: point.x - radius - 2,
    y: point.y - radius - 2,
    width: size + 4,
    height: size + 4,
  });

  const dabContext = state.dabCanvas.getContext("2d");
  if (!dabContext) {
    return;
  }
  dabContext.setTransform(1, 0, 0, 1, 0, 0);
  dabContext.globalAlpha = 1;
  dabContext.globalCompositeOperation = "source-over";
  dabContext.clearRect(0, 0, state.dabCanvas.width, state.dabCanvas.height);
  dabContext.drawImage(state.patch, 0, 0);
  dabContext.globalCompositeOperation = "destination-in";
  dabContext.globalAlpha = 1;
  dabContext.drawImage(state.maskCanvas, 0, 0);
  dabContext.globalAlpha = 1;
  dabContext.globalCompositeOperation = "source-over";
  target.drawImage(state.dabCanvas, point.x - radius, point.y - radius, size, size);

  const patchContext = state.patch.getContext("2d");
  if (patchContext) {
    patchContext.setTransform(1, 0, 0, 1, 0, 0);
    patchContext.globalCompositeOperation = "source-over";
    patchContext.globalAlpha = clamp(0.12 + (1 - strength) * 0.22, 0.08, 0.34);
    patchContext.drawImage(
      source.canvas,
      point.x - size / 2,
      point.y - size / 2,
      size,
      size,
      0,
      0,
      state.patch.width,
      state.patch.height,
    );
    patchContext.globalAlpha = 1;
  }
}

export function boundsFromPoints(
  start: RasterPoint,
  end: RasterPoint,
): RasterBounds {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
