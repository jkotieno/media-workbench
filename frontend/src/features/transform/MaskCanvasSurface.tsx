import { useTransformOperationScope } from "./useTransformOperationScope";
import { expansionCoverage, expansionFrame, reprojectCoverageEdits } from "./expansion";
import type { TransformExpansion, TransformRect } from "@/shared/types";
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getBasename } from "@/lib/pathUtils";
import { API_BASE } from "@/shared/api/client";
import { clamp } from "@/features/transform/transformCanvasUtils";
import {
  coverageToOpaqueRgbaBytes,
  normalizeMaskDraftPixels,
} from "@/features/transform/maskCoverage";
import {
  MASK_APPLY_READY_EVENT,
  MASK_APPLY_REQUEST_EVENT,
  type MaskApplyReadyDetail,
  type MaskApplyRequestDetail,
} from "@/features/transform/maskApplyBridge";
import {
  createMaskPreviewRenderer,
  type MaskPreviewRenderer,
} from "@/features/transform/maskPreviewRenderer";
import { boundsFromPoints, type RasterBounds, type RasterPoint } from "@/features/transform/rasterEngine";
import {
  StrokeResampler,
  StrokeWorkQueue,
  STROKE_WORK_BUDGET_MS,
  STROKE_WORK_MAX_DABS,
  type StrokeSample,
} from "@/features/transform/strokeInput";
import {
  runFloodFill,
  runMaskFeather,
  runMaskMorph,
} from "@/features/transform/rasterWorkerClient";
import type {
  TransformMaskState,
  TransformMaskTool,
  TransformMaskViewMode,
  TransformPaintedPixels,
} from "@/shared/types";

export type MaskTool = TransformMaskTool;
export type MaskShapeOperation = "add" | "subtract";
export type MaskDraftState = "saved" | "dirty" | "saving" | "error";

export type MaskCanvasSurfaceState = {
  tool: MaskTool;
  shapeOperation: MaskShapeOperation;
  brushSize: number;
  hardness: number;
  strength: number;
  feather: number;
  smoothing: number;
  fillTolerance: number;
  paintedPixels: TransformPaintedPixels;
  viewMode: TransformMaskViewMode;
  overlayColor: string;
  overlayOpacity: number;
  filename: string;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  isBusy: boolean;
  isReady: boolean;
  hasCoverage: boolean;
  historyBytes: number;
  draftState: MaskDraftState;
};

export type MaskCanvasSurfaceHandle = {
  undo: () => void;
  redo: () => void;
  clear: () => void;
  fillAll: () => void;
  invertCoverage: () => void;
  featherCoverage: (radius: number) => Promise<void>;
  growCoverage: (radius: number) => Promise<void>;
  shrinkCoverage: (radius: number) => Promise<void>;
  save: () => Promise<void>;
  flushDraft: () => Promise<void>;
  getCoverageFile: () => Promise<File>;
  getOutputPreviewDataUrl: (maxDimension?: number) => string | null;
  setTool: (tool: MaskTool) => void;
  setShapeOperation: (operation: MaskShapeOperation) => void;
  setBrushSize: (size: number) => void;
  setHardness: (value: number) => void;
  setStrength: (value: number) => void;
  setFeather: (value: number) => void;
  setSmoothing: (value: number) => void;
  setFillTolerance: (value: number) => void;
  setPaintedPixels: (value: TransformPaintedPixels) => void;
  setViewMode: (value: TransformMaskViewMode) => void;
  setOverlayColor: (value: string) => void;
  setOverlayOpacity: (value: number) => void;
  setFilename: (filename: string) => void;
};

type MaskCanvasSurfaceProps = {
  active: boolean;
  imageUrl: string;
  draftImageUrl?: string | null;
  compositionCanvas?: HTMLCanvasElement | null;
  expansion?: TransformExpansion | null;
  baseDraftImageUrl?: string | null;
  coverageFrame?: TransformRect | null;
  sourceWidth: number;
  sourceHeight: number;
  initialState: TransformMaskState;
  spacePressed?: boolean;
  onBeginPan?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onFit?: () => void;
  onSave: (maskFile: File) => Promise<void>;
  onDraftChange?: (draftFile: File | null, baseFile?: File | null) => Promise<void> | void;
  onSettingsChange?: (state: TransformMaskState) => void;
  onStateChange?: (state: MaskCanvasSurfaceState) => void;
};

type CoverageTilePatch = RasterBounds & {
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
};

type CoverageHistoryEntry = {
  label: string;
  patches: CoverageTilePatch[];
  byteLength: number;
};

type CoverageHistory = {
  entries: CoverageHistoryEntry[];
  index: number;
  bytes: number;
};

type OutputPreviewCache = {
  key: string;
  dataUrl: string;
};

type CoverageGesture = {
  tool: Exclude<MaskTool, "pan" | "fill">;
  pointerId: number;
  operation: MaskShapeOperation;
  start: RasterPoint;
  last: RasterPoint;
  points: RasterPoint[];
  transaction: CoverageTileTransaction;
  strokeQueue: StrokeWorkQueue;
  strokeResampler: StrokeResampler;
  strokeDrainFrame: number | null;
  finalizing: boolean;
  historyCommitted: boolean;
};

const TILE_SIZE = 128;
const HISTORY_BYTE_LIMIT = 96 * 1024 * 1024;
const DRAFT_DEBOUNCE_MS = 650;

function clampBrushSize(value: number): number {
  return Math.round(clamp(Number.isFinite(value) ? value : 64, 1, 1024));
}

function buildDefaultFilename(imageUrl: string): string {
  let base = "image";
  try {
    if (imageUrl.includes("?path=")) {
      const url = new URL(imageUrl, window.location.origin);
      base = getBasename(url.searchParams.get("path") || "", base);
    } else {
      base = getBasename(imageUrl, base);
    }
  } catch {
    base = "image";
  }
  base = base.replace(/\.(png|jpg|jpeg|webp|gif|bmp|tif|tiff)$/i, "") || "image";
  return `${base}_mask.png`;
}

function buildMaskSourceUrl(imageUrl: string, view: "opaque" | "coverage"): string {
  let path = imageUrl;
  let version: string | null = null;
  try {
    const parsed = new URL(imageUrl, window.location.origin);
    path = parsed.searchParams.get("path") || imageUrl;
    version = parsed.searchParams.get("v");
  } catch {
    path = imageUrl;
  }
  const params = new URLSearchParams({ path, view });
  if (version) {
    params.set("v", version);
  }
  return `${API_BASE}/transform/mask-source?${params.toString()}`;
}

