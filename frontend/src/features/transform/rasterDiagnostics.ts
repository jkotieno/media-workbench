export type RasterDiagnosticsSnapshot = {
  rawPointerSamples: number;
  emittedDabs: number;
  pixelateBlocks: number;
  getImageDataCalls: number;
  getImageDataBytes: number;
  touchedHistoryTiles: number;
  smudgeScratchAllocations: number;
  largeCanvasAllocations: number;
  fullSurfaceDraws: number;
  rasterTimeMs: number;
  previewTimeMs: number;
  pointerDownToFirstDabMs: number | null;
};

type RasterDiagnosticsCounters = RasterDiagnosticsSnapshot;

const counters: RasterDiagnosticsCounters = {
  rawPointerSamples: 0,
  emittedDabs: 0,
  pixelateBlocks: 0,
  getImageDataCalls: 0,
  getImageDataBytes: 0,
  touchedHistoryTiles: 0,
  smudgeScratchAllocations: 0,
  largeCanvasAllocations: 0,
  fullSurfaceDraws: 0,
  rasterTimeMs: 0,
  previewTimeMs: 0,
  pointerDownToFirstDabMs: null,
};

export function resetRasterDiagnostics(): void {
  counters.rawPointerSamples = 0;
  counters.emittedDabs = 0;
  counters.pixelateBlocks = 0;
  counters.getImageDataCalls = 0;
  counters.getImageDataBytes = 0;
  counters.touchedHistoryTiles = 0;
  counters.smudgeScratchAllocations = 0;
  counters.largeCanvasAllocations = 0;
  counters.fullSurfaceDraws = 0;
  counters.rasterTimeMs = 0;
  counters.previewTimeMs = 0;
  counters.pointerDownToFirstDabMs = null;
}

export function getRasterDiagnostics(): RasterDiagnosticsSnapshot {
  return { ...counters };
}

export function recordRasterDiagnostics(
  update: Partial<RasterDiagnosticsSnapshot>,
): void {
  for (const [key, value] of Object.entries(update) as Array<[
    keyof RasterDiagnosticsSnapshot,
    number | null | undefined,
  ]>) {
    if (typeof value !== "number") {
      continue;
    }
    if (key === "pointerDownToFirstDabMs") {
      counters[key] = value;
    } else {
      counters[key] += value;
    }
  }
}

export function recordRasterReadback(width: number, height: number): void {
  recordRasterDiagnostics({
    getImageDataCalls: 1,
    getImageDataBytes: Math.max(0, Math.floor(width)) * Math.max(0, Math.floor(height)) * 4,
  });
}

export function recordFirstDabLatency(pointerDownAt: number): void {
  const timestamp = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (counters.pointerDownToFirstDabMs == null) {
    counters.pointerDownToFirstDabMs = Math.max(0, timestamp - pointerDownAt);
  }
}