function parseHexColor(value: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : "#16b8d4";
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function clipBounds(bounds: RasterBounds, width: number, height: number): RasterBounds | null {
  const x = clamp(Math.floor(bounds.x), 0, width);
  const y = clamp(Math.floor(bounds.y), 0, height);
  const right = clamp(Math.ceil(bounds.x + bounds.width), 0, width);
  const bottom = clamp(Math.ceil(bounds.y + bounds.height), 0, height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

function unionBounds(
  first: RasterBounds | null,
  second: RasterBounds | null,
): RasterBounds | null {
  if (!first) {
    return second ? { ...second } : null;
  }
  if (!second) {
    return first;
  }
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
  };
}

class CoverageTileTransaction {
  private coverage: Uint8ClampedArray;
  private width: number;
  private height: number;
  private before = new Map<string, { bounds: RasterBounds; bytes: Uint8ClampedArray }>();

  constructor(coverage: Uint8ClampedArray, width: number, height: number) {
    this.coverage = coverage;
    this.width = width;
    this.height = height;
  }

  touch(bounds: RasterBounds): void {
    const clipped = clipBounds(bounds, this.width, this.height);
    if (!clipped) {
      return;
    }
    const firstTileX = Math.floor(clipped.x / TILE_SIZE);
    const firstTileY = Math.floor(clipped.y / TILE_SIZE);
    const lastTileX = Math.floor((clipped.x + clipped.width - 1) / TILE_SIZE);
    const lastTileY = Math.floor((clipped.y + clipped.height - 1) / TILE_SIZE);
    for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
      for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
        const key = `${tileX}:${tileY}`;
        if (this.before.has(key)) {
          continue;
        }
        const x = tileX * TILE_SIZE;
        const y = tileY * TILE_SIZE;
        const width = Math.min(TILE_SIZE, this.width - x);
        const height = Math.min(TILE_SIZE, this.height - y);
        const bytes = new Uint8ClampedArray(width * height);
        for (let row = 0; row < height; row += 1) {
          bytes.set(
            this.coverage.subarray(
              (y + row) * this.width + x,
              (y + row) * this.width + x + width,
            ),
            row * width,
          );
        }
        this.before.set(key, { bounds: { x, y, width, height }, bytes });
      }
    }
  }

  commit(label: string): CoverageHistoryEntry | null {
    const patches: CoverageTilePatch[] = [];
    let byteLength = 0;
    for (const { bounds, bytes: before } of this.before.values()) {
      const after = new Uint8ClampedArray(bounds.width * bounds.height);
      for (let row = 0; row < bounds.height; row += 1) {
        after.set(
          this.coverage.subarray(
            (bounds.y + row) * this.width + bounds.x,
            (bounds.y + row) * this.width + bounds.x + bounds.width,
          ),
          row * bounds.width,
        );
      }
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
    return patches.length ? { label, patches, byteLength } : null;
  }
}

function transactionFromCoverageReplacement(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
  label: string,
): CoverageHistoryEntry | null {
  const patches: CoverageTilePatch[] = [];
  let byteLength = 0;
  for (let y = 0; y < height; y += TILE_SIZE) {
    for (let x = 0; x < width; x += TILE_SIZE) {
      const tileWidth = Math.min(TILE_SIZE, width - x);
      const tileHeight = Math.min(TILE_SIZE, height - y);
      const beforeTile = new Uint8ClampedArray(tileWidth * tileHeight);
      const afterTile = new Uint8ClampedArray(tileWidth * tileHeight);
      let changed = false;
      for (let row = 0; row < tileHeight; row += 1) {
        const sourceOffset = (y + row) * width + x;
        const targetOffset = row * tileWidth;
        beforeTile.set(before.subarray(sourceOffset, sourceOffset + tileWidth), targetOffset);
        afterTile.set(after.subarray(sourceOffset, sourceOffset + tileWidth), targetOffset);
      }
      for (let index = 0; index < beforeTile.length; index += 1) {
        if (beforeTile[index] !== afterTile[index]) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        continue;
      }
      patches.push({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        before: beforeTile,
        after: afterTile,
      });
      byteLength += beforeTile.byteLength + afterTile.byteLength;
    }
  }
  return patches.length ? { label, patches, byteLength } : null;
}

function applyCoverageHistoryEntry(
  coverage: Uint8ClampedArray,
  canvasWidth: number,
  entry: CoverageHistoryEntry,
  side: "before" | "after",
): void {
  for (const patch of entry.patches) {
    const bytes = side === "before" ? patch.before : patch.after;
    for (let row = 0; row < patch.height; row += 1) {
      coverage.set(
        bytes.subarray(row * patch.width, (row + 1) * patch.width),
        (patch.y + row) * canvasWidth + patch.x,
      );
    }
  }
}

function coverageToCanvas(
  coverage: Uint8ClampedArray,
  width: number,
  height: number,
  paintedPixels: TransformPaintedPixels = "white",
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  const output = coverageToOpaqueRgbaBytes(coverage, paintedPixels);
  const imageData = context.createImageData(width, height);
  imageData.data.set(output);
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function canvasToPngFile(canvas: HTMLCanvasElement, filename: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create mask PNG"));
        return;
      }
      resolve(new File([blob], filename, { type: "image/png" }));
    }, "image/png");
  });
}

export const MaskCanvasSurface = React.forwardRef<MaskCanvasSurfaceHandle, MaskCanvasSurfaceProps>(
  function MaskCanvasSurface(
    {
      active,
      imageUrl,
      draftImageUrl,
      compositionCanvas,
      expansion,
      baseDraftImageUrl,
      coverageFrame,
      sourceWidth,
      sourceHeight,
      initialState,
      spacePressed = false,
      onBeginPan,
      onFit,
      onSave,
      onDraftChange,
      onSettingsChange,
      onStateChange,
    },
    ref,
  ) {
    const { t } = useTranslation("transform");
    const surfaceScopeKey = JSON.stringify([imageUrl, sourceWidth, sourceHeight, expansion]);
    const captureSurface = useTransformOperationScope(surfaceScopeKey);
    const pendingApplyRequests = useRef(new Set<string>());
    useEffect(() => {
      setIsSaving(false);
      setDraftState("saved");
    }, [surfaceScopeKey]);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const coverageRef = useRef<Uint8ClampedArray<ArrayBufferLike>>(
      new Uint8ClampedArray(0),
    );
    const baseCoverageRef = useRef<Uint8ClampedArray>(new Uint8ClampedArray(0));
    const initializationEpochRef = useRef(0);
    const initializedCompositionRef = useRef<HTMLCanvasElement | null | undefined>(undefined);
    const gestureRef = useRef<CoverageGesture | null>(null);
    const coverageRenderFrameRef = useRef<number | null>(null);
    const pendingCoverageBoundsRef = useRef<RasterBounds | null>(null);
    const maskPreviewRendererRef = useRef<MaskPreviewRenderer | null>(null);
    const maskPreviewTextureReadyRef = useRef(false);
    const maskPreviewSizeRef = useRef("");
    const cursorVisualRef = useRef<HTMLDivElement | null>(null);
    const rectanglePreviewRef = useRef<HTMLDivElement | null>(null);
    const lassoPreviewRef = useRef<SVGSVGElement | null>(null);
    const lassoPolylineRef = useRef<SVGPolylineElement | null>(null);
    const persistTimerRef = useRef<number | null>(null);
    const persistPromiseRef = useRef<Promise<void> | null>(null);
    const mutationVersionRef = useRef(0);
    const outputPreviewCacheRef = useRef<OutputPreviewCache | null>(null);
    const initializedKeyRef = useRef<string | null>(null);
    const historyRef = useRef<CoverageHistory>({ entries: [], index: 0, bytes: 0 });

    const [tool, setTool] = useState<MaskTool>(initialState.lastTool);
    const [shapeOperation, setShapeOperation] = useState<MaskShapeOperation>("add");
    const [brushSize, setBrushSizeState] = useState(initialState.brush.sizePx);
    const [hardness, setHardnessState] = useState(initialState.brush.hardness);
    const [strength, setStrengthState] = useState(initialState.brush.strength);
    const [feather, setFeatherState] = useState(initialState.brush.featherPx);
    const [smoothing, setSmoothingState] = useState(initialState.brush.smoothing);
    const [fillTolerance, setFillToleranceState] = useState(initialState.fillTolerance);
    const [paintedPixels, setPaintedPixels] = useState<TransformPaintedPixels>(
      initialState.paintedPixels,
    );
    const [viewMode, setViewMode] = useState<TransformMaskViewMode>(initialState.viewMode);
    const [overlayColor, setOverlayColorState] = useState(initialState.overlayColor);
    const [overlayOpacity, setOverlayOpacityState] = useState(initialState.overlayOpacity);
    const [filename, setFilename] = useState(
      initialState.proposedFilename || buildDefaultFilename(imageUrl),
    );
    const [historyVersion, setHistoryVersion] = useState(0);
    const [isSaving, setIsSaving] = useState(false);
    const [isBusy, setIsBusy] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [hasCoverage, setHasCoverage] = useState(false);
    const [draftState, setDraftState] = useState<MaskDraftState>("saved");
    const opaqueImageUrl = useMemo(() => buildMaskSourceUrl(imageUrl, "opaque"), [imageUrl]);
    const sourceCoverageUrl = useMemo(() => buildMaskSourceUrl(imageUrl, "coverage"), [imageUrl]);

    const renderCoverage = useCallback((
      bounds?: RasterBounds,
      coverageChanged = true,
    ) => {
      const canvas = canvasRef.current;
      const coverage = coverageRef.current;
      if (!canvas || coverage.length !== sourceWidth * sourceHeight) {
        return;
      }
      const target = clipBounds(
        bounds ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
        sourceWidth,
        sourceHeight,
      );
      if (!target) {
        return;
      }
      if (coverageChanged) {
        outputPreviewCacheRef.current = null;
      }
      const sizeKey = `${canvas.width}x${canvas.height}`;
      if (maskPreviewSizeRef.current !== sizeKey) {
        maskPreviewSizeRef.current = sizeKey;
        maskPreviewTextureReadyRef.current = false;
      }
      let previewRenderer = maskPreviewRendererRef.current;
      if (!previewRenderer) {
        previewRenderer = createMaskPreviewRenderer(canvas);
        maskPreviewRendererRef.current = previewRenderer;
      }
      if (previewRenderer) {
        previewRenderer.resize(canvas.width, canvas.height);
        if (!maskPreviewTextureReadyRef.current) {
          previewRenderer.uploadFull(coverage, sourceWidth, sourceHeight);
          maskPreviewTextureReadyRef.current = true;
        } else if (coverageChanged) {
          if (bounds) {
            previewRenderer.uploadRegion(coverage, sourceWidth, target);
          } else {
            previewRenderer.uploadFull(coverage, sourceWidth, sourceHeight);
          }
        }
        previewRenderer.draw(viewMode, overlayColor, overlayOpacity);
        return;
      }
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      const imageData = context.createImageData(target.width, target.height);
      const [red, green, blue] = parseHexColor(overlayColor);
      for (let row = 0; row < target.height; row += 1) {
        for (let column = 0; column < target.width; column += 1) {
          const sourceIndex = (target.y + row) * sourceWidth + target.x + column;
          const targetIndex = (row * target.width + column) * 4;
          const value = coverage[sourceIndex];
          if (viewMode === "image") {
            imageData.data[targetIndex + 3] = 0;
          } else if (viewMode === "mask") {
            imageData.data[targetIndex] = value;
            imageData.data[targetIndex + 1] = value;
            imageData.data[targetIndex + 2] = value;
            imageData.data[targetIndex + 3] = 255;
          } else {
            imageData.data[targetIndex] = red;
            imageData.data[targetIndex + 1] = green;
            imageData.data[targetIndex + 2] = blue;
            imageData.data[targetIndex + 3] = Math.round(value * overlayOpacity);
          }
        }
      }
      context.putImageData(imageData, target.x, target.y);
    }, [overlayColor, overlayOpacity, sourceHeight, sourceWidth, viewMode]);

    const scheduleCoverageRender = useCallback((bounds: RasterBounds) => {
      pendingCoverageBoundsRef.current = unionBounds(
        pendingCoverageBoundsRef.current,
        bounds,
      );
      if (coverageRenderFrameRef.current != null) {
        return;
      }
      coverageRenderFrameRef.current = window.requestAnimationFrame(() => {
        coverageRenderFrameRef.current = null;
        const pendingBounds = pendingCoverageBoundsRef.current;
        pendingCoverageBoundsRef.current = null;
        if (pendingBounds) {
          renderCoverage(pendingBounds);
        }
      });
    }, [renderCoverage]);

    useEffect(() => () => {
      if (coverageRenderFrameRef.current != null) {
        window.cancelAnimationFrame(coverageRenderFrameRef.current);
      }
    }, []);

    useEffect(() => {
      if (isReady) {
        renderCoverage(undefined, false);
      }
    }, [isReady, renderCoverage]);

    const syncCoveragePresence = useCallback(() => {
      const coverage = coverageRef.current;
      let present = false;
      for (let index = 0; index < coverage.length; index += 1) {
        if (coverage[index] > 0) {
          present = true;
          break;
        }
      }
      setHasCoverage(present);
      return present;
    }, []);

    const currentDocumentMaskState = useCallback((): TransformMaskState => ({
      ...initialState,
      hasDraft: hasCoverage,
      coverageAssetPath: initialState.coverageAssetPath ?? initialState.draftPath ?? null,
      draftPath: initialState.coverageAssetPath ?? initialState.draftPath ?? null,
      overlayColor,
      overlayOpacity,
      viewMode,
      paintedPixels,
      lastTool: tool,
      brush: {
        sizePx: brushSize,
        hardness,
        strength,
        featherPx: feather,
        smoothing,
      },
      fillTolerance,
      proposedFilename: filename,
    }), [
      brushSize,
      feather,
      filename,
      fillTolerance,
      hardness,
      hasCoverage,
      initialState,
      overlayColor,
      overlayOpacity,
      paintedPixels,
      smoothing,
      strength,
      tool,
      viewMode,
    ]);

    useEffect(() => {
      if (isReady) {
        onSettingsChange?.(currentDocumentMaskState());
      }
    }, [currentDocumentMaskState, isReady, onSettingsChange]);

    const makeCoverageFile = useCallback(async (): Promise<File> => {
      const canvas = coverageToCanvas(
        coverageRef.current,
        sourceWidth,
        sourceHeight,
        "white",
      );
      return canvasToPngFile(canvas, "coverage.png");
    }, [sourceHeight, sourceWidth]);

    const makeDraftFile = useCallback(async (): Promise<File | null> => {
      const present = syncCoveragePresence();
      if (!present && !expansion) {
        return null;
      }
      return makeCoverageFile();
    }, [makeCoverageFile, syncCoveragePresence, expansion]);

    const persistDraftNow = useCallback(async () => {
      const isCurrent = captureSurface();
      if (!onDraftChange || !isReady) {
        setDraftState("saved");
        return;
      }
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (persistPromiseRef.current) {
        await persistPromiseRef.current;
      }
      if (!isCurrent()) return;
      const persistPromise = (async () => {
        try {
          setDraftState("saving");
          const baseFile = expansion ? await canvasToPngFile(coverageToCanvas(baseCoverageRef.current, sourceWidth, sourceHeight, "white"), "base.png") : null;
          if (!isCurrent()) return;
          const draftFile = await makeDraftFile();
          if (!isCurrent()) return;
          await onDraftChange(draftFile, baseFile);
          if (isCurrent()) setDraftState("saved");
        } catch (error) {
          if (!isCurrent()) return;
          console.error("Failed to persist mask coverage", error);
          setDraftState("error");
          throw error;
        }
      })();
      persistPromiseRef.current = persistPromise;
      try {
        await persistPromise;
      } finally {
        if (persistPromiseRef.current === persistPromise) {
          persistPromiseRef.current = null;
        }
      }
    }, [captureSurface, isReady, makeDraftFile, onDraftChange, expansion, sourceWidth, sourceHeight]);

    useEffect(() => {
      if (!active || !isReady) {
        return undefined;
      }
      const handleApplyRequest = (event: Event) => {
        const detail = (event as CustomEvent<MaskApplyRequestDetail>).detail;
        if (!detail?.requestId || pendingApplyRequests.current.has(detail.requestId)) return;
        pendingApplyRequests.current.add(detail.requestId);
        const isCurrent = captureSurface();
        void (async () => {
          try {
            await persistDraftNow();
            if (!isCurrent()) return;
            const coverageFile = await makeCoverageFile();
            if (!isCurrent()) return;
            window.dispatchEvent(new CustomEvent<MaskApplyReadyDetail>(MASK_APPLY_READY_EVENT, {
              detail: { requestId: detail.requestId, coverageFile },
            }));
          } catch (error) {
            if (isCurrent()) console.error("Failed to prepare mask coverage", error);
          } finally { pendingApplyRequests.current.delete(detail.requestId); }
        })();
      };
      window.addEventListener(MASK_APPLY_REQUEST_EVENT, handleApplyRequest as EventListener);
      return () => {
        window.removeEventListener(MASK_APPLY_REQUEST_EVENT, handleApplyRequest as EventListener);
      };
    }, [captureSurface, active, isReady, makeCoverageFile, persistDraftNow]);

    const schedulePersist = useCallback(() => {
      setDraftState("dirty");
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
      }
      const persistWhenIdle = () => {
        if (gestureRef.current) {
          persistTimerRef.current = window.setTimeout(
            persistWhenIdle,
            DRAFT_DEBOUNCE_MS,
          );
          return;
        }
        persistTimerRef.current = null;
        void persistDraftNow();
      };
      persistTimerRef.current = window.setTimeout(
        persistWhenIdle,
        DRAFT_DEBOUNCE_MS,
      );
    }, [persistDraftNow]);

    useEffect(() => () => {
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    }, [surfaceScopeKey]);

    const pushHistory = useCallback((entry: CoverageHistoryEntry | null) => {
      if (!entry) {
        return;
      }
      const history = historyRef.current;
      const entries = history.entries.slice(0, history.index);
      entries.push(entry);
      let bytes = entries.reduce((total, item) => total + item.byteLength, 0);
      while (entries.length > 1 && bytes > HISTORY_BYTE_LIMIT) {
        bytes -= entries.shift()?.byteLength ?? 0;
      }
      historyRef.current = { entries, index: entries.length, bytes };
      setHistoryVersion((value) => value + 1);
      syncCoveragePresence();
      schedulePersist();
    }, [schedulePersist, syncCoveragePresence]);

    const applyHistory = useCallback((direction: "undo" | "redo") => {
      const history = historyRef.current;
      const entry =
        direction === "undo"
          ? history.entries[history.index - 1]
          : history.entries[history.index];
      if (!entry) {
        return;
      }
      applyCoverageHistoryEntry(
        coverageRef.current,
        sourceWidth,
        entry,
        direction === "undo" ? "before" : "after",
      );
      history.index += direction === "undo" ? -1 : 1;
      mutationVersionRef.current += 1;
      renderCoverage();
      setHistoryVersion((value) => value + 1);
      syncCoveragePresence();
      schedulePersist();
    }, [renderCoverage, schedulePersist, sourceWidth, syncCoveragePresence]);

    const replaceCoverage = useCallback((
      nextCoverage: Uint8ClampedArray,
      label: string,
    ) => {
      const previous = coverageRef.current;
      const entry = transactionFromCoverageReplacement(
        previous,
        nextCoverage,
        sourceWidth,
        sourceHeight,
        label,
      );
      coverageRef.current = nextCoverage;
      mutationVersionRef.current += 1;
      renderCoverage();
      pushHistory(entry);
    }, [pushHistory, renderCoverage, sourceHeight, sourceWidth]);

    const initialize = useCallback(async () => {
      if (!active || sourceWidth <= 0 || sourceHeight <= 0 || (expansion && !compositionCanvas)) {
        if (expansion && !compositionCanvas) setIsReady(false);
        return;
      }
      const key = `${imageUrl}:${draftImageUrl || ""}:${sourceWidth}x${sourceHeight}:${JSON.stringify(expansion)}`;
      const epoch = ++initializationEpochRef.current;
      if (initializedKeyRef.current === key && initializedCompositionRef.current === compositionCanvas && isReady) {
        return;
      }
      initializedKeyRef.current = key;
      initializedCompositionRef.current = compositionCanvas;
      setIsReady(false);
      setLoadError(null);
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      canvas.width = sourceWidth;
      canvas.height = sourceHeight;
      coverageRef.current = new Uint8ClampedArray(sourceWidth * sourceHeight);
      historyRef.current = { entries: [], index: 0, bytes: 0 };
      setHistoryVersion((value) => value + 1);
      mutationVersionRef.current = 0;
      outputPreviewCacheRef.current = null;

      const sourceImage = new Image();
      const loadImage = (image: HTMLImageElement, src: string) =>
        new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`Failed to load ${src}`));
          image.src = src;
        });
      try {
        if (!compositionCanvas) await loadImage(sourceImage, opaqueImageUrl);
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = sourceWidth; sourceCanvas.height = sourceHeight;
        const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
        if (!sourceContext) throw new Error("Mask canvas unavailable");
        sourceContext.drawImage(compositionCanvas || sourceImage, 0, 0, sourceWidth, sourceHeight);
        const automatic = expansion ? expansionCoverage(expansion, sourceContext.getImageData(0, 0, sourceWidth, sourceHeight).data)
          : new Uint8ClampedArray(sourceWidth * sourceHeight);
        baseCoverageRef.current = automatic;
        if (expansion) {
          sourceContext.globalCompositeOperation = "destination-over";
          sourceContext.fillStyle = "rgb(127,127,127)"; sourceContext.fillRect(0, 0, sourceWidth, sourceHeight);
          sourceContext.globalCompositeOperation = "source-over";
        }
        sourceCanvasRef.current = sourceCanvas;
        const background = backgroundCanvasRef.current;
        if (background) {
          background.width = sourceWidth; background.height = sourceHeight;
          background.getContext("2d")?.drawImage(sourceCanvas, 0, 0);
        }
        let nextCoverage: Uint8ClampedArray = automatic;
        const readCoverage = async (url: string, frame: TransformRect) => {
          const image = new Image(); await loadImage(image, url);
          if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) {
            // The ordinary JPEG source path deliberately returns an empty 1x1 mask.
            if (!draftImageUrl && !expansion && image.naturalWidth === 1 && image.naturalHeight === 1) return new Uint8ClampedArray(frame.width * frame.height);
            throw new Error("Mask dimensions do not match its saved frame.");
          }
          const canvas = document.createElement("canvas"); canvas.width = frame.width; canvas.height = frame.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("Mask canvas unavailable");
          context.drawImage(image, 0, 0);
          return normalizeMaskDraftPixels(context.getImageData(0, 0, frame.width, frame.height).data, frame.width, frame.height);
        };
        if (expansion) {
          if (draftImageUrl) {
            const previousFrame = coverageFrame || { x: 0, y: 0, width: sourceWidth - expansion.left - expansion.right, height: sourceHeight - expansion.top - expansion.bottom };
            const previous = await readCoverage(draftImageUrl, previousFrame);
            const previousBase = baseDraftImageUrl ? await readCoverage(baseDraftImageUrl, previousFrame) : undefined;
            nextCoverage = reprojectCoverageEdits(automatic, expansionFrame(expansion), previous, previousFrame, previousBase);
          }
        } else {
          const frame = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
          if (draftImageUrl && coverageFrame && (coverageFrame.x !== 0 || coverageFrame.y !== 0 || coverageFrame.width !== sourceWidth || coverageFrame.height !== sourceHeight)) {
            const previous = await readCoverage(draftImageUrl, coverageFrame);
            const previousBase = baseDraftImageUrl ? await readCoverage(baseDraftImageUrl, coverageFrame) : undefined;
            nextCoverage = reprojectCoverageEdits(automatic, frame, previous, coverageFrame, previousBase);
          } else nextCoverage = await readCoverage(draftImageUrl || sourceCoverageUrl, frame);
        }
        if (epoch !== initializationEpochRef.current) return;
        coverageRef.current = nextCoverage;
        syncCoveragePresence();
        setIsReady(true);
        setDraftState("saved");
      } catch (error) {
        console.error(error);
        setLoadError(t("mask.errors.loadImage"));
      }
    }, [
      active,
      draftImageUrl,
      compositionCanvas,
      expansion,
      baseDraftImageUrl,
      coverageFrame,
      imageUrl,
      isReady,
      opaqueImageUrl,
      sourceCoverageUrl,
      sourceHeight,
      sourceWidth,
      syncCoveragePresence,
      t,
    ]);

    useEffect(() => {
      if (!active) {
        initializedKeyRef.current = null;
        setIsReady(false);
        return;
      }
      const frame = window.requestAnimationFrame(() => {
        void initialize();
      });
      return () => window.cancelAnimationFrame(frame);
    }, [active, initialize]);

    const getCanvasPoint = useCallback((event: React.PointerEvent | PointerEvent): RasterPoint | null => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) * canvas.width / Math.max(rect.width, 1), 0, canvas.width),
        y: clamp((event.clientY - rect.top) * canvas.height / Math.max(rect.height, 1), 0, canvas.height),
        pressure:
          "pressure" in event && typeof event.pressure === "number" && event.pressure > 0
            ? event.pressure
            : 1,
      };
    }, []);

    const updateCursorPosition = useCallback((point: RasterPoint | null) => {
      const cursor = cursorVisualRef.current;
      if (!cursor) {
        return;
      }
      if (!point) {
        cursor.style.display = "none";
        return;
      }
      cursor.style.display = "block";
      cursor.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
    }, []);

    const hideShapePreview = useCallback(() => {
      if (rectanglePreviewRef.current) {
        rectanglePreviewRef.current.style.display = "none";
      }
      if (lassoPreviewRef.current) {
        lassoPreviewRef.current.style.display = "none";
      }
    }, []);

    const updateShapePreview = useCallback((gesture: CoverageGesture) => {
      if (gesture.tool === "rectangle") {
        const preview = rectanglePreviewRef.current;
        if (!preview) {
          return;
        }
        const bounds = boundsFromPoints(gesture.start, gesture.last);
        preview.style.display = "block";
        preview.style.left = `${bounds.x}px`;
        preview.style.top = `${bounds.y}px`;
        preview.style.width = `${bounds.width}px`;
        preview.style.height = `${bounds.height}px`;
        if (lassoPreviewRef.current) {
          lassoPreviewRef.current.style.display = "none";
        }
        return;
      }
      if (gesture.tool === "lasso") {
        if (rectanglePreviewRef.current) {
          rectanglePreviewRef.current.style.display = "none";
        }
        if (lassoPreviewRef.current) {
          lassoPreviewRef.current.style.display = "block";
        }
        lassoPolylineRef.current?.setAttribute(
          "points",
          gesture.points.map((point) => `${point.x},${point.y}`).join(" "),
        );
      }
    }, []);

    const applyCoverageDab = useCallback((
      point: RasterPoint,
      operation: MaskShapeOperation,
      transaction: CoverageTileTransaction,
    ): RasterBounds | null => {
      const coverage = coverageRef.current;
      const radius = brushSize / 2;
      const featherRadius = Math.max(0, feather);
      const outerRadius = radius + featherRadius;
      const hardRadius = Math.max(0, radius * hardness);
      const bounds = clipBounds({
        x: point.x - outerRadius - 1,
        y: point.y - outerRadius - 1,
        width: outerRadius * 2 + 2,
        height: outerRadius * 2 + 2,
      }, sourceWidth, sourceHeight);
      if (!bounds) {
        return null;
      }
      transaction.touch(bounds);
      const pressure = clamp(point.pressure ?? 1, 0.05, 1);
      const amount = clamp(strength * pressure, 0, 1);
      for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
          const distance = Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y);
          if (distance > outerRadius) {
            continue;
          }
          const falloffStart = hardRadius;
          const weight =
            distance <= falloffStart
              ? 1
              : 1 - (distance - falloffStart) / Math.max(1, outerRadius - falloffStart);
          const index = y * sourceWidth + x;
          if (operation === "add") {
            coverage[index] = Math.round(
              coverage[index] + (255 - coverage[index]) * amount * clamp(weight, 0, 1),
            );
          } else {
            coverage[index] = Math.round(
              coverage[index] * (1 - amount * clamp(weight, 0, 1)),
            );
          }
        }
      }
      return bounds;
    }, [
      brushSize,
      feather,
      hardness,
      sourceHeight,
      sourceWidth,
      strength,
    ]);

    const drainCoverageGesture = useCallback((
      gesture: CoverageGesture,
    ) => {
      if (gesture.strokeDrainFrame != null) {
        window.cancelAnimationFrame(gesture.strokeDrainFrame);
        gesture.strokeDrainFrame = null;
      }
      let dirtyBounds: RasterBounds | null = null;
      const result = gesture.strokeQueue.drain(
        gesture.strokeResampler,
        (sample: StrokeSample) => {
          dirtyBounds = unionBounds(
            dirtyBounds,
            applyCoverageDab(sample, gesture.operation, gesture.transaction),
          );
        },
        { budgetMs: STROKE_WORK_BUDGET_MS, maxDabs: STROKE_WORK_MAX_DABS },
      );
      if (dirtyBounds) {
        scheduleCoverageRender(dirtyBounds);
      }
      if (result.remaining && gestureRef.current === gesture) {
        gesture.strokeDrainFrame = window.requestAnimationFrame(() => {
          gesture.strokeDrainFrame = null;
          drainCoverageGesture(gesture);
        });
      } else if (gesture.finalizing && !gesture.historyCommitted) {
        gesture.historyCommitted = true;
        gestureRef.current = null;
        pushHistory(gesture.transaction.commit(
          gesture.operation === "add" ? "Add to mask" : "Subtract from mask",
        ));
      }
    }, [applyCoverageDab, pushHistory, scheduleCoverageRender]);

    const enqueueCoverageSamples = useCallback((
      gesture: CoverageGesture,
      samples: readonly StrokeSample[],
    ) => {
      if (!samples.length) {
        return;
      }
      gesture.strokeQueue.enqueue(samples);
      if (gestureRef.current === gesture && gesture.strokeDrainFrame == null) {
        gesture.strokeDrainFrame = window.requestAnimationFrame(() => {
          gesture.strokeDrainFrame = null;
          drainCoverageGesture(gesture);
        });
      }
    }, [drainCoverageGesture]);

    const applyShapeBounds = useCallback((
      bounds: RasterBounds,
      operation: MaskShapeOperation,
      transaction: CoverageTileTransaction,
      stencil?: Uint8ClampedArray,
    ) => {
      const clipped = clipBounds(bounds, sourceWidth, sourceHeight);
      if (!clipped) {
        return;
      }
      transaction.touch(clipped);
      const coverage = coverageRef.current;
      const amount = clamp(strength, 0, 1);
      for (let row = 0; row < clipped.height; row += 1) {
        for (let column = 0; column < clipped.width; column += 1) {
          const stencilValue = stencil?.[row * clipped.width + column] ?? 255;
          if (stencilValue === 0) {
            continue;
          }
          const factor = amount * stencilValue / 255;
          const index = (clipped.y + row) * sourceWidth + clipped.x + column;
          coverage[index] = operation === "add"
            ? Math.round(coverage[index] + (255 - coverage[index]) * factor)
            : Math.round(coverage[index] * (1 - factor));
        }
      }
      renderCoverage(clipped);
    }, [renderCoverage, sourceHeight, sourceWidth, strength]);

    const commitRectangle = useCallback((gesture: CoverageGesture, end: RasterPoint) => {
      const bounds = boundsFromPoints(gesture.start, end);
      applyShapeBounds(bounds, gesture.operation, gesture.transaction);
      pushHistory(gesture.transaction.commit(
        gesture.operation === "add" ? "Add mask rectangle" : "Subtract mask rectangle",
      ));
    }, [applyShapeBounds, pushHistory]);

    const commitLasso = useCallback((gesture: CoverageGesture) => {
      if (gesture.points.length < 3) {
        return;
      }
      const minX = Math.floor(Math.min(...gesture.points.map((point) => point.x)));
      const minY = Math.floor(Math.min(...gesture.points.map((point) => point.y)));
      const maxX = Math.ceil(Math.max(...gesture.points.map((point) => point.x)));
      const maxY = Math.ceil(Math.max(...gesture.points.map((point) => point.y)));
      const clipped = clipBounds(
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        sourceWidth,
        sourceHeight,
      );
      if (!clipped) {
        return;
      }
      const stencilCanvas = document.createElement("canvas");
      stencilCanvas.width = clipped.width;
      stencilCanvas.height = clipped.height;
      const context = stencilCanvas.getContext("2d");
      if (!context) {
        return;
      }
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.moveTo(
        gesture.points[0].x - clipped.x,
        gesture.points[0].y - clipped.y,
      );
      for (const point of gesture.points.slice(1)) {
        context.lineTo(point.x - clipped.x, point.y - clipped.y);
      }
      context.closePath();
      context.fill();
      const rgba = context.getImageData(0, 0, clipped.width, clipped.height).data;
      const stencil = new Uint8ClampedArray(clipped.width * clipped.height);
      for (let index = 0; index < stencil.length; index += 1) {
        stencil[index] = rgba[index * 4 + 3];
      }
      applyShapeBounds(clipped, gesture.operation, gesture.transaction, stencil);
      pushHistory(gesture.transaction.commit(
        gesture.operation === "add" ? "Add mask lasso" : "Subtract mask lasso",
      ));
    }, [applyShapeBounds, pushHistory, sourceHeight, sourceWidth]);

    const applyMaskFill = useCallback(async (point: RasterPoint) => {
      const sourceContext = sourceCanvasRef.current?.getContext("2d");
      if (!sourceContext) {
        return;
      }
      setIsBusy(true);
      try {
        const result = await runFloodFill(
          sourceContext.getImageData(0, 0, sourceWidth, sourceHeight).data,
          sourceWidth,
          sourceHeight,
          point.x,
          point.y,
          fillTolerance,
          true,
          { transferInput: true },
        );
        if (!result.bounds) {
          return;
        }
        const transaction = new CoverageTileTransaction(
          coverageRef.current,
          sourceWidth,
          sourceHeight,
        );
        transaction.touch(result.bounds);
        const coverage = coverageRef.current;
        const amount = clamp(strength, 0, 1);
        for (let row = 0; row < result.bounds.height; row += 1) {
          if (row > 0 && row % 32 === 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          }
          const rowOffset: number = (result.bounds.y + row) * sourceWidth;
          for (let column = 0; column < result.bounds.width; column += 1) {
            const index = rowOffset + result.bounds.x + column;
            if (!result.mask[index]) {
              continue;
            }
            coverage[index] = shapeOperation === "add"
              ? Math.round(coverage[index] + (255 - coverage[index]) * amount)
              : Math.round(coverage[index] * (1 - amount));
          }
        }
        renderCoverage(result.bounds);
        pushHistory(transaction.commit(
          shapeOperation === "add" ? "Fill mask region" : "Subtract mask fill",
        ));
      } finally {
        setIsBusy(false);
      }
    }, [
      fillTolerance,
      pushHistory,
      renderCoverage,
      shapeOperation,
      sourceHeight,
      sourceWidth,
      strength,
    ]);

    const startDrawing = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isReady) {
        return;
      }
      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }
      updateCursorPosition(point);
      if (event.button === 1 || tool === "pan" || spacePressed) {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onBeginPan?.(event);
        return;
      }
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      mutationVersionRef.current += 1;
      if (tool === "fill") {
        void applyMaskFill(point);
        return;
      }
      const operation =
        tool === "subtract"
          ? "subtract"
          : tool === "add"
            ? "add"
            : shapeOperation;
      const transaction = new CoverageTileTransaction(
        coverageRef.current,
        sourceWidth,
        sourceHeight,
      );
      const strokeResampler = new StrokeResampler({
        spacing: Math.max(1, brushSize * 0.14),
      });
      strokeResampler.push({ ...point, pressure: point.pressure ?? 1 });
      const gesture: CoverageGesture = {
        tool,
        pointerId: event.pointerId,
        operation,
        start: point,
        last: point,
        points: [point],
        transaction,
        strokeQueue: new StrokeWorkQueue(),
        strokeResampler,
        strokeDrainFrame: null,
        finalizing: false,
        historyCommitted: false,
      };
      gestureRef.current = gesture;
      if (tool === "add" || tool === "subtract") {
        const dirtyBounds = applyCoverageDab(point, operation, transaction);
        if (dirtyBounds) {
          scheduleCoverageRender(dirtyBounds);
        }
      } else if (tool === "rectangle" || tool === "lasso") {
        updateShapePreview(gesture);
      }
    }, [
      applyCoverageDab,
      applyMaskFill,
      brushSize,
      getCanvasPoint,
      isReady,
      onBeginPan,
      shapeOperation,
      sourceHeight,
      sourceWidth,
      spacePressed,
      tool,
      scheduleCoverageRender,
      updateCursorPosition,
      updateShapePreview,
    ]);

    const continueDrawing = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
      const coalescedEvents =
        typeof event.nativeEvent.getCoalescedEvents === "function"
          ? event.nativeEvent.getCoalescedEvents()
          : [];
      const pointerEvents = coalescedEvents.length
        ? coalescedEvents
        : [event.nativeEvent];
      const points = pointerEvents
        .map((pointerEvent) => getCanvasPoint(pointerEvent))
        .filter((point): point is RasterPoint => Boolean(point));
      const point = points.length ? points[points.length - 1] : null;
      updateCursorPosition(point);
      const gesture = gestureRef.current;
      if (!gesture || !point) {
        return;
      }
      if (gesture.pointerId !== event.nativeEvent.pointerId) {
        return;
      }
      if (gesture.finalizing) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (gesture.tool === "add" || gesture.tool === "subtract") {
        const samples: StrokeSample[] = points.map((coalescedPoint) => ({
          x: gesture.last.x * smoothing + coalescedPoint.x * (1 - smoothing),
          y: gesture.last.y * smoothing + coalescedPoint.y * (1 - smoothing),
          pressure: coalescedPoint.pressure ?? 1,
        }));
        if (samples.length) {
          gesture.last = samples[samples.length - 1];
          enqueueCoverageSamples(gesture, samples);
        }
      } else {
        for (const coalescedPoint of points) {
          gesture.points.push(coalescedPoint);
          gesture.last = coalescedPoint;
        }
        updateShapePreview(gesture);
      }
    }, [
      enqueueCoverageSamples,
      getCanvasPoint,
      smoothing,
      updateCursorPosition,
      updateShapePreview,
    ]);

    const stopDrawing = useCallback((event?: React.PointerEvent<HTMLCanvasElement>) => {
      const gesture = gestureRef.current;
      hideShapePreview();
      if (!gesture) {
        return;
      }
      if (gesture.finalizing) {
        return;
      }
      const point = event ? getCanvasPoint(event) ?? gesture.last : gesture.last;
      if (gesture.tool === "add" || gesture.tool === "subtract") {
        if (event?.nativeEvent.type === "pointerup") {
          enqueueCoverageSamples(gesture, [{
            ...point,
            pressure: event.nativeEvent.pressure > 0 ? event.nativeEvent.pressure : 1,
          }]);
        }
        if (event?.nativeEvent.type === "pointerup") {
          gesture.strokeQueue.enqueueDabs(gesture.strokeResampler.finish(true));
        }
        gesture.finalizing = true;
        drainCoverageGesture(gesture);
      } else if (gesture.tool === "rectangle") {
        gestureRef.current = null;
        commitRectangle(gesture, point);
      } else {
        gestureRef.current = null;
        commitLasso(gesture);
      }
    }, [
      commitLasso,
      commitRectangle,
      drainCoverageGesture,
      enqueueCoverageSamples,
      getCanvasPoint,
      hideShapePreview,
    ]);

    const clearCoverage = useCallback(() => {
      const next = new Uint8ClampedArray(sourceWidth * sourceHeight);
      replaceCoverage(next, "Clear mask");
    }, [replaceCoverage, sourceHeight, sourceWidth]);

    const fillAll = useCallback(() => {
      const next = new Uint8ClampedArray(sourceWidth * sourceHeight);
      next.fill(255);
      replaceCoverage(next, "Fill mask");
    }, [replaceCoverage, sourceHeight, sourceWidth]);

    const invertCoverage = useCallback(() => {
      const next = coverageRef.current.slice();
      for (let index = 0; index < next.length; index += 1) {
        next[index] = 255 - next[index];
      }
      replaceCoverage(next, "Invert mask");
    }, [replaceCoverage]);

    const applyHeavyOperation = useCallback(async (
      operation: "feather" | "grow" | "shrink",
      radius: number,
    ) => {
      if (!isReady || radius <= 0) {
        return;
      }
      setIsBusy(true);
      try {
        const before = coverageRef.current;
        const next =
          operation === "feather"
            ? await runMaskFeather(before, sourceWidth, sourceHeight, radius)
            : await runMaskMorph(
              before,
              sourceWidth,
              sourceHeight,
              radius,
              operation,
            );
        replaceCoverage(
          next,
          operation === "feather"
            ? "Feather mask"
            : operation === "grow"
              ? "Grow mask"
              : "Shrink mask",
        );
      } finally {
        setIsBusy(false);
      }
    }, [isReady, replaceCoverage, sourceHeight, sourceWidth]);

    const getOutputPreviewDataUrl = useCallback((maxDimension = 360): string | null => {
      if (!isReady) {
        return null;
      }
      const safeMaxDimension = Math.max(
        1,
        Math.floor(Number.isFinite(maxDimension) ? maxDimension : 360),
      );
      const scale = Math.min(
        1,
        safeMaxDimension / Math.max(sourceWidth, sourceHeight),
      );
      const previewWidth = Math.max(1, Math.round(sourceWidth * scale));
      const previewHeight = Math.max(1, Math.round(sourceHeight * scale));
      const cacheKey = [
        mutationVersionRef.current,
        paintedPixels,
        `${sourceWidth}x${sourceHeight}`,
        `${previewWidth}x${previewHeight}`,
      ].join(":");
      if (outputPreviewCacheRef.current?.key === cacheKey) {
        return outputPreviewCacheRef.current.dataUrl;
      }

      const preview = document.createElement("canvas");
      preview.width = previewWidth;
      preview.height = previewHeight;
      const context = preview.getContext("2d");
      if (!context) {
        return null;
      }
      const coverage = coverageRef.current;
      const imageData = context.createImageData(previewWidth, previewHeight);
      for (let y = 0; y < previewHeight; y += 1) {
        const sourceY = Math.min(
          sourceHeight - 1,
          Math.floor((y + 0.5) * sourceHeight / previewHeight),
        );
        const sourceRow = sourceY * sourceWidth;
        for (let x = 0; x < previewWidth; x += 1) {
          const sourceX = Math.min(
            sourceWidth - 1,
            Math.floor((x + 0.5) * sourceWidth / previewWidth),
          );
          const coverageValue = coverage[sourceRow + sourceX];
          const outputValue =
            paintedPixels === "white" ? coverageValue : 255 - coverageValue;
          const offset = (y * previewWidth + x) * 4;
          imageData.data[offset] = outputValue;
          imageData.data[offset + 1] = outputValue;
          imageData.data[offset + 2] = outputValue;
          imageData.data[offset + 3] = 255;
        }
      }
      context.putImageData(imageData, 0, 0);
      const dataUrl = preview.toDataURL("image/png");
      outputPreviewCacheRef.current = { key: cacheKey, dataUrl };
      return dataUrl;
    }, [isReady, paintedPixels, sourceHeight, sourceWidth]);

    const handleSave = useCallback(async () => {
      const isCurrent = captureSurface();
      if (!isReady) {
        return;
      }
      setIsSaving(true);
      try {
        await persistDraftNow();
        if (!isCurrent()) return;
        const safeFilename = (filename.trim() || buildDefaultFilename(imageUrl));
        const normalizedFilename = safeFilename.toLowerCase().endsWith(".png")
          ? safeFilename
          : `${safeFilename}.png`;
        const canvas = coverageToCanvas(
          coverageRef.current,
          sourceWidth,
          sourceHeight,
          paintedPixels,
        );
        const file = await canvasToPngFile(canvas, normalizedFilename);
        if (!isCurrent()) return;
        await onSave(file);
      } catch (error) {
        if (!isCurrent()) return;
        console.error(error);
        window.alert(t("mask.errors.save"));
      } finally {
        if (isCurrent()) setIsSaving(false);
      }
    }, [
      captureSurface,
      filename,
      imageUrl,
      isReady,
      onSave,
      paintedPixels,
      persistDraftNow,
      sourceHeight,
      sourceWidth,
      t,
    ]);

    const setOverlayColor = useCallback((value: string) => {
      if (/^#[0-9a-f]{6}$/i.test(value)) {
        setOverlayColorState(value.toLowerCase());
      }
    }, []);

    const setBrushSize = useCallback((value: number) => {
      setBrushSizeState(clampBrushSize(value));
    }, []);

    const setHardness = useCallback((value: number) => {
      setHardnessState(clamp(value, 0, 1));
    }, []);
    const setStrength = useCallback((value: number) => {
      setStrengthState(clamp(value, 0.01, 1));
    }, []);
    const setFeather = useCallback((value: number) => {
      setFeatherState(clamp(value, 0, 256));
    }, []);
    const setSmoothing = useCallback((value: number) => {
      setSmoothingState(clamp(value, 0, 0.95));
    }, []);
    const setFillTolerance = useCallback((value: number) => {
      setFillToleranceState(clamp(value, 0, 255));
    }, []);
    const setOverlayOpacity = useCallback((value: number) => {
      setOverlayOpacityState(clamp(value, 0.05, 1));
    }, []);

    useImperativeHandle(ref, () => ({
      undo: () => applyHistory("undo"),
      redo: () => applyHistory("redo"),
      clear: clearCoverage,
      fillAll,
      invertCoverage,
      featherCoverage: (radius) => applyHeavyOperation("feather", radius),
      growCoverage: (radius) => applyHeavyOperation("grow", radius),
      shrinkCoverage: (radius) => applyHeavyOperation("shrink", radius),
      save: handleSave,
      flushDraft: persistDraftNow,
      getCoverageFile: makeCoverageFile,
      getOutputPreviewDataUrl,
      setTool,
      setShapeOperation,
      setBrushSize,
      setHardness,
      setStrength,
      setFeather,
      setSmoothing,
      setFillTolerance,
      setPaintedPixels,
      setViewMode,
      setOverlayColor,
      setOverlayOpacity,
      setFilename,
    }), [
      applyHeavyOperation,
      applyHistory,
      clearCoverage,
      fillAll,
      makeCoverageFile,
      getOutputPreviewDataUrl,
      handleSave,
      invertCoverage,
      persistDraftNow,
      setBrushSize,
      setFeather,
      setFillTolerance,
      setHardness,
      setOverlayColor,
      setOverlayOpacity,
      setSmoothing,
      setStrength,
    ]);

    const surfaceState = useMemo<MaskCanvasSurfaceState>(() => {
      void historyVersion;
      const history = historyRef.current;
      return {
        tool,
        shapeOperation,
        brushSize,
        hardness,
        strength,
        feather,
        smoothing,
        fillTolerance,
        paintedPixels,
        viewMode,
        overlayColor,
        overlayOpacity,
        filename,
        canUndo: history.index > 0,
        canRedo: history.index < history.entries.length,
        isSaving,
        isBusy,
        isReady,
        hasCoverage,
        historyBytes: history.bytes,
        draftState,
      };
    }, [
      brushSize,
      draftState,
      feather,
      filename,
      fillTolerance,
      hardness,
      hasCoverage,
      historyVersion,
      isBusy,
      isReady,
      isSaving,
      overlayColor,
      overlayOpacity,
      paintedPixels,
      shapeOperation,
      smoothing,
      strength,
      tool,
      viewMode,
    ]);

    useEffect(() => {
      onStateChange?.(surfaceState);
    }, [onStateChange, surfaceState]);

    const cursorDiameter = Math.max(1, brushSize);
    const showBrushCursor = tool === "add" || tool === "subtract";

    return (
      <div
        data-testid="mask-canvas-surface"
        className="absolute inset-0 overflow-hidden rounded-2xl bg-black shadow-[0_24px_80px_rgba(15,23,42,0.28)] dark:shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFit?.();
        }}
      >
        {expansion ? <canvas ref={backgroundCanvasRef} aria-label={t("mask.sourceAlt")}
          className="absolute inset-0 h-full w-full" style={{ opacity: viewMode === "mask" ? 0 : 1 }} /> : <img
          src={opaqueImageUrl}
          alt={t("mask.sourceAlt")}
          className="absolute inset-0 h-full w-full select-none object-fill"
          style={{ opacity: viewMode === "mask" ? 0 : 1 }}
          draggable={false}
        />}
        <canvas
          ref={canvasRef}
          aria-label={t("mask.overlayCanvasAria")}
          className="absolute inset-0 h-full w-full touch-none"
          style={{
            cursor: tool === "pan" ? "grab" : showBrushCursor ? "none" : "crosshair",
            pointerEvents: isReady ? "auto" : "none",
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={startDrawing}
          onPointerMove={continueDrawing}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
          onLostPointerCapture={stopDrawing}
          onPointerLeave={(event) => {
            updateCursorPosition(null);
            if (gestureRef.current) {
              stopDrawing(event);
            }
          }}
        />

        {showBrushCursor && (
          <div
            ref={cursorVisualRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0"
            style={{ display: "none" }}
          >
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.75)]"
              style={{
                width: cursorDiameter,
                height: cursorDiameter,
              }}
            />
            <div
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70"
              style={{
                width: Math.max(1, cursorDiameter * hardness),
                height: Math.max(1, cursorDiameter * hardness),
              }}
            />
          </div>
        )}

        <div
          ref={rectanglePreviewRef}
          aria-hidden="true"
          className="pointer-events-none absolute border border-dashed border-white bg-primary/10"
          style={{ display: "none" }}
        />

        <svg
          ref={lassoPreviewRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
          preserveAspectRatio="none"
          style={{ display: "none" }}
        >
          <polyline
            ref={lassoPolylineRef}
            fill="rgba(22,184,212,0.16)"
            stroke="white"
            strokeDasharray="8 6"
            strokeWidth={Math.max(1, 2)}
          />
        </svg>

        {(!isReady || isBusy) && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/30 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-full border border-border bg-surface/90 px-4 py-2 text-sm text-foreground shadow-sm">
              {loadError ? (
                <span>{loadError}</span>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {isBusy ? t("mask.processing") : t("mask.loading")}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);

MaskCanvasSurface.displayName = "MaskCanvasSurface";
