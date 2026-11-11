import { TransformRevisionHistory } from "./TransformRevisionHistory";
import { OutpaintingPipeSheet } from "./OutpaintingPipeSheet";
import type { TransformOutpaintPrepareResponse } from "@/shared/api/transform.api";
import { ExpansionControls, ExpansionHandles } from "./ExpansionControls";
import { normalizeTransformExpansion } from "./expansion";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FlipHorizontal,
  FlipVertical,
  Layers3,
  Loader2,
  Lock,
  MessageSquare,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanSearch,
  Trash2,
  Type,
  Undo2,
  Unlock,
  ZoomIn,
  ZoomOut,
  ImagePlus,
  Move,
} from "lucide-react";

import { api } from "@/lib/api";
import { SWEET_TEA_IMAGE_DRAG_MIME } from "@/lib/mediaDragPayload";
import type { Project, TransformDocument, TransformExportResponse, TransformSourceImage } from "@/shared/types";
import type {
  TransformExpansion,
  TransformEditTool,
  TransformImageLayer,
  TransformLayer,
  TransformMaskState,
  TransformMode,
  TransformPaintLayer,
  TransformTextObjectKind,
  TransformTextObject,
  TransformWorkspaceLaunchPayload,
} from "@/shared/types";
import { Button } from "@/components/ui/button";
import { ContextHelpTrigger } from "@/features/context-help";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatLocalizedNumber } from "@/i18n/format";
import {
  TRANSFORM_FONTS_UPDATED_EVENT,
  buildTransformFontOptions,
  loadManagedTransformFonts,
} from "@/features/transform/transformFonts";
import { useTransformOperationScope } from "@/features/transform/useTransformOperationScope";
import { useTransformAutosave } from "@/features/transform/useTransformAutosave";
import {
  useTransformInteractionPreview,
  type TransformCompositePreviewOptions,
} from "@/features/transform/useTransformInteractionPreview";
import { useTransformCanvasRuntime } from "@/features/transform/useTransformCanvasRuntime";
import { useTransformDelivery } from "@/features/transform/useTransformDelivery";
import {
  createTransformPreviewRenderer,
  type TransformPreviewRenderer,
} from "@/features/transform/transformPreviewRenderer";
import {
  useTransformHistory,
  type DragHistorySnapshot,
  type TransformHistoryPaintDiff,
  type TransformHistorySelection,
} from "@/features/transform/useTransformHistory";
import { useTransformLaunchSession } from "@/features/transform/useTransformLaunchSession";
import {
  buildImageUrl,
  clamp,
  createCanvasFromPaintLayer,
  createImageElementFromTransformLayer,
  getImageDimensionsFromDataUrl,
  readImageBlobAsDataUrl,
  toBlob,
} from "@/features/transform/transformCanvasUtils";
import {
  RasterTileTransaction,
  applyRasterTileDiff,
  boundsFromPoints,
  createSmudgeState,
  createRasterPixelSampler,
  drawBrushDab,
  drawBrushSegment,
  drawPixelateDab,
  drawSmudgeDab,
  type RasterBounds,
  type RasterPixelSampler,
  type RasterPoint,
  type SmudgeState,
} from "@/features/transform/rasterEngine";
import {
  StrokeResampler,
  StrokeWorkQueue,
  STROKE_WORK_BUDGET_MS,
  STROKE_WORK_MAX_DABS,
  type StrokeSample,
} from "@/features/transform/strokeInput";
import {
  recordFirstDabLatency,
  recordRasterDiagnostics,
} from "@/features/transform/rasterDiagnostics";
import { runFloodFill } from "@/features/transform/rasterWorkerClient";
import {
  getTransformTool,
  resolveTransformShortcut,
  type TransformToolId,
} from "@/features/transform/transformTools";
import {
  TransformContextBar,
  TransformHeader,
  TransformHistoryPanel,
  TransformLayersPanel,
  TransformRightDock,
  TransformSheet,
  TransformToolDock,
  TransformWorkspaceShell,
  type TransformRightDockTab,
} from "@/features/transform/TransformWorkspaceShell";
import {
  cloneTransformDocument,
  bringTransformTextObjectIntoFrame,
  createTransformLayer,
  createTransformImageLayer,
  createTransformImageLayerEntry,
  createTransformPaintLayer,
  createTransformPaintLayerEntry,
  defaultTransformSourceImageTransform,
  deleteTransformLayer,
  createTransformTextObject,
  deleteTransformObject,
  duplicateTransformObject,
  duplicateTransformImageLayer,
  defaultTransformAdjustments,
  isIdentityTransformSourceImageTransform,
  normalizeTransformSourceImageRotation,
  moveTransformLayer,
  reorderTransformLayer,
  retargetTransformTextObjectKind,
  transformFontSizeMaxForSource,
  transformPaddingMaxForObject,
  transformStrokeWidthMaxForSource,
  updateTransformLayer,
  transformTextOffsetXMax,
  transformTextOffsetYMax,
} from "@/features/transform/document";
import {
  deleteRasterSelection,
  extractRasterSelection,
  moveRasterSelection,
  pixelateRasterSelection,
  selectionFromMask,
  type TransformRasterSelection,
} from "@/features/transform/rasterSelection";
import {
  distanceToTailHandle,
  drawTransformDocument,
  drawTransformDocumentDecorations,
  findObjectAtPoint,
  getTransformAdjustmentFilter,
  getTransformCanvasGeometry,
  offsetTransformObjectLayout,
  pointDistance,
  rotatePoint,
  unrotatePoint,
  type TransformObjectLayout as CanvasObjectLayout,
} from "@/features/transform/render";
import {
  MaskCanvasSurface,
  type MaskCanvasSurfaceHandle,
  type MaskCanvasSurfaceState,
  type MaskTool,
} from "@/features/transform/MaskCanvasSurface";

export type TransformWorkspaceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launchPayload: TransformWorkspaceLaunchPayload | null;
  onExported?: (response?: TransformExportResponse) => void | Promise<void>;
};

type TransformDeliveryOperation = "new_copy" | "overwrite_current" | "mask";

type TransformDeliveryNotice = {
  operation: TransformDeliveryOperation;
  filename: string;
  folder: string | null;
};

type ResizeAxis = "x" | "y" | "both";
type CropDragKind = "move" | "resize";

type NumericInspectorField =
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "width"
  | "height"
  | "rotation"
  | "padding"
  | "strokeWidth"
  | "tailWidth"
  | "textOffsetX"
  | "textOffsetY";

type NumericCropField = "x" | "y" | "width" | "height";

type NumericFieldBounds = {
  min: number;
  max: number;
  step?: string;
};

type ColorInspectorField = "textColor" | "fillColor" | "strokeColor";
type TextBoxHorizontalPosition = "left" | "center" | "right";
type TextBoxVerticalPosition = "top" | "middle" | "bottom";
type TransformAdjustmentKey =
  | "brightness"
  | "contrast"
  | "saturation"
  | "hueDegrees";

type TransformAdjustmentSliderProps = {
  adjustmentKey: TransformAdjustmentKey;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  formatValue: (value: number) => string;
  onPreview: (key: TransformAdjustmentKey, value: number) => void;
  onCommit: (key: TransformAdjustmentKey, value: number) => void;
};

const TransformAdjustmentSlider = React.memo(function TransformAdjustmentSlider({
  adjustmentKey,
  label,
  min,
  max,
  step,
  value,
  formatValue,
  onPreview,
  onCommit,
}: TransformAdjustmentSliderProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const valueLabelRef = React.useRef<HTMLSpanElement | null>(null);
  const draftValueRef = React.useRef(value);
  const dirtyRef = React.useRef(false);

  React.useEffect(() => {
    draftValueRef.current = value;
    if (inputRef.current) {
      inputRef.current.value = String(value);
    }
    if (valueLabelRef.current) {
      valueLabelRef.current.textContent = formatValue(value);
    }
    dirtyRef.current = false;
  }, [formatValue, value]);

  const previewValue = React.useCallback((nextValue: number) => {
    const normalized = clamp(nextValue, min, max);
    draftValueRef.current = normalized;
    dirtyRef.current = true;
    if (valueLabelRef.current) {
      valueLabelRef.current.textContent = formatValue(normalized);
    }
    onPreview(adjustmentKey, normalized);
  }, [adjustmentKey, formatValue, max, min, onPreview]);

  const commitValue = React.useCallback(() => {
    if (!dirtyRef.current) {
      return;
    }
    dirtyRef.current = false;
    onCommit(adjustmentKey, draftValueRef.current);
  }, [adjustmentKey, onCommit]);

  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span ref={valueLabelRef} className="tabular-nums">{formatValue(value)}</span>
      </span>
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        onChange={(event) => previewValue(Number(event.target.value))}
        onPointerUp={commitValue}
        onPointerCancel={commitValue}
        onKeyUp={commitValue}
        onBlur={commitValue}
        className="w-full accent-primary"
      />
    </label>
  );
});

type DragState =
  | {
      kind: "move";
      objectId: string;
      startPoint: { x: number; y: number };
      originalObject: TransformTextObject;
      history: DragHistorySnapshot;
    }
  | {
      kind: "move-image";
      objectId: string;
      startPoint: { x: number; y: number };
      originalImageLayer: TransformImageLayer;
      history: DragHistorySnapshot;
    }
  | {
      kind: "tail";
      objectId: string;
      startPoint: { x: number; y: number };
      originalObject: TransformTextObject;
      history: DragHistorySnapshot;
    }
  | {
      kind: "tail-base";
      objectId: string;
      center: { x: number; y: number };
      originalObject: TransformTextObject;
      history: DragHistorySnapshot;
    }
  | {
      kind: "text";
      objectId: string;
      startLocalPoint: { x: number; y: number };
      center: { x: number; y: number };
      originalObject: TransformTextObject;
      history: DragHistorySnapshot;
    }
  | {
      kind: "resize";
      axis: ResizeAxis;
      objectId: string;
      startLocalPoint: { x: number; y: number };
      center: { x: number; y: number };
      originalObject: TransformTextObject;
      history: DragHistorySnapshot;
    }
  | {
      kind: "resize-image";
      objectId: string;
      startLocalPoint: { x: number; y: number };
      center: { x: number; y: number };
      originalImageLayer: TransformImageLayer;
      history: DragHistorySnapshot;
    }
  | {
      kind: "pan";
      startClient: { x: number; y: number };
      originalPan: { x: number; y: number };
      currentPan: { x: number; y: number };
    }
  | {
      kind: "paint";
      tool: "pencil" | "brush" | "eraser" | "smudge" | "pixelate";
      pointerId: number;
      layerId: string;
      layerEntryId: string;
      lastPoint: RasterPoint;
      transaction: RasterTileTransaction;
      samplingContext?: CanvasRenderingContext2D | null;
      pixelSampler?: RasterPixelSampler | null;
      smudgeState?: SmudgeState | null;
      visitedBlocks?: Set<string>;
      strokeQueue: StrokeWorkQueue;
      strokeResampler: StrokeResampler;
      strokeDrainFrame: number | null;
      strokeFinalizing: boolean;
      historyCommitStarted: boolean;
      pointerDownAt: number;
      hasAppliedDab: boolean;
      history: DragHistorySnapshot;
    }
  | {
      kind: "pixelate-selection";
      startPoint: RasterPoint;
      currentPoint: RasterPoint;
    }
  | {
      kind: "raster-selection-move";
      startPoint: RasterPoint;
      currentPoint: RasterPoint;
      selection: TransformRasterSelection;
      layerId: string;
      history: DragHistorySnapshot;
    }
  | {
      kind: "rotate";
      objectId: string;
      center: { x: number; y: number };
      originalObject: TransformTextObject;
      startAngle: number;
      history: DragHistorySnapshot;
    }
  | {
      kind: "rotate-image";
      objectId: string;
      center: { x: number; y: number };
      originalImageLayer: TransformImageLayer;
      startAngle: number;
      history: DragHistorySnapshot;
    }
  | {
      kind: "crop";
      dragKind: CropDragKind;
      startPoint: { x: number; y: number };
      originalCrop: { x: number; y: number; width: number; height: number };
      history: DragHistorySnapshot;
    };

type TransformDocumentDragState = Exclude<
  DragState,
  { kind: "paint" | "pan" | "pixelate-selection" | "raster-selection-move" }
>;

const NONE_SELECT_VALUE = "__none__";
const MISSING_FONT_SELECT_VALUE = "__missing_font__";
const NUMERIC_INSPECTOR_FIELDS: NumericInspectorField[] = [
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "width",
  "height",
  "rotation",
  "padding",
  "strokeWidth",
  "tailWidth",
  "textOffsetX",
  "textOffsetY",
];
const NUMERIC_CROP_FIELDS: NumericCropField[] = ["x", "y", "width", "height"];
const STATIC_NUMERIC_BOUNDS: Record<
  Exclude<NumericInspectorField, "width" | "height" | "tailWidth">,
  NumericFieldBounds
> = {
  fontSize: { min: 8, max: 144 },
  lineHeight: { min: 0.8, max: 2.4, step: "0.05" },
  letterSpacing: { min: -2, max: 16, step: "0.5" },
  rotation: { min: -180, max: 180, step: "1" },
  padding: { min: 0, max: 60 },
  strokeWidth: { min: 0, max: 12 },
  textOffsetX: { min: -120, max: 120 },
  textOffsetY: { min: -120, max: 120 },
};
const TEXT_BOX_POSITION_OPTIONS: Array<{
  horizontal: TextBoxHorizontalPosition;
  vertical: TextBoxVerticalPosition;
}> = [
  { horizontal: "left", vertical: "top" },
  { horizontal: "center", vertical: "top" },
  { horizontal: "right", vertical: "top" },
  { horizontal: "left", vertical: "middle" },
  { horizontal: "center", vertical: "middle" },
  { horizontal: "right", vertical: "middle" },
  { horizontal: "left", vertical: "bottom" },
  { horizontal: "center", vertical: "bottom" },
  { horizontal: "right", vertical: "bottom" },
];
const LETTERING_SHAPE_OPTIONS: TransformTextObjectKind[] = [
  "speech_bubble",
  "thought_bubble",
  "narration_box",
  "narration_rect",
  "burst_jagged",
  "burst_wavy",
  "free_text",
];
const DEFAULT_MASK_SURFACE_STATE: MaskCanvasSurfaceState = {
  tool: "add",
  shapeOperation: "add",
  brushSize: 64,
  hardness: 0.75,
  strength: 1,
  feather: 0,
  smoothing: 0.3,
  fillTolerance: 32,
  paintedPixels: "white",
  viewMode: "overlay",
  overlayColor: "#16b8d4",
  overlayOpacity: 0.55,
  filename: "mask.png",
  canUndo: false,
  canRedo: false,
  isSaving: false,
  isBusy: false,
  isReady: false,
  hasCoverage: false,
  historyBytes: 0,
  draftState: "saved",
};

export function getTransformHandleMetrics(surfaceScale: number) {
  const safeScale = Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1;
  const sourceUnits = (screenPixels: number) => screenPixels / safeScale;
  return {
    selectionInset: sourceUnits(3),
    selectionStrokeWidth: sourceUnits(2),
    handleSize: sourceUnits(16),
    textHandleSize: sourceUnits(14),
    rotationHandleOffset: sourceUnits(34),
    borderWidth: sourceUnits(2),
    thinBorderWidth: sourceUnits(1),
    hitRadius: {
      tail: sourceUnits(18),
      tailBase: sourceUnits(18),
      text: sourceUnits(17),
      resize: sourceUnits(18),
      resizeCorner: sourceUnits(20),
      rotation: sourceUnits(20),
    },
  };
}

function buildDisplayName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function buildAvailableTransformFolders(rawFolders: unknown, includeMasks: boolean): string[] {
  const folders = Array.isArray(rawFolders)
    ? rawFolders
      .filter((folder): folder is string => typeof folder === "string" && Boolean(folder.trim()))
      .map((folder) => folder.trim())
    : [];
  if (!includeMasks || folders.some((folder) => folder.toLowerCase() === "masks")) {
    return folders;
  }
  return [...folders, "masks"];
}

function isTransformTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function isTransformNudgeShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(
    target.closest(
      [
        "input",
        "textarea",
        "select",
        "button",
        "a[href]",
        "[role='button']",
        "[role='combobox']",
        "[role='link']",
        "[role='menuitem']",
        "[role='option']",
        "[role='slider']",
        "[role='switch']",
        "[contenteditable='true']",
      ].join(","),
    ),
  );
}

function formatNumericDraft(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function getObjectCenter(object: Pick<TransformTextObject, "x" | "y" | "width" | "height">) {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
  };
}

function roundOffset(value: number): number {
  return Math.round(value * 100) / 100;
}

type TextBoxSafeGeometry = {
  innerWidth: number;
  innerHeight: number;
  textBoxWidth: number;
  textBoxHeight: number;
  centeredX: number;
  centeredY: number;
};

type TextBoxContentMetrics = {
  width: number;
  height: number;
};

function getTextBoxSafeGeometry(object: TransformTextObject): TextBoxSafeGeometry {
  const padding = object.padding;
  const innerWidth = Math.max(24, object.width - padding * 2);
  const innerHeight = Math.max(24, object.height - padding * 2);
  const widthFactor =
    object.kind === "speech_bubble"
      ? 0.82
      : object.kind === "thought_bubble"
        ? 0.72
        : object.kind === "burst_jagged" || object.kind === "burst_wavy"
          ? 0.62
          : 1;
  const heightFactor =
    object.kind === "speech_bubble"
      ? 0.74
      : object.kind === "thought_bubble"
        ? 0.66
        : object.kind === "burst_jagged" || object.kind === "burst_wavy"
          ? 0.58
          : 1;
  const textBoxWidth = Math.max(24, innerWidth * widthFactor);
  const textBoxHeight = Math.max(24, innerHeight * heightFactor);
  return {
    innerWidth,
    innerHeight,
    textBoxWidth,
    textBoxHeight,
    centeredX: object.x + object.width / 2 - textBoxWidth / 2,
    centeredY: object.y + object.height / 2 - textBoxHeight / 2,
  };
}

function estimateTextContentMetrics(
  object: TransformTextObject,
  geometry: TextBoxSafeGeometry,
): TextBoxContentMetrics {
  const lineHeightPx = Math.max(1, object.fontSize * object.lineHeight);
  const rawLines = object.text.split(/\r?\n/);
  const lineCount = Math.max(1, rawLines.length);
  const estimatedWidth = rawLines.reduce((maxWidth, line) => {
    const characterWidth = object.fontSize * 0.55;
    const lineWidth = line.length * characterWidth + Math.max(0, line.length - 1) * object.letterSpacing;
    return Math.max(maxWidth, lineWidth);
  }, 1);
  return {
    width: clamp(estimatedWidth, 1, geometry.textBoxWidth),
    height: clamp(lineCount * lineHeightPx, lineHeightPx, geometry.textBoxHeight),
  };
}

function getTextContentMetrics(
  object: TransformTextObject,
  geometry: TextBoxSafeGeometry,
  layout?: CanvasObjectLayout | null,
): TextBoxContentMetrics {
  const lineHeightPx = Math.max(1, object.fontSize * object.lineHeight);
  if (layout?.objectId === object.id && layout.lines.length > 0) {
    const maxLineWidth = layout.lines.reduce((maxWidth, line) => Math.max(maxWidth, line.width), 1);
    return {
      width: clamp(maxLineWidth, 1, geometry.textBoxWidth),
      height: clamp(layout.lines.length * lineHeightPx, lineHeightPx, geometry.textBoxHeight),
    };
  }
  return estimateTextContentMetrics(object, geometry);
}

function getTextBoxPositionOffset(
  object: TransformTextObject,
  horizontal: TextBoxHorizontalPosition,
  vertical: TextBoxVerticalPosition,
  sourceImage?: Pick<TransformSourceImage, "width" | "height">,
  contentMetrics?: TextBoxContentMetrics,
): { x: number; y: number } {
  const geometry = getTextBoxSafeGeometry(object);
  const textMetrics = contentMetrics ?? estimateTextContentMetrics(object, geometry);
  const padding = object.padding;
  const desiredContentLeft =
    horizontal === "left"
      ? object.x + padding
      : horizontal === "right"
        ? object.x + object.width - padding - textMetrics.width
        : object.x + (object.width - textMetrics.width) / 2;
  const alignmentInset =
    object.textAlign === "left"
      ? 0
      : object.textAlign === "right"
        ? geometry.textBoxWidth - textMetrics.width
        : (geometry.textBoxWidth - textMetrics.width) / 2;
  const targetX = desiredContentLeft - alignmentInset;
  const targetY =
    vertical === "top"
      ? object.y + padding
      : vertical === "bottom"
        ? object.y + object.height - padding - textMetrics.height
        : object.y + (object.height - textMetrics.height) / 2;

  const offsetXMax = sourceImage
    ? transformTextOffsetXMax(object, sourceImage)
    : Math.max(120, Math.ceil(object.width));
  const offsetYMax = sourceImage
    ? transformTextOffsetYMax(object, sourceImage)
    : Math.max(120, Math.ceil(object.height));
  return {
    x: roundOffset(clamp(targetX - geometry.centeredX, -offsetXMax, offsetXMax)),
    y: roundOffset(clamp(targetY - geometry.centeredY, -offsetYMax, offsetYMax)),
  };
}

function loadImageSource(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load transform layer image"));
    image.src = src;
  });
}

function getReusableRasterCanvas(
  ref: React.MutableRefObject<HTMLCanvasElement | null>,
  width: number,
  height: number,
): HTMLCanvasElement {
  const nextWidth = Math.max(1, Math.floor(width));
  const nextHeight = Math.max(1, Math.floor(height));
  let canvas = ref.current;
  if (!canvas) {
    canvas = document.createElement("canvas");
    ref.current = canvas;
    recordRasterDiagnostics({
      largeCanvasAllocations: nextWidth * nextHeight >= 1024 * 1024 ? 1 : 0,
    });
  }
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    recordRasterDiagnostics({
      largeCanvasAllocations: nextWidth * nextHeight >= 1024 * 1024 ? 1 : 0,
    });
  }
  return canvas;
}

function getRasterStrokeSpacing(
  current: TransformDocument,
  tool: "pencil" | "brush" | "eraser" | "smudge" | "pixelate",
): number {
  if (tool === "smudge") {
    return Math.max(1, current.edit.retouchSettings.smudge.sizePx * 0.12);
  }
  if (tool === "pixelate") {
    return Math.max(2, current.edit.retouchSettings.pixelate.brushSizePx * 0.22);
  }
  const size = tool === "pencil"
    ? current.edit.paintSettings.pencilThicknessPx
    : tool === "eraser"
      ? current.edit.paintSettings.eraserThicknessPx
      : current.edit.paintSettings.brushThicknessPx;
  const spacing = tool === "pencil"
    ? 0.08
    : current.edit.paintSettings.brushSpacing;
  return Math.max(0.5, size * clamp(spacing, 0.02, 2));
}

function normalizeHexColor(value: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : "#000000";
}

function rgbaToHex(data: Uint8ClampedArray | number[]): string {
  return `#${[data[0], data[1], data[2]]
    .map((value) => Math.max(0, Math.min(255, Number(value) || 0)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function addRecentColor(settings: TransformDocument["edit"]["paintSettings"], color: string) {
  const normalized = normalizeHexColor(color);
  settings.activeColor = normalized;
  settings.recentColors = [
    normalized,
    ...settings.recentColors.filter((candidate) => candidate.toLowerCase() !== normalized),
  ].slice(0, 12);
}

function getPaintLayerRole(layer: TransformPaintLayer): NonNullable<TransformPaintLayer["role"]> {
  if (layer.role === "source_eraser") return "source_eraser";
  if (layer.role === "retouch") return "retouch";
  return "paint";
}

function getCropAspectRatioValue(value: TransformDocument["edit"]["crop"]["aspectRatio"], sourceImage: TransformSourceImage): number | null {
  if (value === "source") {
    return sourceImage.width / sourceImage.height;
  }
  if (value === "1:1") return 1;
  if (value === "4:3") return 4 / 3;
  if (value === "3:4") return 3 / 4;
  if (value === "16:9") return 16 / 9;
  if (value === "9:16") return 9 / 16;
  return null;
}

function normalizeTransformDocumentForCommit(document: TransformDocument, mode: TransformMode): TransformDocument {
  document.updatedAt = new Date().toISOString();
  document.lastUsedMode = mode;
  document.edit.sourceImageTransform.rotationDegrees = normalizeTransformSourceImageRotation(
    document.edit.sourceImageTransform.rotationDegrees,
  );
  document.edit.sourceImageTransform.flipHorizontal = Boolean(document.edit.sourceImageTransform.flipHorizontal);
  document.edit.sourceImageTransform.flipVertical = Boolean(document.edit.sourceImageTransform.flipVertical);
  document.text = {
    objects: document.edit.textObjects,
    layers: document.edit.layers.filter((layer) => layer.kind === "text_object"),
  };
  return document;
}

const OBJECT_NUDGE_BY_KEY: Partial<Record<KeyboardEvent["key"], { x: number; y: number }>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

const TRANSFORM_ACCELERATED_NUDGE_PX = 25;

function buildInteractionDraftDocument(
  baseDocument: TransformDocument,
  dragState: TransformDocumentDragState,
  point: { x: number; y: number },
  mode: TransformMode,
): TransformDocument {
  const next = cloneTransformDocument(baseDocument);

  if (dragState.kind === "crop") {
    const crop = next.edit.crop;
    const deltaX = point.x - dragState.startPoint.x;
    const deltaY = point.y - dragState.startPoint.y;
    if (dragState.dragKind === "move") {
      crop.x = clamp(dragState.originalCrop.x + deltaX, 0, next.sourceImage.width - crop.width);
      crop.y = clamp(dragState.originalCrop.y + deltaY, 0, next.sourceImage.height - crop.height);
    } else {
      const aspectRatio = getCropAspectRatioValue(crop.aspectRatio, next.sourceImage);
      let nextWidth = clamp(dragState.originalCrop.width + deltaX, 1, next.sourceImage.width - crop.x);
      let nextHeight = clamp(dragState.originalCrop.height + deltaY, 1, next.sourceImage.height - crop.y);
      if (aspectRatio) {
        nextHeight = clamp(nextWidth / aspectRatio, 1, next.sourceImage.height - crop.y);
        nextWidth = clamp(nextHeight * aspectRatio, 1, next.sourceImage.width - crop.x);
      }
      crop.width = nextWidth;
      crop.height = nextHeight;
    }
    crop.enabled = true;
    return normalizeTransformDocumentForCommit(next, mode);
  }

  if (
    dragState.kind === "move-image" ||
    dragState.kind === "resize-image" ||
    dragState.kind === "rotate-image"
  ) {
    const target = next.edit.imageLayers.find((layer) => layer.id === dragState.objectId);
    if (!target) {
      return normalizeTransformDocumentForCommit(next, mode);
    }
    if (dragState.kind === "move-image") {
      target.x = dragState.originalImageLayer.x + point.x - dragState.startPoint.x;
      target.y = dragState.originalImageLayer.y + point.y - dragState.startPoint.y;
    } else if (dragState.kind === "resize-image") {
      const localPoint = unrotatePoint(
        point,
        dragState.center,
        dragState.originalImageLayer.rotation,
      );
      const deltaX = localPoint.x - dragState.startLocalPoint.x;
      const deltaY = localPoint.y - dragState.startLocalPoint.y;
      const scale = Math.max(
        0.02,
        Math.max(
          (dragState.originalImageLayer.width + deltaX) / dragState.originalImageLayer.width,
          (dragState.originalImageLayer.height + deltaY) / dragState.originalImageLayer.height,
        ),
      );
      target.width = Math.max(1, dragState.originalImageLayer.width * scale);
      target.height = Math.max(1, dragState.originalImageLayer.height * scale);
    } else {
      const nextAngle = Math.atan2(
        point.y - dragState.center.y,
        point.x - dragState.center.x,
      );
      target.rotation = normalizeTransformSourceImageRotation(
        dragState.originalImageLayer.rotation +
        (nextAngle - dragState.startAngle) * 180 / Math.PI,
      );
    }
    target.updatedAt = new Date().toISOString();
    return normalizeTransformDocumentForCommit(next, mode);
  }

  const target = next.edit.textObjects.find((object) => object.id === dragState.objectId);
  if (!target) {
    return normalizeTransformDocumentForCommit(next, mode);
  }

  if (dragState.kind === "move") {
    const deltaX = point.x - dragState.startPoint.x;
    const deltaY = point.y - dragState.startPoint.y;
    target.x = dragState.originalObject.x + deltaX;
    target.y = dragState.originalObject.y + deltaY;
    if (target.tailX != null) {
      target.tailX = dragState.originalObject.tailX != null ? dragState.originalObject.tailX + deltaX : target.tailX;
    }
    if (target.tailY != null) {
      target.tailY = dragState.originalObject.tailY != null ? dragState.originalObject.tailY + deltaY : target.tailY;
    }
  } else if (dragState.kind === "tail") {
    target.tailX = point.x;
    target.tailY = point.y;
  } else if (dragState.kind === "tail-base") {
    const localPoint = unrotatePoint(
      point,
      dragState.center,
      dragState.originalObject.rotation,
    );
    target.tailBaseAngle = Math.atan2(
      localPoint.y - dragState.center.y,
      localPoint.x - dragState.center.x,
    );
  } else if (dragState.kind === "text") {
    const localPoint = unrotatePoint(
      point,
      dragState.center,
      dragState.originalObject.rotation,
    );
    const deltaLocalX = localPoint.x - dragState.startLocalPoint.x;
    const deltaLocalY = localPoint.y - dragState.startLocalPoint.y;
    const textOffsetXMax = transformTextOffsetXMax(target, next.sourceImage);
    const textOffsetYMax = transformTextOffsetYMax(target, next.sourceImage);
    target.textOffsetX = clamp(
      dragState.originalObject.textOffsetX + deltaLocalX,
      -textOffsetXMax,
      textOffsetXMax,
    );
    target.textOffsetY = clamp(
      dragState.originalObject.textOffsetY + deltaLocalY,
      -textOffsetYMax,
      textOffsetYMax,
    );
  } else if (dragState.kind === "resize") {
    const localPoint = unrotatePoint(
      point,
      dragState.center,
      dragState.originalObject.rotation,
    );
    const deltaLocalX = localPoint.x - dragState.startLocalPoint.x;
    const deltaLocalY = localPoint.y - dragState.startLocalPoint.y;
    if (dragState.axis === "x" || dragState.axis === "both") {
      target.width = clamp(
        dragState.originalObject.width + deltaLocalX,
        120,
        Math.max(120, next.sourceImage.width * 2),
      );
    }
    if (dragState.axis === "y" || dragState.axis === "both") {
      target.height = clamp(
        dragState.originalObject.height + deltaLocalY,
        72,
        Math.max(72, next.sourceImage.height * 2),
      );
    }
  } else if (dragState.kind === "rotate") {
    const nextAngle = Math.atan2(
      point.y - dragState.center.y,
      point.x - dragState.center.x,
    );
    const deltaDegrees = (nextAngle - dragState.startAngle) * 180 / Math.PI;
    target.rotation = normalizeTransformSourceImageRotation(
      dragState.originalObject.rotation + deltaDegrees,
    );
  }

  return normalizeTransformDocumentForCommit(next, mode);
}

export function TransformWorkspaceDialog({
  open,
  onOpenChange,
  launchPayload,
  onExported,
}: TransformWorkspaceDialogProps) {
  const { t } = useTranslation("transform");
  const [mode, setMode] = React.useState<TransformMode>("edit");
  const modeRef = React.useRef<TransformMode>("edit");
  const [documentState, setDocumentState] = React.useState<TransformDocument | null>(null);
  const documentRef = React.useRef<TransformDocument | null>(null);
  const transformSessionKey = JSON.stringify([launchPayload?.imagePath, launchPayload?.initialMode, launchPayload?.workspaceProjectSlug, launchPayload?.workspaceFolder]);
  const captureSession = useTransformOperationScope(transformSessionKey, open);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [saveState, setSaveState] = React.useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [deliveryNotice, setDeliveryNotice] = React.useState<TransformDeliveryNotice | null>(null);
  const [activeTool, setActiveTool] = React.useState<TransformEditTool>("select");
  const [activeLetteringKind, setActiveLetteringKind] = React.useState<TransformTextObjectKind>("speech_bubble");
  const [selectedObjectId, setSelectedObjectId] = React.useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = React.useState<string | null>(null);
  const [editingObjectId, setEditingObjectId] = React.useState<string | null>(null);
  const [targetProjectSlug, setTargetProjectSlug] = React.useState<string>("");
  const [exportTargetFolder, setExportTargetFolder] = React.useState<string>("");
  const [maskTargetFolder, setMaskTargetFolder] = React.useState<string>("");
  const [numericDrafts, setNumericDrafts] = React.useState<Partial<Record<NumericInspectorField, string>>>({});
  const [cropNumericDrafts, setCropNumericDrafts] = React.useState<Partial<Record<NumericCropField, string>>>({});
  const [sourceRotationDraft, setSourceRotationDraft] = React.useState("0");
  const [paintColorDraft, setPaintColorDraft] = React.useState("#ef4444");
  const [paintHexDraft, setPaintHexDraft] = React.useState("#ef4444");
  const [colorDrafts, setColorDrafts] = React.useState<Partial<Record<ColorInspectorField, string>>>({});
  const [spacePressed, setSpacePressed] = React.useState(false);
  const [maskSurfaceState, setMaskSurfaceState] = React.useState<MaskCanvasSurfaceState>(DEFAULT_MASK_SURFACE_STATE);
  const [rightDockTab, setRightDockTab] = React.useState<TransformRightDockTab>("inspector");
  const [rightDockOpen, setRightDockOpen] = React.useState(true);
  const [exportSheetOpen, setExportSheetOpen] = React.useState(false);
  const [exportSheetComplete, setExportSheetComplete] = React.useState(false);
  const [maskSaveSheetOpen, setMaskSaveSheetOpen] = React.useState(false);
  const [exportFilename, setExportFilename] = React.useState("");
  const [exportSaveMode, setExportSaveMode] = React.useState<"new_copy" | "overwrite_current">("new_copy");
  const [rasterSelection, setRasterSelection] = React.useState<TransformRasterSelection | null>(null);
  const [rasterSelectionMoveOffset, setRasterSelectionMoveOffset] = React.useState({ x: 0, y: 0 });
  const [maskOperationRadius, setMaskOperationRadius] = React.useState(8);
  const [availableFontOptions, setAvailableFontOptions] = React.useState<string[]>(() =>
    buildTransformFontOptions(),
  );

  const lastSavedDocumentRef = React.useRef<TransformDocument | null>(null);
  const saveSequenceRef = React.useRef(0);
  const maskDraftSaveRef = React.useRef<Promise<void> | null>(null);
  const dragStateRef = React.useRef<DragState | null>(null);
  const pointerInteractionActiveRef = React.useRef(false);
  const editingDirtyRef = React.useRef(false);
  const editingHistoryStartRef = React.useRef<DragHistorySnapshot | null>(null);
  const colorDraftsRef = React.useRef<Partial<Record<ColorInspectorField, string>>>({});
  const maskSurfaceRef = React.useRef<MaskCanvasSurfaceHandle | null>(null);
  const launchImagePathRef = React.useRef<string | null>(null);
  const deliveryOperationRef = React.useRef<TransformDeliveryOperation>("new_copy");
  const paintColorDraftRef = React.useRef("#ef4444");
  const editCursorRef = React.useRef<HTMLDivElement | null>(null);
  const pixelBlockCursorRef = React.useRef<HTMLDivElement | null>(null);
  const decorationCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const previewCacheCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const previewRendererRef = React.useRef<TransformPreviewRenderer | null>(null);
  const previewTextureReadyRef = React.useRef(false);
  const previewLayoutsRef = React.useRef<CanvasObjectLayout[]>([]);
  const previewAdjustmentDraftRef = React.useRef<TransformDocument["edit"]["adjustments"] | null>(null);
  const skipDocumentSceneRenderRef = React.useRef<TransformDocument | null>(null);
  const silentAutosaveDocumentRef = React.useRef<TransformDocument | null>(null);
  const selectedObjectIdRef = React.useRef<string | null>(null);
  const selectedLayerIdRef = React.useRef<string | null>(null);
  const editingObjectIdRef = React.useRef<string | null>(null);
  const restoreSourceReloadPendingRef = React.useRef(false);
  const inlineEditorRef = React.useRef<HTMLTextAreaElement | null>(null);
  const imageLayerFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const rasterClipboardRef = React.useRef<Blob | null>(null);
  const rasterSamplingCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const rasterSceneCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const rasterCompositeCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const exportRequiresAlpha = Boolean(
    documentState?.edit.paintLayers.some((layer) => layer.role === "source_eraser"),
  );
  const exportSourceDocumentId = documentState?.id ?? null;
  const exportSourcePath = documentState?.sourceImage.path ?? null;
  const exportSourceFormat = documentState?.sourceImage.format ?? "png";
  const restoreHistorySnapshotRef = React.useRef((
    documentSnapshot: TransformDocument,
    selection: TransformHistorySelection,
    paintDiffs: TransformHistoryPaintDiff[] | undefined,
    side: "before" | "after",
  ) => {
    void documentSnapshot;
    void selection;
    void paintDiffs;
    void side;
    return Promise.resolve();
  });
  const renderCompositePreviewRef = React.useRef((options?: TransformCompositePreviewOptions) => {
    void options;
  });
  const handleWorkspaceInteractionChange = React.useCallback((active: boolean) => {
    pointerInteractionActiveRef.current = active;
  }, []);
  const editCanvasGeometry = React.useMemo(
    () => documentState ? getTransformCanvasGeometry(documentState) : null,
    [documentState],
  );
  const updateEditCursorPosition = React.useCallback((point: RasterPoint | null) => {
    const elements = [editCursorRef.current, pixelBlockCursorRef.current];
    if (!point) {
      for (const element of elements) {
        if (element) {
          element.style.display = "none";
        }
      }
      return;
    }
    const left = point.x + (editCanvasGeometry?.offsetX ?? 0);
    const top = point.y + (editCanvasGeometry?.offsetY ?? 0);
    const transform = `translate3d(${left}px, ${top}px, 0) translate(-50%, -50%)`;
    for (const element of elements) {
      if (element) {
        element.style.display = "block";
        element.style.transform = transform;
      }
    }
  }, [editCanvasGeometry?.offsetX, editCanvasGeometry?.offsetY]);
  const activeSurfaceGeometry = React.useMemo(() => {
    if (!documentState) {
      return null;
    }
    if (mode === "mask" && !documentState.edit.expansion) {
      return {
        width: documentState.sourceImage.width,
        height: documentState.sourceImage.height,
        offsetX: 0,
        offsetY: 0,
      };
    }
    return editCanvasGeometry
      ? {
        width: editCanvasGeometry.width,
        height: editCanvasGeometry.height,
        offsetX: editCanvasGeometry.offsetX,
        offsetY: editCanvasGeometry.offsetY,
      }
      : {
        width: documentState.sourceImage.width,
        height: documentState.sourceImage.height,
        offsetX: 0,
        offsetY: 0,
      };
  }, [documentState, editCanvasGeometry, mode]);
  const {
    sourceElement,
    setSourceElement,
    layouts,
    setLayouts,
    fitScale,
    fitReady,
    setFitReady,
    setFitRevision,
    sourceLoadRevision,
    setSourceLoadRevision,
    zoom,
    setZoom,
    pan,
    setPan,
    surfaceScale,
    paintCanvasCacheRef,
    imageLayerImageCacheRef,
    pendingPaintLayerFilesRef,
    dirtyPaintLayerIdsRef,
    viewportRef,
    setViewportNode,
    setViewportModeManual,
    transformedSurfaceRef,
    canvasRef,
    refreshViewportLayout,
    resetViewportState,
    handleFitToViewport,
    convertPointerToSource,
  } = useTransformCanvasRuntime({
    open,
    documentState,
    surfaceGeometry: activeSurfaceGeometry,
    renderCompositePreviewRef,
  });
  const localizedZoomLabel = formatLocalizedNumber(surfaceScale, {
    style: "percent",
    maximumFractionDigits: 0,
  });

  const getLetteringShapeLabel = React.useCallback((kind: TransformTextObjectKind): string => {
    switch (kind) {
      case "speech_bubble":
        return t("lettering.shapes.speechBubble");
      case "thought_bubble":
        return t("lettering.shapes.thoughtBubble");
      case "narration_box":
        return t("lettering.shapes.narrationRounded");
      case "narration_rect":
        return t("lettering.shapes.narrationSharp");
      case "burst_jagged":
        return t("lettering.shapes.burstJagged");
      case "burst_wavy":
        return t("lettering.shapes.burstWavy");
      case "free_text":
        return t("lettering.shapes.freeText");
    }
  }, [t]);

  const getLetteringDefaultText = React.useCallback((kind: TransformTextObjectKind): string => {
    switch (kind) {
      case "speech_bubble":
        return t("lettering.defaults.speechBubble");
      case "thought_bubble":
        return t("lettering.defaults.thoughtBubble");
      case "narration_box":
      case "narration_rect":
        return t("lettering.defaults.narration");
      case "burst_jagged":
        return t("lettering.defaults.burstJagged");
      case "burst_wavy":
        return t("lettering.defaults.burstWavy");
      case "free_text":
        return t("lettering.defaults.freeText");
    }
  }, [t]);

  const getToolLabel = (tool: TransformEditTool | MaskTool): string => {
    switch (tool) {
      case "select":
        return t("tools.select");
      case "rect_select":
        return t("tools.rectSelect");
      case "select_by_color":
        return t("tools.selectByColor");
      case "pan":
        return t("tools.pan");
      case "lettering":
        return t("tools.lettering");
      case "pencil":
        return t("tools.pencil");
      case "brush":
        return t("tools.brush");
      case "eraser":
        return t("tools.eraser");
      case "fill_bucket":
        return t("tools.fillBucket");
      case "eyedropper":
        return t("tools.sample");
      case "smudge":
        return t("tools.smudge");
      case "pixelate":
        return t("tools.pixelate");
      case "crop":
        return t("tools.crop");
      case "add":
        return t("tools.maskAdd");
      case "subtract":
        return t("tools.maskSubtract");
      case "rectangle":
        return t("tools.rectangle");
      case "lasso":
        return t("tools.lasso");
      case "fill":
        return t("tools.maskFill");
    }
  };

  const getTextPositionLabel = (
    horizontal: TextBoxHorizontalPosition,
    vertical: TextBoxVerticalPosition,
  ): string => {
    if (vertical === "top") {
      if (horizontal === "left") return t("text.positions.topLeft");
      if (horizontal === "right") return t("text.positions.topRight");
      return t("text.positions.top");
    }
    if (vertical === "bottom") {
      if (horizontal === "left") return t("text.positions.bottomLeft");
      if (horizontal === "right") return t("text.positions.bottomRight");
      return t("text.positions.bottom");
    }
    if (horizontal === "left") return t("text.positions.left");
    if (horizontal === "right") return t("text.positions.right");
    return t("text.positions.center");
  };

  const effectiveSaveState =
    mode === "mask" && maskSurfaceState.draftState !== "saved"
      ? maskSurfaceState.draftState === "error"
        ? "error"
        : "saving"
      : saveState;
  const localizedSaveState = effectiveSaveState === "saved"
    ? t("saveStatus.saved")
    : effectiveSaveState === "saving"
      ? t("saveStatus.saving")
      : effectiveSaveState === "dirty"
        ? t("saveStatus.saving")
        : t("saveStatus.error");
  const saveStateTooltip = effectiveSaveState === "saved"
    ? t("saveStatus.savedTooltip")
    : effectiveSaveState === "error"
      ? t("saveStatus.errorTooltip")
      : t("saveStatus.savingTooltip");
  const localizedDeliveryMessage = deliveryNotice
    ? deliveryNotice.operation === "overwrite_current"
      ? t("delivery.overwrote", { filename: deliveryNotice.filename })
      : deliveryNotice.operation === "mask"
        ? deliveryNotice.folder
          ? t("delivery.maskSavedToFolder", {
            filename: deliveryNotice.filename,
            folder: deliveryNotice.folder,
          })
          : t("delivery.maskSaved", { filename: deliveryNotice.filename })
        : t("delivery.exported", { filename: deliveryNotice.filename })
    : null;
  const sourceImageUrlVersion = React.useMemo(() => {
    if (!documentState) {
      return null;
    }
    return `${documentState.sourceImage.hash || ""}:${sourceLoadRevision}`;
  }, [documentState, sourceLoadRevision]);
  const {
    interactionDraftDocumentRef,
    scheduleCompositePreview,
  } = useTransformInteractionPreview(renderCompositePreviewRef);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const refreshAvailableFonts = async () => {
      try {
        const response = await api.getTransformFonts();
        const loadedUserFontNames = await loadManagedTransformFonts(response.fonts || []);
        if (!cancelled) {
          setAvailableFontOptions(
            buildTransformFontOptions(
              (response.fonts || []).filter((font) => loadedUserFontNames.includes(font.name)),
            ),
          );
        }
      } catch {
        if (!cancelled) {
          setAvailableFontOptions(buildTransformFontOptions());
        }
      }
    };

    void refreshAvailableFonts();
    window.addEventListener(TRANSFORM_FONTS_UPDATED_EVENT, refreshAvailableFonts);
    return () => {
      cancelled = true;
      window.removeEventListener(TRANSFORM_FONTS_UPDATED_EVENT, refreshAvailableFonts);
    };
  }, [open]);

  React.useEffect(() => {
    modeRef.current = mode;
    setRightDockTab(mode === "mask" ? "mask" : "inspector");
  }, [mode]);

  React.useEffect(() => {
    if (!open) {
      setDeliveryNotice(null);
    }
  }, [open]);

  React.useEffect(() => {
    documentRef.current = documentState;
  }, [documentState]);

  React.useEffect(() => {
    if (!exportSourcePath) {
      setExportFilename("");
      return;
    }
    const displayName = buildDisplayName(exportSourcePath);
    const stem = displayName.replace(/\.[^.]+$/, "");
    const extension = exportRequiresAlpha ? "png" : exportSourceFormat;
    setExportFilename(`${stem}_transform.${extension}`);
  }, [
    exportRequiresAlpha,
    exportSourceDocumentId,
    exportSourceFormat,
    exportSourcePath,
  ]);

  React.useEffect(() => {
    if (sourceElement) {
      restoreSourceReloadPendingRef.current = false;
    }
  }, [sourceElement]);

  React.useEffect(() => {
    selectedObjectIdRef.current = selectedObjectId;
  }, [selectedObjectId]);

  React.useEffect(() => {
    selectedLayerIdRef.current = selectedLayerId;
  }, [selectedLayerId]);

  React.useEffect(() => {
    editingObjectIdRef.current = editingObjectId;
  }, [editingObjectId]);

  const sourceProjectSlug = documentState?.project.slug || "";
  const selectedProject = React.useMemo(() => {
    const effectiveProjectSlug = targetProjectSlug || sourceProjectSlug;
    return projects.find((project) => project.slug === effectiveProjectSlug) || null;
  }, [projects, sourceProjectSlug, targetProjectSlug]);

  const availableFolders = React.useMemo(() => buildAvailableTransformFolders(
    selectedProject?.config_json?.folders,
    Boolean(selectedProject || targetProjectSlug || sourceProjectSlug),
  ), [selectedProject, sourceProjectSlug, targetProjectSlug]);
  const currentObject = React.useMemo(
    () =>
      documentState?.edit.textObjects.find((object) => object.id === selectedObjectId) || null,
    [documentState, selectedObjectId],
  );

  const currentLayer = React.useMemo(
    () => documentState?.edit.layers.find((layer) => layer.id === selectedLayerId) || null,
    [documentState, selectedLayerId],
  );

  const currentPaintLayer = React.useMemo(
    () => currentLayer?.kind === "paint_layer"
      ? documentState?.edit.paintLayers.find((layer) => layer.id === currentLayer.refId) || null
      : null,
    [currentLayer, documentState],
  );

  const currentImageLayer = React.useMemo(
    () => currentLayer?.kind === "image_layer"
      ? documentState?.edit.imageLayers.find((layer) => layer.id === currentLayer.refId) || null
      : null,
    [currentLayer, documentState],
  );

  const currentLayout = React.useMemo(
    () => layouts.find((layout) => layout.objectId === selectedObjectId) || null,
    [layouts, selectedObjectId],
  );
  const currentCanvasLayout = React.useMemo(
    () => currentLayout && editCanvasGeometry
      ? offsetTransformObjectLayout(currentLayout, editCanvasGeometry.offsetX, editCanvasGeometry.offsetY)
      : null,
    [currentLayout, editCanvasGeometry],
  );
  const handleMetrics = React.useMemo(
    () => getTransformHandleMetrics(surfaceScale),
    [surfaceScale],
  );
  const currentRotationHandle = React.useMemo(
    () => currentCanvasLayout
      ? rotatePoint(
        {
          x: currentCanvasLayout.center.x,
          y: currentCanvasLayout.bounds.y - handleMetrics.rotationHandleOffset,
        },
        currentCanvasLayout.center,
        currentCanvasLayout.rotation,
      )
      : null,
    [currentCanvasLayout, handleMetrics.rotationHandleOffset],
  );
  const currentSourceImageTransform = React.useMemo(
    () => documentState?.edit.sourceImageTransform ?? defaultTransformSourceImageTransform(),
    [documentState],
  );
  const currentTextOverflow = React.useMemo(() => {
    if (!currentObject) {
      return false;
    }
    const geometry = getTextBoxSafeGeometry(currentObject);
    const metrics = getTextContentMetrics(currentObject, geometry, currentLayout);
    return (
      metrics.width > geometry.innerWidth + 0.5 ||
      metrics.height > geometry.innerHeight + 0.5
    );
  }, [currentLayout, currentObject]);

  React.useEffect(() => {
    if (!currentObject) {
      setNumericDrafts({});
      setColorDrafts({});
      colorDraftsRef.current = {};
      return;
    }
    setNumericDrafts(
      Object.fromEntries(
        NUMERIC_INSPECTOR_FIELDS.map((field) => [field, formatNumericDraft(currentObject[field])]),
      ),
    );
    const nextColorDrafts = {
      textColor: currentObject.textColor,
      fillColor: currentObject.fillColor === "rgba(255,255,255,0)" ? "#ffffff" : currentObject.fillColor,
      strokeColor: currentObject.strokeColor,
    };
    setActiveLetteringKind(currentObject.kind);
    colorDraftsRef.current = nextColorDrafts;
    setColorDrafts(nextColorDrafts);
  }, [currentObject]);

  React.useEffect(() => {
    if (!documentState) {
      setCropNumericDrafts({});
      setSourceRotationDraft("0");
      return;
    }
    setPaintColorDraft(documentState.edit.paintSettings.activeColor);
    setPaintHexDraft(documentState.edit.paintSettings.activeColor);
    paintColorDraftRef.current = documentState.edit.paintSettings.activeColor;
    setCropNumericDrafts(
      Object.fromEntries(
        NUMERIC_CROP_FIELDS.map((field) => [field, formatNumericDraft(documentState.edit.crop[field])]),
      ),
    );
    setSourceRotationDraft(formatNumericDraft(documentState.edit.sourceImageTransform.rotationDegrees));
  }, [documentState?.edit.crop, documentState?.edit.paintSettings, documentState]);

  const renderCompositePreview = React.useCallback(
    (options?: TransformCompositePreviewOptions) => {
      const previewStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      const current = interactionDraftDocumentRef.current ?? documentRef.current;
      const canvas = canvasRef.current;
      const decorationCanvas = decorationCanvasRef.current;
      if (!current || !sourceElement || !canvas || !decorationCanvas) {
        return;
      }
      const nextGeometry = getTransformCanvasGeometry(current);
      const previewScale = Math.min(
        1,
        Math.max(1 / 16, surfaceScale * (window.devicePixelRatio || 1)),
      );
      const previewWidth = Math.max(1, Math.round(nextGeometry.width * previewScale));
      const previewHeight = Math.max(1, Math.round(nextGeometry.height * previewScale));
      let resized = false;
      if (canvas.width !== previewWidth) {
        canvas.width = previewWidth;
        resized = true;
      }
      if (canvas.height !== previewHeight) {
        canvas.height = previewHeight;
        resized = true;
      }
      if (decorationCanvas.width !== previewWidth) {
        decorationCanvas.width = previewWidth;
      }
      if (decorationCanvas.height !== previewHeight) {
        decorationCanvas.height = previewHeight;
      }
      const decorationContext = decorationCanvas.getContext("2d");
      if (!decorationContext) {
        return;
      }
      let previewRenderer = previewRendererRef.current;
      if (!previewRenderer) {
        previewRenderer = createTransformPreviewRenderer(canvas);
        previewRendererRef.current = previewRenderer;
      }
      if (resized) {
        previewTextureReadyRef.current = false;
        previewRenderer?.resize(previewWidth, previewHeight);
      }
      let previewCache = previewCacheCanvasRef.current;
      if (!previewCache) {
        previewCache = window.document.createElement("canvas");
        previewCacheCanvasRef.current = previewCache;
      }
      if (previewCache.width !== previewWidth) {
        previewCache.width = previewWidth;
        resized = true;
      }
      if (previewCache.height !== previewHeight) {
        previewCache.height = previewHeight;
        resized = true;
      }
      const cacheContext = previewCache.getContext("2d", {
        willReadFrequently: true,
      });
      if (!cacheContext) {
        return;
      }
      // The editable raster assets remain source-sized. The visible compositor
      // only needs enough backing pixels for the current viewport/zoom; drawing
      // every 4K source pixel on every pointer frame made the preview—not the
      // raster tool itself—the interaction bottleneck.
      const paintLayerImagesForRender = new Map<string, CanvasImageSource>();
      for (const [layerId, paintCanvas] of paintCanvasCacheRef.current) {
        paintLayerImagesForRender.set(layerId, paintCanvas);
      }
      const imageLayerImagesForRender = new Map<string, CanvasImageSource>();
      for (const [layerId, image] of imageLayerImageCacheRef.current) {
        imageLayerImagesForRender.set(layerId, image);
      }

      const rebuildScene = resized || !options?.compositeOnly;
      let nextLayouts = previewLayoutsRef.current;
      let dirtyPixelBounds: RasterBounds | null = null;
      if (rebuildScene) {
        const dirtySourceBounds = !resized ? options?.dirtySourceBounds : null;
        const clipBounds = dirtySourceBounds
          ? {
            x: nextGeometry.offsetX + dirtySourceBounds.x - 2,
            y: nextGeometry.offsetY + dirtySourceBounds.y - 2,
            width: dirtySourceBounds.width + 4,
            height: dirtySourceBounds.height + 4,
          }
          : undefined;
        cacheContext.setTransform(previewScale, 0, 0, previewScale, 0, 0);
        nextLayouts = drawTransformDocument(
          cacheContext,
          sourceElement,
          current,
          null,
          {
            skipTextObjectId: editingObjectId,
            paintLayerImages: paintLayerImagesForRender,
            imageLayerImages: imageLayerImagesForRender,
            applyAdjustments: false,
            clear: true,
            clipBounds,
            renderDecorations: false,
          },
        );
        cacheContext.setTransform(1, 0, 0, 1, 0, 0);
        if (clipBounds) {
          const x = clamp(Math.floor(clipBounds.x * previewScale), 0, previewWidth);
          const y = clamp(Math.floor(clipBounds.y * previewScale), 0, previewHeight);
          const right = clamp(
            Math.ceil((clipBounds.x + clipBounds.width) * previewScale),
            0,
            previewWidth,
          );
          const bottom = clamp(
            Math.ceil((clipBounds.y + clipBounds.height) * previewScale),
            0,
            previewHeight,
          );
          if (right > x && bottom > y) {
            dirtyPixelBounds = {
              x,
              y,
              width: right - x,
              height: bottom - y,
            };
          }
        }
        previewLayoutsRef.current = nextLayouts;
        if (options?.updateLayouts !== false) {
          setLayouts(nextLayouts);
        }
      }

      const adjustments =
        previewAdjustmentDraftRef.current ?? current.edit.adjustments;
      if (previewRenderer) {
        if (rebuildScene) {
          if (dirtyPixelBounds && previewTextureReadyRef.current) {
            const dirtyPixels = cacheContext.getImageData(
              dirtyPixelBounds.x,
              dirtyPixelBounds.y,
              dirtyPixelBounds.width,
              dirtyPixelBounds.height,
            );
            recordRasterDiagnostics({
              getImageDataCalls: 1,
              getImageDataBytes: dirtyPixelBounds.width * dirtyPixelBounds.height * 4,
            });
            previewRenderer.uploadRegion(
              dirtyPixels.data,
              dirtyPixelBounds.x,
              dirtyPixelBounds.y,
              dirtyPixelBounds.width,
              dirtyPixelBounds.height,
            );
          } else {
            previewRenderer.uploadFull(previewCache);
            previewTextureReadyRef.current = true;
          }
        }
        previewRenderer.draw(adjustments);
      } else {
        const context = canvas.getContext("2d");
        if (!context) {
          return;
        }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, previewWidth, previewHeight);
        context.save();
        context.filter = `brightness(${adjustments.brightness}) contrast(${adjustments.contrast}) saturate(${adjustments.saturation}) hue-rotate(${adjustments.hueDegrees}deg)`;
        context.drawImage(previewCache, 0, 0);
        context.restore();
      }
      if (rebuildScene) {
        decorationContext.setTransform(1, 0, 0, 1, 0, 0);
        decorationContext.clearRect(0, 0, previewWidth, previewHeight);
        decorationContext.setTransform(previewScale, 0, 0, previewScale, 0, 0);
        drawTransformDocumentDecorations(
          decorationContext,
          current,
          nextLayouts,
          selectedObjectId,
          {
            renderCropOverlay: activeTool === "crop" || current.edit.crop.enabled,
          },
        );
        decorationContext.setTransform(1, 0, 0, 1, 0, 0);
      }
      recordRasterDiagnostics({
        previewTimeMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - previewStartedAt,
      });
    },
    [
      activeTool,
      canvasRef,
      editingObjectId,
      interactionDraftDocumentRef,
      imageLayerImageCacheRef,
      paintCanvasCacheRef,
      selectedObjectId,
      setLayouts,
      sourceElement,
      surfaceScale,
    ],
  );

  React.useEffect(() => {
    renderCompositePreviewRef.current = renderCompositePreview;
  }, [renderCompositePreview]);

  React.useEffect(() => {
    if (!open) {
      return undefined;
    }

    let previewFrame: number | null = null;
    const scheduleRestorePreview = () => {
      if (previewFrame != null) {
        window.cancelAnimationFrame(previewFrame);
      }
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = null;
        renderCompositePreviewRef.current({ updateLayouts: true });
      });
    };
    const restoreVisibleSurface = () => {
      if (document.visibilityState !== "visible" || !documentRef.current) {
        return;
      }
      if (!sourceElement) {
        if (!restoreSourceReloadPendingRef.current) {
          restoreSourceReloadPendingRef.current = true;
          setFitReady(false);
          setSourceLoadRevision((revision) => revision + 1);
        }
        return;
      }
      restoreSourceReloadPendingRef.current = false;
      refreshViewportLayout();
      if (modeRef.current === "edit") {
        scheduleRestorePreview();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        restoreVisibleSurface();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", restoreVisibleSurface);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", restoreVisibleSurface);
      if (previewFrame != null) {
        window.cancelAnimationFrame(previewFrame);
      }
    };
  }, [
    open,
    refreshViewportLayout,
    setFitReady,
    setSourceLoadRevision,
    sourceElement,
  ]);

  const getCurrentHistorySelection = React.useCallback((): TransformHistorySelection => ({
    selectedObjectId: selectedObjectIdRef.current,
    selectedLayerId: selectedLayerIdRef.current,
    editingObjectId: editingObjectIdRef.current,
  }), []);

  const {
    historyState,
    canUndo,
    canRedo,
    pushHistoryEntry,
    pushHistory,
    resetHistory,
    applyHistoryStep,
    applyHistoryStepRef,
  } = useTransformHistory({
    getCurrentHistorySelection,
    restoreHistorySnapshotRef,
    observeHistoryState: rightDockTab === "history",
  });
  const pendingPaintHistoryCommitsRef = React.useRef<
    Array<Parameters<typeof pushHistoryEntry>[0]>
  >([]);
  const pendingPaintHistoryTimerRef = React.useRef<number | null>(null);
  const flushPendingPaintHistory = React.useCallback(() => {
    pendingPaintHistoryTimerRef.current = null;
    const pending = pendingPaintHistoryCommitsRef.current.splice(0);
    if (!pending.length) {
      return;
    }
    for (const entry of pending) {
      pushHistoryEntry(entry);
    }
  }, [pushHistoryEntry]);
  const enqueuePaintHistoryCommit = React.useCallback((
    entry: Parameters<typeof pushHistoryEntry>[0],
  ) => {
    pendingPaintHistoryCommitsRef.current.push(entry);
    if (pendingPaintHistoryTimerRef.current != null) {
      return;
    }
    pendingPaintHistoryTimerRef.current = window.setTimeout(
      flushPendingPaintHistory,
      0,
    );
  }, [flushPendingPaintHistory]);
  const {
    launchLoading,
    launchError,
    loadLaunch,
  } = useTransformLaunchSession({
    open,
    launchPayload,
    documentRef,
    launchImagePathRef,
    lastSavedDocumentRef,
    setDocumentState,
    resetHistory,
    setSaveState,
    setTargetProjectSlug,
    setExportTargetFolder,
    setMaskTargetFolder,
    setMode,
    setSelectedLayerId,
    setSelectedObjectId,
    setEditingObjectId,
    setActiveTool,
    setProjects,
    setSourceElement,
    setSourceLoadRevision,
    setFitReady,
    setFitRevision,
    resetViewportState,
  });

  const captureDragHistory = React.useCallback((): DragHistorySnapshot | null => {
    const current = documentRef.current;
    if (!current) {
      return null;
    }
    return {
      beforeDocument: cloneTransformDocument(current),
      beforeSelection: getCurrentHistorySelection(),
    };
  }, [getCurrentHistorySelection]);

  const replaceDocument = React.useCallback(
    (
      nextDocument: TransformDocument,
      options?: {
        pushHistory?: boolean;
        beforeDocument?: TransformDocument | null;
        beforeSelection?: TransformHistorySelection;
        afterSelection?: TransformHistorySelection;
        paintDiffs?: TransformHistoryPaintDiff[];
        label?: string;
        affectedLayerIds?: string[];
        reusePreview?: boolean;
        silentAutosave?: boolean;
      },
    ) => {
      const beforeDocument = options?.beforeDocument ?? (documentRef.current ? cloneTransformDocument(documentRef.current) : null);
      const beforeSelection = options?.beforeSelection ?? getCurrentHistorySelection();
      if (options?.reusePreview) {
        skipDocumentSceneRenderRef.current = nextDocument;
      }
      if (options?.silentAutosave) {
        silentAutosaveDocumentRef.current = nextDocument;
      }
      documentRef.current = nextDocument;
      const publishDocument = () => {
        setDocumentState(nextDocument);
        if (options?.pushHistory !== false && beforeDocument) {
          pushHistory(nextDocument, {
            beforeDocument,
            beforeSelection,
            afterSelection: options?.afterSelection,
            paintDiffs: options?.paintDiffs,
            label: options?.label,
            affectedLayerIds: options?.affectedLayerIds,
          });
        }
      };
      if (options?.reusePreview) {
        React.startTransition(publishDocument);
      } else {
        publishDocument();
      }
    },
    [getCurrentHistorySelection, pushHistory],
  );

  const applyDocumentMutation = React.useCallback(
    (
      mutate: (document: TransformDocument) => TransformDocument,
      options?: {
        pushHistory?: boolean;
        label?: string;
        affectedLayerIds?: string[];
        reusePreview?: boolean;
        silentAutosave?: boolean;
      },
    ): TransformDocument | null => {
      const current = documentRef.current;
      if (!current) {
        return null;
      }
      const next = mutate(cloneTransformDocument(current));
      normalizeTransformDocumentForCommit(next, modeRef.current);
      replaceDocument(
        next,
        options?.pushHistory === false
          ? {
            ...options,
            silentAutosave: options.silentAutosave ?? true,
          }
          : options,
      );
      return next;
    },
    [replaceDocument],
  );

  const previewAdjustment = React.useCallback((
    key: TransformAdjustmentKey,
    value: number,
  ) => {
    const current = documentRef.current;
    if (!current) {
      return;
    }
    previewAdjustmentDraftRef.current = {
      ...(previewAdjustmentDraftRef.current ?? current.edit.adjustments),
      [key]: value,
    };
    scheduleCompositePreview({
      updateLayouts: false,
      compositeOnly: true,
    });
  }, [scheduleCompositePreview]);

  const commitAdjustment = React.useCallback((
    key: TransformAdjustmentKey,
    value: number,
  ) => {
    previewAdjustmentDraftRef.current = null;
    const currentValue = documentRef.current?.edit.adjustments[key];
    if (currentValue === value) {
      scheduleCompositePreview({
        updateLayouts: false,
        compositeOnly: true,
      });
      return;
    }
    applyDocumentMutation((current) => {
      current.edit.adjustments[key] = value;
      return current;
    }, {
      label: "Adjust image",
      reusePreview: true,
      silentAutosave: true,
    });
  }, [applyDocumentMutation, scheduleCompositePreview]);

  const nudgeSelectedObject = React.useCallback((deltaX: number, deltaY: number) => {
    if (!selectedObjectId || (deltaX === 0 && deltaY === 0)) {
      return;
    }
    applyDocumentMutation((current) => {
      const layer = current.edit.layers.find((candidate) => candidate.refId === selectedObjectId);
      if (layer?.kind === "image_layer") {
        const imageLayer = current.edit.imageLayers.find((candidate) => candidate.id === selectedObjectId);
        if (!imageLayer || layer.locked) {
          return current;
        }
        imageLayer.x = roundOffset(imageLayer.x + deltaX);
        imageLayer.y = roundOffset(imageLayer.y + deltaY);
        imageLayer.updatedAt = new Date().toISOString();
        return current;
      }
      const target = current.edit.textObjects.find((object) => object.id === selectedObjectId);
      if (!target || layer?.locked) {
        return current;
      }
      target.x = roundOffset(target.x + deltaX);
      target.y = roundOffset(target.y + deltaY);
      if (target.tailX != null) {
        target.tailX = roundOffset(target.tailX + deltaX);
      }
      if (target.tailY != null) {
        target.tailY = roundOffset(target.tailY + deltaY);
      }
      return current;
    });
  }, [applyDocumentMutation, selectedObjectId]);

  const updatePaintColorDraft = React.useCallback((color: string) => {
    const nextColor = color.toLowerCase();
    paintColorDraftRef.current = nextColor;
    setPaintColorDraft(nextColor);
    setPaintHexDraft(nextColor);
  }, []);

  const commitPaintColor = React.useCallback((color: string, options?: { pushHistory?: boolean }) => {
    const trimmed = color.trim();
    if (!/^#[0-9a-f]{6}$/i.test(trimmed)) {
      return false;
    }
    const nextColor = trimmed.toLowerCase();
    updatePaintColorDraft(nextColor);
    const currentSettings = documentRef.current?.edit.paintSettings;
    if (
      currentSettings?.activeColor.toLowerCase() === nextColor &&
      currentSettings.recentColors[0]?.toLowerCase() === nextColor
    ) {
      return true;
    }
    applyDocumentMutation((current) => {
      addRecentColor(current.edit.paintSettings, nextColor);
      return current;
    }, options);
    return true;
  }, [applyDocumentMutation, updatePaintColorDraft]);

  const updateSourceImageTransform = React.useCallback(
    (
      mutate: (transform: TransformDocument["edit"]["sourceImageTransform"]) => void,
      options?: { pushHistory?: boolean },
    ) => applyDocumentMutation((current) => {
      mutate(current.edit.sourceImageTransform);
      current.edit.sourceImageTransform.rotationDegrees = normalizeTransformSourceImageRotation(
        current.edit.sourceImageTransform.rotationDegrees,
      );
      return current;
    }, options),
    [applyDocumentMutation],
  );

  const setSourceRotationDegrees = React.useCallback((rotationDegrees: number, options?: { pushHistory?: boolean }) => {
    updateSourceImageTransform((transform) => {
      transform.rotationDegrees = normalizeTransformSourceImageRotation(rotationDegrees);
    }, options);
  }, [updateSourceImageTransform]);

  const nudgeSourceRotationDegrees = React.useCallback((deltaDegrees: number) => {
    updateSourceImageTransform((transform) => {
      transform.rotationDegrees = normalizeTransformSourceImageRotation(transform.rotationDegrees + deltaDegrees);
    });
  }, [updateSourceImageTransform]);

  const toggleSourceFlip = React.useCallback((field: "flipHorizontal" | "flipVertical") => {
    updateSourceImageTransform((transform) => {
      transform[field] = !transform[field];
    });
  }, [updateSourceImageTransform]);

  const resetSourceImageTransform = React.useCallback(() => {
    updateSourceImageTransform((transform) => {
      Object.assign(transform, defaultTransformSourceImageTransform());
    });
  }, [updateSourceImageTransform]);

  React.useEffect(() => {
    if (!fitReady) {
      return;
    }
    if (skipDocumentSceneRenderRef.current === documentState) {
      skipDocumentSceneRenderRef.current = null;
      return;
    }
    scheduleCompositePreview({ updateLayouts: true });
  }, [documentState, fitReady, scheduleCompositePreview]);

  React.useEffect(() => {
    if (!open || !editingObjectId || currentLayout?.objectId !== editingObjectId) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      const editor = inlineEditorRef.current;
      if (!editor) {
        return;
      }
      editor.focus();
      const end = editor.value.length;
      editor.setSelectionRange(end, end);
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [currentLayout?.objectId, editingObjectId, open]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTransformTextEditingTarget(event.target)) {
        return;
      }
      if (event.key === " ") {
        setSpacePressed(true);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
      ) {
        event.preventDefault();
        const redo = event.key.toLowerCase() === "y" || event.shiftKey;
        if (modeRef.current === "mask") {
          if (redo) {
            maskSurfaceRef.current?.redo();
          } else {
            maskSurfaceRef.current?.undo();
          }
          return;
        }
        applyHistoryStepRef.current(redo ? "redo" : "undo");
        return;
      }
      if (
        (event.key === "[" || event.key === "]") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const direction = event.key === "]" ? 1 : -1;
        if (modeRef.current === "mask") {
          maskSurfaceRef.current?.setBrushSize(
            maskSurfaceState.brushSize + direction * Math.max(1, Math.round(maskSurfaceState.brushSize * 0.1)),
          );
          return;
        }
        applyDocumentMutation((current) => {
          if (activeTool === "pencil") {
            current.edit.paintSettings.pencilThicknessPx = clamp(
              current.edit.paintSettings.pencilThicknessPx + direction * 2,
              1,
              512,
            );
          } else if (activeTool === "brush") {
            current.edit.paintSettings.brushThicknessPx = clamp(
              current.edit.paintSettings.brushThicknessPx + direction * 4,
              1,
              512,
            );
          } else if (activeTool === "eraser") {
            current.edit.paintSettings.eraserThicknessPx = clamp(
              current.edit.paintSettings.eraserThicknessPx + direction * 4,
              1,
              512,
            );
          } else if (activeTool === "smudge") {
            current.edit.retouchSettings.smudge.sizePx = clamp(
              current.edit.retouchSettings.smudge.sizePx + direction * 4,
              1,
              512,
            );
          } else if (activeTool === "pixelate") {
            current.edit.retouchSettings.pixelate.brushSizePx = clamp(
              current.edit.retouchSettings.pixelate.brushSizePx + direction * 8,
              1,
              1024,
            );
          }
          return current;
        }, { pushHistory: false });
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const registeredTool = resolveTransformShortcut(modeRef.current, event.key);
        if (registeredTool) {
          event.preventDefault();
          if (modeRef.current === "mask") {
            maskSurfaceRef.current?.setTool(registeredTool.id as MaskTool);
          } else {
            const nextTool = registeredTool.id as TransformEditTool;
            setActiveTool(nextTool);
            applyDocumentMutation((current) => {
              current.edit.lastUsedTool = nextTool;
              return current;
            }, { pushHistory: false });
            setEditingObjectId(null);
          }
          return;
        }
      }
      const nudge = OBJECT_NUDGE_BY_KEY[event.key];
      if (
        nudge &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        selectedObjectId &&
        editingObjectId == null &&
        modeRef.current === "edit" &&
        !isTransformNudgeShortcutTarget(event.target)
      ) {
        event.preventDefault();
        const step = event.shiftKey ? TRANSFORM_ACCELERATED_NUDGE_PX : 1;
        nudgeSelectedObject(nudge.x * step, nudge.y * step);
        return;
      }
      if (
        event.key === "Delete" &&
        selectedObjectId &&
        !rasterSelection &&
        editingObjectId == null &&
        modeRef.current === "edit"
      ) {
        event.preventDefault();
        const selectedLayer = documentRef.current!.edit.layers.find(
          (layer) => layer.refId === selectedObjectId,
        );
        const next = selectedLayer
          ? deleteTransformLayer(documentRef.current!, selectedLayer.id)
          : deleteTransformObject(documentRef.current!, selectedObjectId);
        replaceDocument(next, {
          afterSelection: {
            selectedObjectId: null,
            selectedLayerId: null,
            editingObjectId: null,
          },
        });
        setSelectedObjectId(null);
        setSelectedLayerId(null);
      }
      if (event.key === "Escape") {
        setActiveTool("select");
        setEditingObjectId(null);
      }
      if (event.key === "Enter" && selectedObjectId && editingObjectId == null && modeRef.current === "edit") {
        event.preventDefault();
        setEditingObjectId(selectedObjectId);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") {
        setSpacePressed(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    activeTool,
    applyDocumentMutation,
    applyHistoryStepRef,
    editingObjectId,
    maskSurfaceState.brushSize,
    nudgeSelectedObject,
    open,
    replaceDocument,
    rasterSelection,
    selectedObjectId,
  ]);

  const ensureActivePaintLayer = React.useCallback(async (): Promise<{ document: TransformDocument; layer: TransformPaintLayer; layerEntry: TransformLayer } | null> => {
    const current = documentRef.current;
    if (!current) {
      return null;
    }
    const getLayerPaint = (layer: TransformLayer | null | undefined) =>
      layer?.kind === "paint_layer"
        ? current.edit.paintLayers.find((candidate) => candidate.id === layer.refId) || null
        : null;
    const selectedLayer = selectedLayerId
      ? current.edit.layers.find((layer) => layer.id === selectedLayerId && layer.kind === "paint_layer")
      : null;
    const selectedPaintLayer = getLayerPaint(selectedLayer);
    const targetRole: NonNullable<TransformPaintLayer["role"]> =
      activeTool === "smudge" || activeTool === "pixelate"
        ? "retouch"
        : activeTool === "eraser" && current.edit.paintSettings.eraserTarget === "source"
          ? "source_eraser"
          : activeTool === "eraser" && selectedPaintLayer
            ? getPaintLayerRole(selectedPaintLayer)
            : "paint";
    if (selectedLayer && selectedPaintLayer && getPaintLayerRole(selectedPaintLayer) === targetRole && (!selectedLayer.visible || selectedLayer.locked)) {
      return null;
    }
    let layerEntry =
      selectedLayer && selectedPaintLayer && getPaintLayerRole(selectedPaintLayer) === targetRole
        ? selectedLayer
        : current.edit.layers.find((layer) => {
          if (layer.kind !== "paint_layer" || !layer.visible || layer.locked) {
            return false;
          }
          const candidate = getLayerPaint(layer);
          return Boolean(candidate && getPaintLayerRole(candidate) === targetRole);
        });
    let paintLayer = getLayerPaint(layerEntry);
    let nextDocument = current;
    if (!layerEntry || !paintLayer) {
      paintLayer = createTransformPaintLayer(current.sourceImage, targetRole);
      layerEntry = createTransformPaintLayerEntry(paintLayer, current.edit.layers.length);
      nextDocument = cloneTransformDocument(current);
      nextDocument.edit.paintLayers.push(paintLayer);
      nextDocument.edit.layers.push(layerEntry);
      nextDocument.edit.lastUsedTool = activeTool;
      nextDocument.text.objects = nextDocument.edit.textObjects;
      nextDocument.text.layers = nextDocument.edit.layers.filter((layer) => layer.kind === "text_object");
      replaceDocument(nextDocument, { pushHistory: false });
      setSelectedLayerId(layerEntry.id);
      setSelectedObjectId(null);
    }

    if (layerEntry.locked || !layerEntry.visible) {
      return null;
    }
    if (!paintCanvasCacheRef.current.has(paintLayer.id)) {
      paintCanvasCacheRef.current.set(
        paintLayer.id,
        await createCanvasFromPaintLayer(paintLayer, nextDocument.sourceImage),
      );
    }
    return { document: nextDocument, layer: paintLayer, layerEntry };
  }, [activeTool, paintCanvasCacheRef, replaceDocument, selectedLayerId]);

  const commitPaintLayerFromCanvas = React.useCallback(async (
    layerId: string,
    canvas: HTMLCanvasElement,
  ) => {
    const isCurrent = captureSession();
    const source = documentRef.current;
    const blob = await toBlob(canvas, "image/png");
    if (!isCurrent() || documentRef.current?.id !== source?.id ||
        !documentRef.current?.edit.paintLayers.some(layer => layer.id === layerId)) return null;
    pendingPaintLayerFilesRef.current.set(layerId, blob);
    dirtyPaintLayerIdsRef.current.delete(layerId);
    const current = documentRef.current;
    if (!current) {
      return null;
    }
    const updatedAt = new Date().toISOString();
    const nextDocument: TransformDocument = {
      ...current,
      updatedAt,
      edit: {
        ...current.edit,
        paintLayers: current.edit.paintLayers.map((layer) =>
          layer.id === layerId
            ? { ...layer, dataUrl: null, updatedAt }
            : layer,
        ),
      },
    };
    documentRef.current = nextDocument;
    return nextDocument;
  }, [captureSession, dirtyPaintLayerIdsRef, pendingPaintLayerFilesRef]);

  const flushDirtyPaintLayers = React.useCallback(async () => {
    const isCurrent = captureSession();
    const dirtyLayerIds = [...dirtyPaintLayerIdsRef.current];
    for (const layerId of dirtyLayerIds) {
      if (!isCurrent()) return;
      const canvas = paintCanvasCacheRef.current.get(layerId);
      if (canvas) {
        await commitPaintLayerFromCanvas(layerId, canvas);
      }
    }
  }, [captureSession, commitPaintLayerFromCanvas, dirtyPaintLayerIdsRef, paintCanvasCacheRef]);

  const { scheduleAutosave } = useTransformAutosave({
    active: open,
    sessionKey: transformSessionKey,
    maskDraftSaveRef,
    documentState,
    documentRef,
    pendingPaintLayerFilesRef,
    lastSavedDocumentRef,
    saveSequenceRef,
    setDocumentState,
    setSaveState,
    preparePaintLayerFiles: flushDirtyPaintLayers,
    isInteractionActive: () =>
      dragStateRef.current != null || pointerInteractionActiveRef.current,
    silentDocumentRef: silentAutosaveDocumentRef,
  });

  const hydratePaintCacheForDocument = React.useCallback(async (
    targetDocument: TransformDocument,
    paintDiffs: TransformHistoryPaintDiff[] | undefined,
    side: "before" | "after",
  ) => {
    const targetLayerIds = new Set(targetDocument.edit.paintLayers.map((layer) => layer.id));
    for (const layerId of [...paintCanvasCacheRef.current.keys()]) {
      if (!targetLayerIds.has(layerId)) {
        paintCanvasCacheRef.current.delete(layerId);
        pendingPaintLayerFilesRef.current.delete(layerId);
        dirtyPaintLayerIdsRef.current.delete(layerId);
      }
    }

    for (const paintLayer of targetDocument.edit.paintLayers) {
      if (!paintCanvasCacheRef.current.has(paintLayer.id)) {
        paintCanvasCacheRef.current.set(
          paintLayer.id,
          await createCanvasFromPaintLayer(paintLayer, targetDocument.sourceImage),
        );
      }
    }
    for (const diff of paintDiffs || []) {
      if (!targetLayerIds.has(diff.layerId)) {
        continue;
      }
      const canvas = paintCanvasCacheRef.current.get(diff.layerId);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) {
        continue;
      }
      applyRasterTileDiff(context, diff, side);
      dirtyPaintLayerIdsRef.current.add(diff.layerId);
      pendingPaintLayerFilesRef.current.delete(diff.layerId);
    }
  }, [dirtyPaintLayerIdsRef, paintCanvasCacheRef, pendingPaintLayerFilesRef]);

  const restoreHistorySnapshot = React.useCallback(async (
    documentSnapshot: TransformDocument,
    selection: TransformHistorySelection,
    paintDiffs: TransformHistoryPaintDiff[] | undefined,
    side: "before" | "after",
  ) => {
    const nextDocument = cloneTransformDocument(documentSnapshot);
    await hydratePaintCacheForDocument(nextDocument, paintDiffs, side);
    saveSequenceRef.current += 1;
    documentRef.current = nextDocument;
    setDocumentState(nextDocument);
    setSelectedObjectId(selection.selectedObjectId);
    setSelectedLayerId(selection.selectedLayerId);
    setEditingObjectId(selection.editingObjectId);
    renderCompositePreview();
  }, [hydratePaintCacheForDocument, renderCompositePreview]);

  React.useEffect(() => {
    restoreHistorySnapshotRef.current = restoreHistorySnapshot;
  }, [restoreHistorySnapshot]);

  const commitPaintCanvasHistory = React.useCallback((args: {
    layerId: string;
    transaction: RasterTileTransaction;
    history: DragHistorySnapshot;
    afterSelection?: TransformHistorySelection;
    label: string;
  }) => {
    const canvas = paintCanvasCacheRef.current.get(args.layerId);
    const current = documentRef.current;
    if (!canvas || !current) {
      return;
    }
    const paintDiff = args.transaction.commit();
    if (!paintDiff) {
      return;
    }
    dirtyPaintLayerIdsRef.current.add(args.layerId);
    pendingPaintLayerFilesRef.current.delete(args.layerId);

    const updatedAt = new Date().toISOString();
    const afterDocument: TransformDocument = {
      ...current,
      updatedAt,
      lastUsedMode: modeRef.current,
      edit: {
        ...current.edit,
        paintLayers: current.edit.paintLayers.map((layer) =>
          layer.id === args.layerId
            ? {
              ...layer,
              dataUrl: null,
              updatedAt,
            }
            : layer,
        ),
      },
      text: {
        objects: current.edit.textObjects,
        layers: current.edit.layers.filter((layer) => layer.kind === "text_object"),
      },
    };

    documentRef.current = afterDocument;
    enqueuePaintHistoryCommit({
      label: args.label,
      timestamp: updatedAt,
      affectedLayerIds: [args.layerId],
      beforeDocument: args.history.beforeDocument,
      afterDocument,
      beforeSelection: args.history.beforeSelection,
      afterSelection: args.afterSelection ?? getCurrentHistorySelection(),
      paintDiffs: [paintDiff],
    });
    scheduleAutosave({
      publishResponse: false,
      updateStatus: false,
    });
  }, [
    dirtyPaintLayerIdsRef,
    enqueuePaintHistoryCommit,
    getCurrentHistorySelection,
    paintCanvasCacheRef,
    pendingPaintLayerFilesRef,
    scheduleAutosave,
  ]);

  const drawPaintSegment = React.useCallback((
    canvas: HTMLCanvasElement,
    fromPoint: RasterPoint,
    toPoint: RasterPoint,
    tool: "pencil" | "brush" | "eraser",
    settings: TransformDocument["edit"]["paintSettings"],
    transaction?: RasterTileTransaction | null,
  ) => {
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const thickness =
      tool === "pencil"
        ? settings.pencilThicknessPx
        : tool === "eraser"
          ? settings.eraserThicknessPx
          : settings.brushThicknessPx;
    const hardness =
      tool === "pencil"
        ? 1
        : tool === "eraser"
          ? settings.eraserHardness
          : settings.brushHardness;
    const erasesSource = tool === "eraser" && settings.eraserTarget === "source";
    const compositeOperation = tool === "eraser" && !erasesSource ? "destination-out" : "source-over";
    const strokeStyle = tool === "eraser" ? "rgba(0,0,0,1)" : normalizeHexColor(settings.activeColor);
    drawBrushSegment(context, fromPoint, toPoint, {
      sizePx: thickness,
      hardness,
      opacity:
        tool === "brush"
          ? settings.brushOpacity
          : tool === "eraser"
            ? settings.eraserOpacity
            : 1,
      flow: tool === "brush" ? settings.brushFlow : 1,
      spacing:
        tool === "pencil"
          ? 0.08
          : settings.brushSpacing,
      color: strokeStyle,
      compositeOperation,
      pressureSize: settings.pressureSize,
      pressureOpacity: settings.pressureOpacity,
    }, transaction);
  }, []);

  const schedulePaintTransactionPreview = React.useCallback((
    transaction: RasterTileTransaction,
  ) => {
    const dirtySourceBounds = transaction.consumeDirtyBounds();
    if (dirtySourceBounds) {
      scheduleCompositePreview({
        updateLayouts: false,
        dirtySourceBounds,
      });
    }
  }, [scheduleCompositePreview]);

  const buildCompositeCanvas = React.useCallback(async (documentToRender: TransformDocument) => {
    if (!sourceElement) {
      return null;
    }
    const geometry = getTransformCanvasGeometry(documentToRender);
    const sceneCanvas = getReusableRasterCanvas(
      rasterSceneCanvasRef,
      geometry.width,
      geometry.height,
    );
    const sceneContext = sceneCanvas.getContext("2d");
    if (!sceneContext) {
      return null;
    }
    sceneContext.setTransform(1, 0, 0, 1, 0, 0);
    sceneContext.clearRect(0, 0, geometry.width, geometry.height);
    const canvas = getReusableRasterCanvas(
      rasterCompositeCanvasRef,
      geometry.width,
      geometry.height,
    );
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, geometry.width, geometry.height);
    const paintImages = new Map<string, CanvasImageSource>();
    for (const paintLayer of documentToRender.edit.paintLayers) {
      const cachedCanvas = paintCanvasCacheRef.current.get(paintLayer.id);
      if (cachedCanvas) {
        paintImages.set(paintLayer.id, cachedCanvas);
      } else if (paintLayer.dataUrl) {
        paintImages.set(paintLayer.id, await loadImageSource(paintLayer.dataUrl));
      } else if (paintLayer.assetPath) {
        paintImages.set(paintLayer.id, await loadImageSource(buildImageUrl(paintLayer.assetPath)));
      }
    }
    const imageLayerImages = new Map<string, CanvasImageSource>();
    for (const imageLayer of documentToRender.edit.imageLayers) {
      const cachedImage = imageLayerImageCacheRef.current.get(imageLayer.id);
      if (cachedImage) {
        imageLayerImages.set(imageLayer.id, cachedImage);
        continue;
      }
      const image = await createImageElementFromTransformLayer(imageLayer);
      if (image) {
        imageLayerImages.set(imageLayer.id, image);
      }
    }
    drawTransformDocument(sceneContext, sourceElement, documentToRender, null, {
      paintLayerImages: paintImages,
      imageLayerImages,
      applyAdjustments: false,
      renderDecorations: false,
    });
    recordRasterDiagnostics({ fullSurfaceDraws: 1 });
    context.filter = getTransformAdjustmentFilter(documentToRender.edit.adjustments);
    context.drawImage(sceneCanvas, 0, 0);
    context.filter = "none";
    return canvas;
  }, [imageLayerImageCacheRef, paintCanvasCacheRef, rasterCompositeCanvasRef, rasterSceneCanvasRef, sourceElement]);

  const [expandedMaskCanvas, setExpandedMaskCanvas] = React.useState<HTMLCanvasElement | null>(null);
  const maskCompositionKey = mode === "mask" && documentState?.edit.expansion ? JSON.stringify(documentState.edit) : null;
  React.useEffect(() => {
    let cancelled = false; setExpandedMaskCanvas(null);
    const current = documentRef.current;
    if (maskCompositionKey && current) void buildCompositeCanvas(current).then(canvas => {
      if (!cancelled && canvas) {
        const snapshot = document.createElement("canvas"); snapshot.width = canvas.width; snapshot.height = canvas.height;
        snapshot.getContext("2d")?.drawImage(canvas, 0, 0); setExpandedMaskCanvas(snapshot);
      }
    });
    return () => { cancelled = true; };
  }, [maskCompositionKey, buildCompositeCanvas]);

  const [expansionError, setExpansionError] = React.useState<string | null>(null);
  const handleExpansionChange = React.useCallback(async (next: TransformExpansion | null) => {
    try {
      normalizeTransformExpansion(next);
      await maskSurfaceRef.current?.flushDraft();
      applyDocumentMutation((current) => { current.edit.expansion = next; return current; }, { label: next ? "Expand frame" : "Remove expansion" });
      setFitRevision(v => v + 1);
      setExpansionError(null);
    } catch (error) { setExpansionError(error instanceof Error ? error.message : String(error)); }
  }, [applyDocumentMutation, setFitRevision]);
  const handleStartExpansion = React.useCallback(async () => {
    const current = documentRef.current;
    if (!current) return;
    if (!current.edit.expansion) {
      const geometry = getTransformCanvasGeometry(current);
      const crop = current.edit.crop;
      const base = crop.enabled ? { x: Math.floor(crop.x), y: Math.floor(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) }
        : { x: Math.floor(geometry.minX), y: Math.floor(geometry.minY), width: Math.ceil(geometry.minX + geometry.width) - Math.floor(geometry.minX), height: Math.ceil(geometry.minY + geometry.height) - Math.floor(geometry.minY) };
      await handleExpansionChange({ base, left: 0, right: 0, top: 0, bottom: 0, transition: 32 });
    }
    setMode("edit"); setRightDockOpen(true); setRightDockTab("inspector");
  }, [handleExpansionChange]);

  const buildRasterSamplingContext = React.useCallback(async (
    current: TransformDocument,
    targetCanvas: HTMLCanvasElement,
    sampleMerged: boolean,
    targetPaintLayerId?: string,
  ): Promise<CanvasRenderingContext2D | null> => {
    const samplingCanvas = getReusableRasterCanvas(
      rasterSamplingCanvasRef,
      current.sourceImage.width,
      current.sourceImage.height,
    );
    const samplingContext = samplingCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!samplingContext) {
      return null;
    }
    samplingContext.setTransform(1, 0, 0, 1, 0, 0);
    samplingContext.clearRect(0, 0, samplingCanvas.width, samplingCanvas.height);
    if (!sampleMerged) {
      samplingContext.drawImage(targetCanvas, 0, 0);
      return samplingContext;
    }
    const sampleDocument = cloneTransformDocument(current);
    if (targetPaintLayerId) {
      const targetIndex = sampleDocument.edit.layers.findIndex(
        (layer) =>
          layer.kind === "paint_layer" &&
          layer.refId === targetPaintLayerId,
      );
      if (targetIndex >= 0) {
        sampleDocument.edit.layers = sampleDocument.edit.layers.slice(
          0,
          targetIndex + 1,
        );
      }
    }
    const composite = await buildCompositeCanvas(sampleDocument);
    if (!composite) {
      return null;
    }
    const geometry = getTransformCanvasGeometry(current);
    samplingContext.drawImage(
      composite,
      -geometry.offsetX,
      -geometry.offsetY,
    );
    return samplingContext;
  }, [buildCompositeCanvas, rasterSamplingCanvasRef]);

  const sampleColor = React.useCallback(async (
    point: { x: number; y: number },
    sampleMerged = true,
  ) => {
    const current = documentRef.current;
    if (!current) {
      return null;
    }
    if (!sampleMerged) {
      const selectedLayer = selectedLayerId
        ? current.edit.layers.find(
          (layer) =>
            layer.id === selectedLayerId &&
            layer.kind === "paint_layer" &&
            layer.visible,
        )
        : null;
      const layerCanvas = selectedLayer
        ? paintCanvasCacheRef.current.get(selectedLayer.refId)
        : null;
      const layerContext = layerCanvas?.getContext("2d");
      if (!layerCanvas || !layerContext) {
        return null;
      }
      const pixel = layerContext.getImageData(
        clamp(Math.floor(point.x), 0, layerCanvas.width - 1),
        clamp(Math.floor(point.y), 0, layerCanvas.height - 1),
        1,
        1,
      ).data;
      return pixel[3] > 0 ? rgbaToHex(pixel) : null;
    }
    const geometry = getTransformCanvasGeometry(current);
    const canvas = await buildCompositeCanvas(current);
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return null;
    }
    const canvasX = clamp(Math.floor(point.x + geometry.offsetX), 0, canvas.width - 1);
    const canvasY = clamp(Math.floor(point.y + geometry.offsetY), 0, canvas.height - 1);
    const pixel = context.getImageData(
      canvasX,
      canvasY,
      1,
      1,
    ).data;
    return rgbaToHex(pixel);
  }, [buildCompositeCanvas, paintCanvasCacheRef, selectedLayerId]);

  const fillActivePaintLayer = React.useCallback(async (point: RasterPoint) => {
    const history = captureDragHistory();
    if (!history) {
      return;
    }
    const active = await ensureActivePaintLayer();
    const current = documentRef.current;
    if (!active || !current) {
      return;
    }
    const targetCanvas = paintCanvasCacheRef.current.get(active.layer.id);
    const targetContext = targetCanvas?.getContext("2d");
    if (!targetCanvas || !targetContext) {
      return;
    }
    const width = current.sourceImage.width;
    const height = current.sourceImage.height;
    const startX = clamp(Math.floor(point.x), 0, width - 1);
    const startY = clamp(Math.floor(point.y), 0, height - 1);
    const fillSettings = current.edit.retouchSettings.fill;
    let sampleData: ImageData;
    if (fillSettings.sampleMerged) {
      const compositeCanvas = await buildCompositeCanvas(current);
      const compositeContext = compositeCanvas?.getContext("2d");
      if (!compositeCanvas || !compositeContext) {
        return;
      }
      const geometry = getTransformCanvasGeometry(current);
      sampleData = compositeContext.getImageData(
        Math.round(geometry.offsetX),
        Math.round(geometry.offsetY),
        width,
        height,
      );
    } else {
      sampleData = targetContext.getImageData(0, 0, width, height);
    }
    const fillMask = await runFloodFill(
      sampleData.data,
      width,
      height,
      startX,
      startY,
      fillSettings.tolerance,
      fillSettings.contiguous,
      { transferInput: true },
    );
    if (!fillMask.bounds) {
      return;
    }
    const transaction = new RasterTileTransaction(active.layer.id, targetContext);
    transaction.touch(fillMask.bounds);
    const targetData = targetContext.getImageData(
      fillMask.bounds.x,
      fillMask.bounds.y,
      fillMask.bounds.width,
      fillMask.bounds.height,
    );
    const color = normalizeHexColor(paintColorDraftRef.current || current.edit.paintSettings.activeColor);
    const fill = [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
      Math.round(current.edit.paintSettings.fillOpacity * 255),
    ];
    for (let row = 0; row < fillMask.bounds.height; row += 1) {
      if (row > 0 && row % 32 === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      for (let column = 0; column < fillMask.bounds.width; column += 1) {
        const sourceIndex =
          (fillMask.bounds.y + row) * width +
          fillMask.bounds.x +
          column;
        if (!fillMask.mask[sourceIndex]) {
          continue;
        }
        const dataIndex = (row * fillMask.bounds.width + column) * 4;
        targetData.data[dataIndex] = fill[0];
        targetData.data[dataIndex + 1] = fill[1];
        targetData.data[dataIndex + 2] = fill[2];
        targetData.data[dataIndex + 3] = fill[3];
      }
    }
    targetContext.putImageData(targetData, fillMask.bounds.x, fillMask.bounds.y);
    dirtyPaintLayerIdsRef.current.add(active.layer.id);
    scheduleCompositePreview();
    setSelectedLayerId(active.layerEntry.id);
    setSelectedObjectId(null);
    await commitPaintCanvasHistory({
      layerId: active.layer.id,
      transaction,
      history,
      label: "Fill region",
      afterSelection: {
        selectedObjectId: null,
        selectedLayerId: active.layerEntry.id,
        editingObjectId: null,
      },
    });
  }, [
    buildCompositeCanvas,
    captureDragHistory,
    commitPaintCanvasHistory,
    dirtyPaintLayerIdsRef,
    ensureActivePaintLayer,
    paintCanvasCacheRef,
    scheduleCompositePreview,
  ]);

  const selectRasterByColor = React.useCallback(async (point: RasterPoint) => {
    const current = documentRef.current;
    if (!current) {
      return;
    }
    const width = current.sourceImage.width;
    const height = current.sourceImage.height;
    const settings = current.edit.retouchSettings.fill;
    let sampleData: ImageData | null = null;
    if (settings.sampleMerged) {
      const compositeCanvas = await buildCompositeCanvas(current);
      const compositeContext = compositeCanvas?.getContext("2d");
      if (compositeCanvas && compositeContext) {
        const geometry = getTransformCanvasGeometry(current);
        sampleData = compositeContext.getImageData(
          Math.round(geometry.offsetX),
          Math.round(geometry.offsetY),
          width,
          height,
        );
      }
    } else if (currentPaintLayer) {
      const canvas = paintCanvasCacheRef.current.get(currentPaintLayer.id);
      sampleData = canvas?.getContext("2d")?.getImageData(0, 0, width, height) ?? null;
    }
    if (!sampleData) {
      return;
    }
    const result = await runFloodFill(
      sampleData.data,
      width,
      height,
      clamp(Math.floor(point.x), 0, width - 1),
      clamp(Math.floor(point.y), 0, height - 1),
      settings.tolerance,
      settings.contiguous,
      { transferInput: true },
    );
    setRasterSelection(selectionFromMask(result.mask, result.bounds));
    setRasterSelectionMoveOffset({ x: 0, y: 0 });
    setSelectedObjectId(null);
    setEditingObjectId(null);
  }, [buildCompositeCanvas, currentPaintLayer, paintCanvasCacheRef]);

  const applyPixelateSelection = React.useCallback(async () => {
    if (
      !rasterSelection ||
      rasterSelection.bounds.width < 1 ||
      rasterSelection.bounds.height < 1
    ) {
      return;
    }
    const history = captureDragHistory();
    if (!history) {
      return;
    }
    const active = await ensureActivePaintLayer();
    const current = documentRef.current;
    const canvas = active ? paintCanvasCacheRef.current.get(active.layer.id) : null;
    const context = canvas?.getContext("2d");
    if (!active || !current || !canvas || !context) {
      return;
    }
    const settings = current.edit.retouchSettings.pixelate;
    const samplingContext = await buildRasterSamplingContext(
      current,
      canvas,
      settings.sampleMerged,
      active.layer.id,
    );
    if (!samplingContext) {
      return;
    }
    const transaction = new RasterTileTransaction(active.layer.id, context);
    pixelateRasterSelection(
      context,
      samplingContext,
      rasterSelection,
      settings.blockSizePx,
      transaction,
    );
    dirtyPaintLayerIdsRef.current.add(active.layer.id);
    scheduleCompositePreview();
    setSelectedLayerId(active.layerEntry.id);
    setSelectedObjectId(null);
    await commitPaintCanvasHistory({
      layerId: active.layer.id,
      transaction,
      history,
      label: "Pixelate selection",
      afterSelection: {
        selectedObjectId: null,
        selectedLayerId: active.layerEntry.id,
        editingObjectId: null,
      },
    });
    setRasterSelection(null);
  }, [
    buildRasterSamplingContext,
    captureDragHistory,
    commitPaintCanvasHistory,
    dirtyPaintLayerIdsRef,
    ensureActivePaintLayer,
    paintCanvasCacheRef,
    rasterSelection,
    scheduleCompositePreview,
  ]);

  React.useEffect(() => {
    const applyPaintDab = (dragState: Extract<DragState, { kind: "paint" }>, point: StrokeSample) => {
      const current = documentRef.current;
      const canvas = paintCanvasCacheRef.current.get(dragState.layerId);
      const context = canvas?.getContext("2d");
      if (!current || !canvas || !context) {
        return;
      }
      const rasterPoint: RasterPoint = point;
      const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (
        dragState.tool === "pencil" ||
        dragState.tool === "brush" ||
        dragState.tool === "eraser"
      ) {
        const thickness = dragState.tool === "pencil"
          ? current.edit.paintSettings.pencilThicknessPx
          : dragState.tool === "eraser"
            ? current.edit.paintSettings.eraserThicknessPx
            : current.edit.paintSettings.brushThicknessPx;
        const hardness = dragState.tool === "pencil"
          ? 1
          : dragState.tool === "eraser"
            ? current.edit.paintSettings.eraserHardness
            : current.edit.paintSettings.brushHardness;
        const erasesSource = dragState.tool === "eraser" && current.edit.paintSettings.eraserTarget === "source";
        drawBrushDab(context, rasterPoint, {
          sizePx: thickness,
          hardness,
          opacity:
            dragState.tool === "brush"
              ? current.edit.paintSettings.brushOpacity
              : dragState.tool === "eraser"
                ? current.edit.paintSettings.eraserOpacity
                : 1,
          flow: dragState.tool === "brush" ? current.edit.paintSettings.brushFlow : 1,
          spacing: dragState.tool === "pencil" ? 0.08 : current.edit.paintSettings.brushSpacing,
          color: dragState.tool === "eraser"
            ? "rgba(0,0,0,1)"
            : normalizeHexColor(paintColorDraftRef.current || current.edit.paintSettings.activeColor),
          compositeOperation: dragState.tool === "eraser" && !erasesSource
            ? "destination-out"
            : "source-over",
          pressureSize: current.edit.paintSettings.pressureSize,
          pressureOpacity: current.edit.paintSettings.pressureOpacity,
        }, dragState.transaction);
      } else if (
        dragState.tool === "pixelate" &&
        dragState.samplingContext &&
        dragState.pixelSampler
      ) {
        const settings = current.edit.retouchSettings.pixelate;
        drawPixelateDab(
          context,
          dragState.samplingContext,
          rasterPoint,
          {
            brushSizePx: settings.brushSizePx,
            blockSizePx: settings.blockSizePx,
            footprint: settings.footprint,
            featherPx: settings.featherPx,
            visitedBlocks: dragState.visitedBlocks,
            sampler: dragState.pixelSampler,
          },
          dragState.transaction,
        );
      } else if (
        dragState.tool === "smudge" &&
        dragState.samplingContext &&
        dragState.smudgeState
      ) {
        drawSmudgeDab(
          context,
          dragState.samplingContext,
          dragState.smudgeState,
          rasterPoint,
          current.edit.retouchSettings.smudge,
          dragState.transaction,
        );
      }
      dragState.lastPoint = rasterPoint;
      recordRasterDiagnostics({
        emittedDabs: 1,
        rasterTimeMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt,
      });
      if (!dragState.hasAppliedDab) {
        dragState.hasAppliedDab = true;
        recordFirstDabLatency(dragState.pointerDownAt);
      }
    };

    const commitFinalizedPaintStroke = (dragState: Extract<DragState, { kind: "paint" }>) => {
      if (dragState.historyCommitStarted) return;
      dragState.historyCommitStarted = true;
      if (dragStateRef.current === dragState) {
        dragStateRef.current = null;
      }
      if (!paintCanvasCacheRef.current.get(dragState.layerId)) return;
      void commitPaintCanvasHistory({
        layerId: dragState.layerId,
        transaction: dragState.transaction,
        history: dragState.history,
        label:
          dragState.tool === "smudge"
            ? "Smudge stroke"
            : dragState.tool === "pixelate"
              ? "Pixelate stroke"
              : dragState.tool === "pencil"
                ? "Pencil stroke"
                : dragState.tool === "eraser"
                  ? "Erase stroke"
                  : "Brush stroke",
        afterSelection: {
          selectedObjectId: null,
          selectedLayerId: dragState.layerEntryId,
          editingObjectId: null,
        },
      });
    };

    const drainPaintStroke = (
      dragState: Extract<DragState, { kind: "paint" }>,
    ) => {
      if (dragState.strokeDrainFrame != null) {
        window.cancelAnimationFrame(dragState.strokeDrainFrame);
        dragState.strokeDrainFrame = null;
      }
      const result = dragState.strokeQueue.drain(
        dragState.strokeResampler,
        (point) => applyPaintDab(dragState, point),
        { budgetMs: STROKE_WORK_BUDGET_MS, maxDabs: STROKE_WORK_MAX_DABS },
      );
      if (result.dabs > 0) {
        dirtyPaintLayerIdsRef.current.add(dragState.layerId);
        schedulePaintTransactionPreview(dragState.transaction);
      }
      if (result.remaining && (dragStateRef.current === dragState || dragState.strokeFinalizing)) {
        dragState.strokeDrainFrame = window.requestAnimationFrame(() => {
          dragState.strokeDrainFrame = null;
          drainPaintStroke(dragState);
        });
      } else if (dragState.strokeFinalizing) {
        commitFinalizedPaintStroke(dragState);
      }
    };

    const enqueuePaintSamples = (
      dragState: Extract<DragState, { kind: "paint" }>,
      samples: readonly StrokeSample[],
    ) => {
      if (!samples.length) {
        return;
      }
      recordRasterDiagnostics({ rawPointerSamples: samples.length });
      dragState.strokeQueue.enqueue(samples);
      if (dragStateRef.current === dragState && dragState.strokeDrainFrame == null) {
        dragState.strokeDrainFrame = window.requestAnimationFrame(() => {
          dragState.strokeDrainFrame = null;
          drainPaintStroke(dragState);
        });
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }
      if ("pointerId" in dragState && dragState.pointerId !== event.pointerId) {
        return;
      }

      if (dragState.kind === "paint" && dragState.strokeFinalizing) {
        return;
      }

      if (dragState.kind === "pan") {
        const nextPan = {
          x: dragState.originalPan.x + (event.clientX - dragState.startClient.x),
          y: dragState.originalPan.y + (event.clientY - dragState.startClient.y),
        };
        dragState.currentPan = nextPan;
        const transformedSurface = transformedSurfaceRef.current;
        if (transformedSurface) {
          transformedSurface.style.transform =
            `translate(${nextPan.x}px, ${nextPan.y}px) scale(${surfaceScale})`;
        }
        return;
      }

      if (dragState.kind === "paint") {
        const pointerEvents = (
          typeof event.getCoalescedEvents === "function"
            ? event.getCoalescedEvents()
            : [event]
        );
        const eventsToDraw = pointerEvents.length ? pointerEvents : [event];
        const samples: StrokeSample[] = [];
        for (const pointerEvent of eventsToDraw) {
          const convertedPoint = convertPointerToSource(pointerEvent, { clampToSource: true });
          if (!convertedPoint) {
            continue;
          }
          samples.push({
            ...convertedPoint,
            pressure:
              typeof pointerEvent.pressure === "number" && pointerEvent.pressure > 0
                ? pointerEvent.pressure
                : 1,
          });
        }
        enqueuePaintSamples(dragState, samples);
        return;
      }
      if (dragState.kind === "pixelate-selection") {
        const point = convertPointerToSource(event, { clampToSource: true });
        if (point) {
          dragState.currentPoint = point;
          setRasterSelection({ bounds: boundsFromPoints(dragState.startPoint, point) });
        }
        return;
      }
      if (dragState.kind === "raster-selection-move") {
        const point = convertPointerToSource(event, { clampToSource: false });
        if (point) {
          dragState.currentPoint = point;
          setRasterSelectionMoveOffset({
            x: Math.round(point.x - dragState.startPoint.x),
            y: Math.round(point.y - dragState.startPoint.y),
          });
        }
        return;
      }
      const point = convertPointerToSource(event, {
        clampToSource: dragState.kind === "crop",
      });
      if (!point) {
        return;
      }
      interactionDraftDocumentRef.current = buildInteractionDraftDocument(
        dragState.history.beforeDocument,
        dragState,
        point,
        modeRef.current,
      );
      scheduleCompositePreview({ updateLayouts: false });
    };

    const handlePointerUp = (event: PointerEvent, includeEndpoint = true) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }
      if ("pointerId" in dragState && dragState.pointerId !== event.pointerId) {
        return;
      }
      if (dragState.kind === "paint" && dragState.strokeFinalizing) {
        return;
      }
      if (dragState.kind === "paint") {
        dragState.strokeFinalizing = true;
        if (includeEndpoint) {
          const finalPoint = convertPointerToSource(event, { clampToSource: true });
          if (finalPoint) {
            enqueuePaintSamples(dragState, [{
              ...finalPoint,
              pressure: event.pressure > 0 ? event.pressure : 1,
            }]);
          }
          dragState.strokeQueue.enqueueDabs(dragState.strokeResampler.finish(true));
        }
        drainPaintStroke(dragState);
        return;
      }

      dragStateRef.current = null;
      if (dragState.kind === "pan") {
        React.startTransition(() => {
          setPan(dragState.currentPan);
        });
        return;
      }
      if (dragState.kind === "pixelate-selection") {
        setRasterSelection(
          { bounds: boundsFromPoints(dragState.startPoint, dragState.currentPoint) },
        );
        return;
      }
      if (dragState.kind === "raster-selection-move") {
        const deltaX = Math.round(dragState.currentPoint.x - dragState.startPoint.x);
        const deltaY = Math.round(dragState.currentPoint.y - dragState.startPoint.y);
        setRasterSelectionMoveOffset({ x: 0, y: 0 });
        const canvas = paintCanvasCacheRef.current.get(dragState.layerId);
        const context = canvas?.getContext("2d");
        if (!canvas || !context || (!deltaX && !deltaY)) {
          return;
        }
        const transaction = new RasterTileTransaction(dragState.layerId, context);
        const nextSelection = moveRasterSelection(
          context,
          dragState.selection,
          deltaX,
          deltaY,
          transaction,
        );
        setRasterSelection(nextSelection);
        dirtyPaintLayerIdsRef.current.add(dragState.layerId);
        scheduleCompositePreview();
        void commitPaintCanvasHistory({
          layerId: dragState.layerId,
          transaction,
          history: dragState.history,
          label: "Move selected pixels",
        });
        return;
      }
      if (documentRef.current) {
        const draftDocument = interactionDraftDocumentRef.current;
        interactionDraftDocumentRef.current = null;
        if (draftDocument) {
          React.startTransition(() => {
            setLayouts(previewLayoutsRef.current);
          });
          replaceDocument(draftDocument, {
            beforeDocument: dragState.history.beforeDocument,
            beforeSelection: dragState.history.beforeSelection,
            afterSelection: getCurrentHistorySelection(),
            reusePreview: true,
            silentAutosave: true,
            label:
              dragState.kind === "move" || dragState.kind === "move-image"
                ? "Move object"
                : dragState.kind === "resize" || dragState.kind === "resize-image"
                  ? "Resize object"
                  : dragState.kind === "rotate" || dragState.kind === "rotate-image"
                    ? "Rotate object"
                    : dragState.kind === "crop"
                      ? "Crop image"
                      : "Edit object",
          });
          return;
        }
        pushHistory(documentRef.current, {
          beforeDocument: dragState.history.beforeDocument,
          beforeSelection: dragState.history.beforeSelection,
          afterSelection: getCurrentHistorySelection(),
          label:
            dragState.kind === "rotate" || dragState.kind === "rotate-image"
              ? "Rotate object"
              : "Edit object",
        });
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    const pointerUp = (event: PointerEvent) => handlePointerUp(event, true);
    const pointerCancel = (event: PointerEvent) => handlePointerUp(event, false);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("lostpointercapture", pointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("lostpointercapture", pointerCancel);
    };
  }, [
    commitPaintCanvasHistory,
    convertPointerToSource,
    dirtyPaintLayerIdsRef,
    getCurrentHistorySelection,
    interactionDraftDocumentRef,
    paintCanvasCacheRef,
    pushHistory,
    replaceDocument,
    scheduleCompositePreview,
    schedulePaintTransactionPreview,
    setLayouts,
    setPan,
    surfaceScale,
    transformedSurfaceRef,
  ]);

  const setEditTool = React.useCallback((tool: TransformEditTool) => {
    const nextTool = tool;
    setActiveTool(tool);
    applyDocumentMutation((current) => {
      current.edit.lastUsedTool = nextTool;
      return current;
    }, { pushHistory: false });
    setEditingObjectId(null);
  }, [applyDocumentMutation]);

  const handleCanvasPointerDown = React.useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      if (!documentState || mode !== "edit") {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const convertedPoint = convertPointerToSource(event, {
        clampToSource: activeTool !== "select" && activeTool !== "pan",
      });
      if (!convertedPoint) {
        return;
      }
      const point: RasterPoint = {
        ...convertedPoint,
        pressure: event.pressure > 0 ? event.pressure : 1,
      };
      const pointerDownAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      updateEditCursorPosition(point);

      if (spacePressed || activeTool === "pan" || event.button === 1) {
        setViewportModeManual();
        dragStateRef.current = {
          kind: "pan",
          startClient: { x: event.clientX, y: event.clientY },
          originalPan: pan,
          currentPan: pan,
        };
        return;
      }

      if (event.altKey && activeTool !== "eyedropper") {
        const color = await sampleColor(point, true);
        if (color) {
          applyDocumentMutation((current) => {
            addRecentColor(current.edit.paintSettings, color);
            return current;
          });
        }
        return;
      }

      if (activeTool === "select_by_color") {
        await selectRasterByColor(point);
        return;
      }

      if (activeTool === "rect_select") {
        const bounds = rasterSelection?.bounds;
        const insideSelection = Boolean(
          bounds &&
          point.x >= bounds.x &&
          point.x <= bounds.x + bounds.width &&
          point.y >= bounds.y &&
          point.y <= bounds.y + bounds.height,
        );
        if (insideSelection && currentPaintLayer && rasterSelection) {
          const history = captureDragHistory();
          if (history) {
            dragStateRef.current = {
              kind: "raster-selection-move",
              startPoint: point,
              currentPoint: point,
              selection: rasterSelection,
              layerId: currentPaintLayer.id,
              history,
            };
          }
          return;
        }
        setRasterSelection({
          bounds: { x: point.x, y: point.y, width: 0, height: 0 },
        });
        setRasterSelectionMoveOffset({ x: 0, y: 0 });
        dragStateRef.current = {
          kind: "pixelate-selection",
          startPoint: point,
          currentPoint: point,
        };
        return;
      }

      if (
        activeTool === "pixelate" &&
        documentState.edit.retouchSettings.pixelate.interactionMode === "selection"
      ) {
        setRasterSelection({ bounds: { x: point.x, y: point.y, width: 0, height: 0 } });
        setRasterSelectionMoveOffset({ x: 0, y: 0 });
        dragStateRef.current = {
          kind: "pixelate-selection",
          startPoint: point,
          currentPoint: point,
        };
        return;
      }

      if (
        activeTool === "pencil" ||
        activeTool === "brush" ||
        activeTool === "eraser" ||
        activeTool === "smudge" ||
        activeTool === "pixelate"
      ) {
        const history = captureDragHistory();
        if (!history) {
          return;
        }
        const active = await ensureActivePaintLayer();
        const canvas = active ? paintCanvasCacheRef.current.get(active.layer.id) : null;
        const context = canvas?.getContext("2d");
        if (!active || !canvas || !context) {
          return;
        }
        const transaction = new RasterTileTransaction(active.layer.id, context);
        let samplingContext: CanvasRenderingContext2D | null = null;
        let pixelSampler: RasterPixelSampler | null = null;
        let smudgeState: SmudgeState | null = null;
        const visitedBlocks = new Set<string>();
        if (activeTool === "smudge") {
          const settings = active.document.edit.retouchSettings.smudge;
          samplingContext = await buildRasterSamplingContext(
            active.document,
            canvas,
            settings.sampleMerged,
            active.layer.id,
          );
          if (!samplingContext) {
            return;
          }
          smudgeState = createSmudgeState(
            samplingContext,
            point,
            settings.sizePx,
            settings.hardness,
            settings.strength,
          );
          drawSmudgeDab(
            context,
            samplingContext,
            smudgeState,
            point,
            settings,
            transaction,
          );
        } else if (activeTool === "pixelate") {
          const settings = active.document.edit.retouchSettings.pixelate;
          samplingContext = await buildRasterSamplingContext(
            active.document,
            canvas,
            settings.sampleMerged,
            active.layer.id,
          );
          if (!samplingContext) {
            return;
          }
          pixelSampler = createRasterPixelSampler(samplingContext);
          drawPixelateDab(
            context,
            samplingContext,
            point,
            {
              brushSizePx: settings.brushSizePx,
              blockSizePx: settings.blockSizePx,
              footprint: settings.footprint,
              featherPx: settings.featherPx,
              visitedBlocks,
              sampler: pixelSampler,
            },
            transaction,
          );
        } else {
          drawPaintSegment(
            canvas,
            point,
            { ...point, x: point.x + 0.01 },
            activeTool,
            {
              ...active.document.edit.paintSettings,
              activeColor:
                paintColorDraftRef.current ||
                active.document.edit.paintSettings.activeColor,
            },
            transaction,
          );
        }
        const strokeResampler = new StrokeResampler({
          spacing: getRasterStrokeSpacing(active.document, activeTool),
        });
        strokeResampler.push({ ...point, pressure: point.pressure ?? 1 });
        recordRasterDiagnostics({ rawPointerSamples: 1, emittedDabs: 1 });
        recordFirstDabLatency(pointerDownAt);
        dirtyPaintLayerIdsRef.current.add(active.layer.id);
        schedulePaintTransactionPreview(transaction);
        setSelectedLayerId(active.layerEntry.id);
        setSelectedObjectId(null);
        dragStateRef.current = {
          kind: "paint",
          tool: activeTool,
          layerId: active.layer.id,
          layerEntryId: active.layerEntry.id,
          pointerId: event.pointerId,
          lastPoint: point,
          transaction,
          samplingContext,
          pixelSampler,
          smudgeState,
          visitedBlocks,
          strokeQueue: new StrokeWorkQueue(),
          strokeResampler,
          strokeDrainFrame: null,
          strokeFinalizing: false,
          historyCommitStarted: false,
          pointerDownAt,
          hasAppliedDab: true,
          history,
        };
        return;
      }

      if (activeTool === "fill_bucket") {
        await fillActivePaintLayer(point);
        return;
      }

      if (activeTool === "eyedropper") {
        const color = await sampleColor(
          point,
          documentState.edit.paintSettings.eyedropperSampleMerged,
        );
        if (color) {
          applyDocumentMutation((current) => {
            addRecentColor(current.edit.paintSettings, color);
            return current;
          });
        }
        return;
      }

      if (activeTool === "crop") {
        const crop = documentState.edit.crop;
        const nearCorner = pointDistance(point, { x: crop.x + crop.width, y: crop.y + crop.height }) <= handleMetrics.hitRadius.resizeCorner;
        const insideCrop =
          point.x >= crop.x &&
          point.x <= crop.x + crop.width &&
          point.y >= crop.y &&
          point.y <= crop.y + crop.height;
        if (!crop.enabled) {
          applyDocumentMutation((current) => {
            current.edit.crop = {
              ...current.edit.crop,
              enabled: true,
              x: Math.round(current.sourceImage.width * 0.1),
              y: Math.round(current.sourceImage.height * 0.1),
              width: Math.round(current.sourceImage.width * 0.8),
              height: Math.round(current.sourceImage.height * 0.8),
            };
            return current;
          });
          return;
        }
        dragStateRef.current = {
          kind: "crop",
          dragKind: nearCorner || !insideCrop ? "resize" : "move",
          startPoint: point,
          originalCrop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
          history: captureDragHistory() ?? {
            beforeDocument: cloneTransformDocument(documentState),
            beforeSelection: getCurrentHistorySelection(),
          },
        };
        return;
      }

      const selectedLayout = layouts.find((layout) => layout.objectId === selectedObjectId) || null;
      const selectedVisualLayer = selectedLayout
        ? documentState.edit.layers.find(
          (layer) =>
            (layer.kind === "text_object" || layer.kind === "image_layer") &&
            layer.refId === selectedLayout.objectId,
        )
        : null;
      const selectedRotationHandle = selectedLayout
        ? rotatePoint(
          {
            x: selectedLayout.center.x,
            y: selectedLayout.bounds.y - handleMetrics.rotationHandleOffset,
          },
          selectedLayout.center,
          selectedLayout.rotation,
        )
        : null;
      if (
        selectedLayout &&
        selectedRotationHandle &&
        !selectedVisualLayer?.locked &&
        pointDistance(selectedRotationHandle, point) <= handleMetrics.hitRadius.rotation
      ) {
        const startAngle = Math.atan2(
          point.y - selectedLayout.center.y,
          point.x - selectedLayout.center.x,
        );
        const history = captureDragHistory() ?? {
          beforeDocument: cloneTransformDocument(documentState),
          beforeSelection: getCurrentHistorySelection(),
        };
        if (selectedLayout.kind === "image_layer") {
          const imageLayer = documentState.edit.imageLayers.find(
            (layer) => layer.id === selectedLayout.objectId,
          );
          if (!imageLayer) return;
          dragStateRef.current = {
            kind: "rotate-image",
            objectId: imageLayer.id,
            center: selectedLayout.center,
            originalImageLayer: cloneTransformDocument(imageLayer),
            startAngle,
            history,
          };
        } else {
          const originalObject = documentState.edit.textObjects.find(
            (object) => object.id === selectedLayout.objectId,
          );
          if (!originalObject) return;
          dragStateRef.current = {
            kind: "rotate",
            objectId: originalObject.id,
            center: selectedLayout.center,
            originalObject: cloneTransformDocument(originalObject),
            startAngle,
            history,
          };
        }
        return;
      }
      if (
        selectedLayout &&
        selectedLayout.kind !== "image_layer" &&
        !selectedVisualLayer?.locked &&
        distanceToTailHandle(selectedLayout, point) <= handleMetrics.hitRadius.tail
      ) {
        const originalObject = documentState.edit.textObjects.find((object) => object.id === selectedLayout.objectId);
        if (!originalObject) {
          return;
        }
        dragStateRef.current = {
          kind: "tail",
          objectId: originalObject.id,
          startPoint: point,
          originalObject: cloneTransformDocument(originalObject),
          history: captureDragHistory() ?? {
            beforeDocument: cloneTransformDocument(documentState),
            beforeSelection: getCurrentHistorySelection(),
          },
        };
        return;
      }
      if (
        selectedLayout &&
        selectedLayout.kind !== "image_layer" &&
        !selectedVisualLayer?.locked &&
        selectedLayout.tailBase &&
        pointDistance(point, selectedLayout.tailBase) <= handleMetrics.hitRadius.tailBase
      ) {
        const originalObject = documentState.edit.textObjects.find((object) => object.id === selectedLayout.objectId);
        if (!originalObject) {
          return;
        }
        const center = getObjectCenter(originalObject);
        dragStateRef.current = {
          kind: "tail-base",
          objectId: originalObject.id,
          center,
          originalObject: cloneTransformDocument(originalObject),
          history: captureDragHistory() ?? {
            beforeDocument: cloneTransformDocument(documentState),
            beforeSelection: getCurrentHistorySelection(),
          },
        };
        return;
      }
      if (
        selectedLayout &&
        selectedLayout.kind !== "image_layer" &&
        !selectedVisualLayer?.locked &&
        selectedLayout.textHandle &&
        pointDistance(point, selectedLayout.textHandle) <= handleMetrics.hitRadius.text
      ) {
        const originalObject = documentState.edit.textObjects.find((object) => object.id === selectedLayout.objectId);
        if (!originalObject) {
          return;
        }
        const center = getObjectCenter(originalObject);
        dragStateRef.current = {
          kind: "text",
          objectId: originalObject.id,
          startLocalPoint: unrotatePoint(point, center, originalObject.rotation),
          center,
          originalObject: cloneTransformDocument(originalObject),
          history: captureDragHistory() ?? {
            beforeDocument: cloneTransformDocument(documentState),
            beforeSelection: getCurrentHistorySelection(),
          },
        };
        return;
      }
      const resizeHandle: { axis: ResizeAxis; threshold: number } | null =
        selectedLayout && pointDistance(point, selectedLayout.resizeHandles.corner) <= handleMetrics.hitRadius.resizeCorner
          ? { axis: "both", threshold: handleMetrics.hitRadius.resizeCorner }
          : selectedLayout && pointDistance(point, selectedLayout.resizeHandles.right) <= handleMetrics.hitRadius.resize
            ? { axis: "x", threshold: handleMetrics.hitRadius.resize }
            : selectedLayout && pointDistance(point, selectedLayout.resizeHandles.bottom) <= handleMetrics.hitRadius.resize
              ? { axis: "y", threshold: handleMetrics.hitRadius.resize }
              : null;
      if (selectedLayout && !selectedVisualLayer?.locked && resizeHandle) {
        const history = captureDragHistory() ?? {
          beforeDocument: cloneTransformDocument(documentState),
          beforeSelection: getCurrentHistorySelection(),
        };
        if (selectedLayout.kind === "image_layer") {
          const imageLayer = documentState.edit.imageLayers.find(
            (layer) => layer.id === selectedLayout.objectId,
          );
          if (!imageLayer) return;
          dragStateRef.current = {
            kind: "resize-image",
            objectId: imageLayer.id,
            startLocalPoint: unrotatePoint(point, selectedLayout.center, imageLayer.rotation),
            center: selectedLayout.center,
            originalImageLayer: cloneTransformDocument(imageLayer),
            history,
          };
        } else {
          const originalObject = documentState.edit.textObjects.find(
            (object) => object.id === selectedLayout.objectId,
          );
          if (!originalObject) return;
          const center = getObjectCenter(originalObject);
          dragStateRef.current = {
            kind: "resize",
            axis: resizeHandle.axis,
            objectId: originalObject.id,
            startLocalPoint: unrotatePoint(point, center, originalObject.rotation),
            center,
            originalObject: cloneTransformDocument(originalObject),
            history,
          };
        }
        return;
      }

      if (activeTool === "lettering") {
        const nextObject = createTransformTextObject(
          activeLetteringKind,
          clamp(point.x - 130, 0, documentState.sourceImage.width - 120),
          clamp(point.y - 75, 0, documentState.sourceImage.height - 72),
          getLetteringDefaultText(activeLetteringKind),
        );
        const nextLayer = createTransformLayer(
          nextObject,
          documentState.edit.layers.length,
          t("lettering.layerName", {
            shape: getLetteringShapeLabel(activeLetteringKind),
            number: formatLocalizedNumber(documentState.edit.layers.length + 1),
          }),
        );
        const next = cloneTransformDocument(documentState);
        next.edit.textObjects.push(nextObject);
        next.edit.layers.push(nextLayer);
        next.edit.lastUsedTool = "lettering";
        next.text.objects = next.edit.textObjects;
        next.text.layers = next.edit.layers.filter((layer) => layer.kind === "text_object");
        next.lastUsedMode = "edit";
        replaceDocument(next, {
          afterSelection: {
            selectedObjectId: nextObject.id,
            selectedLayerId: nextLayer.id,
            editingObjectId: nextObject.id,
          },
        });
        setSelectedObjectId(nextObject.id);
        setSelectedLayerId(nextLayer.id);
        setEditingObjectId(nextObject.id);
        editingDirtyRef.current = false;
        setActiveTool("select");
        return;
      }

      const hitLayout = findObjectAtPoint(layouts, point);
      if (!hitLayout) {
        setSelectedObjectId(null);
        setEditingObjectId(null);
        setSelectedLayerId(null);
        return;
      }

      if (hitLayout.kind === "image_layer") {
        const targetImage = documentState.edit.imageLayers.find(
          (layer) => layer.id === hitLayout.objectId,
        );
        const targetLayer = documentState.edit.layers.find(
          (layer) => layer.kind === "image_layer" && layer.refId === hitLayout.objectId,
        );
        if (!targetImage) return;
        setSelectedObjectId(targetImage.id);
        setSelectedLayerId(targetLayer?.id || null);
        setEditingObjectId(null);
        if (!targetLayer?.locked) {
          dragStateRef.current = {
            kind: "move-image",
            objectId: targetImage.id,
            startPoint: point,
            originalImageLayer: cloneTransformDocument(targetImage),
            history: captureDragHistory() ?? {
              beforeDocument: cloneTransformDocument(documentState),
              beforeSelection: getCurrentHistorySelection(),
            },
          };
        }
        return;
      }
      const targetObject = documentState.edit.textObjects.find((object) => object.id === hitLayout.objectId);
      if (!targetObject) return;
      const targetLayer = documentState.edit.layers.find((layer) => layer.kind === "text_object" && layer.refId === targetObject.id);
      setSelectedObjectId(targetObject.id);
      setSelectedLayerId(targetLayer?.id || null);
      if (targetLayer?.locked) {
        return;
      }
      dragStateRef.current = {
        kind: "move",
        objectId: targetObject.id,
        startPoint: point,
        originalObject: cloneTransformDocument(targetObject),
        history: captureDragHistory() ?? {
          beforeDocument: cloneTransformDocument(documentState),
          beforeSelection: getCurrentHistorySelection(),
        },
      };
    },
    [
      activeTool,
      activeLetteringKind,
      applyDocumentMutation,
      buildRasterSamplingContext,
      captureDragHistory,
      convertPointerToSource,
      currentPaintLayer,
      documentState,
      dirtyPaintLayerIdsRef,
      drawPaintSegment,
      ensureActivePaintLayer,
      fillActivePaintLayer,
      getLetteringDefaultText,
      getLetteringShapeLabel,
      getCurrentHistorySelection,
      handleMetrics,
      layouts,
      mode,
      pan,
      paintCanvasCacheRef,
      replaceDocument,
      rasterSelection,
      sampleColor,
      selectRasterByColor,
      selectedObjectId,
      setViewportModeManual,
      spacePressed,
      schedulePaintTransactionPreview,
      t,
      updateEditCursorPosition,
    ],
  );

  const handleViewportWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!activeSurfaceGeometry || !transformedSurfaceRef.current) {
        return;
      }
      event.preventDefault();
      const rect = transformedSurfaceRef.current.getBoundingClientRect();
      const currentScale = surfaceScale || 1;
      const surfacePoint = {
        x: clamp((event.clientX - rect.left) / currentScale, 0, activeSurfaceGeometry.width),
        y: clamp((event.clientY - rect.top) / currentScale, 0, activeSurfaceGeometry.height),
      };
      const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
      const nextZoom = clamp(zoom * zoomFactor, 0.4, 4);
      const nextScale = fitScale * nextZoom;
      if (Object.is(nextZoom, zoom)) {
        return;
      }

      setViewportModeManual();
      setZoom(nextZoom);
      setPan((currentPan) => ({
        x: currentPan.x + (currentScale - nextScale) * (surfacePoint.x - activeSurfaceGeometry.width / 2),
        y: currentPan.y + (currentScale - nextScale) * (surfacePoint.y - activeSurfaceGeometry.height / 2),
      }));
    },
    [activeSurfaceGeometry, fitScale, setPan, setViewportModeManual, setZoom, surfaceScale, transformedSurfaceRef, zoom],
  );

  const handleCanvasDoubleClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!documentState || mode !== "edit") {
        return;
      }
      const point = convertPointerToSource(event);
      if (!point) {
        return;
      }
      const hitLayout = findObjectAtPoint(layouts, point);
      if (!hitLayout) {
        handleFitToViewport();
        return;
      }
      const targetLayer = documentState.edit.layers.find((layer) => layer.kind === "text_object" && layer.refId === hitLayout.objectId);
      setSelectedObjectId(hitLayout.objectId);
      setSelectedLayerId(targetLayer?.id || null);
      setEditingObjectId(hitLayout.objectId);
      editingDirtyRef.current = false;
    },
    [convertPointerToSource, documentState, handleFitToViewport, layouts, mode],
  );

  const updateCurrentObject = React.useCallback(
    (mutate: (object: TransformTextObject) => void, options?: { pushHistory?: boolean }) => {
      if (!selectedObjectId) {
        return;
      }
      applyDocumentMutation(
        (current) => {
          const target = current.edit.textObjects.find((object) => object.id === selectedObjectId);
          const layer = current.edit.layers.find((candidate) => candidate.kind === "text_object" && candidate.refId === selectedObjectId);
          if (!target || layer?.locked) {
            return current;
          }
          mutate(target);
          return current;
        },
        options,
      );
    },
    [applyDocumentMutation, selectedObjectId],
  );

  const handleLetteringShapeChange = React.useCallback(
    (kind: TransformTextObjectKind) => {
      setActiveLetteringKind(kind);
      if (currentObject) {
        updateCurrentObject((object) => {
          retargetTransformTextObjectKind(object, kind);
        });
        return;
      }
      if (activeTool !== "lettering") {
        setEditTool("lettering");
      }
    },
    [activeTool, currentObject, setEditTool, updateCurrentObject],
  );

  const handleAutoSizeLettering = React.useCallback(() => {
    if (!currentObject || currentObject.kind === "free_text") {
      return;
    }
    updateCurrentObject((object) => {
      const geometry = getTextBoxSafeGeometry(object);
      const metrics = getTextContentMetrics(object, geometry, currentLayout);
      const inset = object.padding * 2 + object.strokeWidth * 2 + 20;
      object.width = clamp(
        Math.ceil(metrics.width + inset),
        120,
        (documentRef.current?.sourceImage.width ?? object.width) * 2,
      );
      object.height = clamp(
        Math.ceil(metrics.height + inset),
        72,
        (documentRef.current?.sourceImage.height ?? object.height) * 2,
      );
    });
  }, [currentLayout, currentObject, updateCurrentObject]);

  const handleFitTextToBubble = React.useCallback(() => {
    if (!currentObject) {
      return;
    }
    updateCurrentObject((object) => {
      let low = 8;
      let high = object.fontSize;
      let best = low;
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const candidate = (low + high) / 2;
        const candidateObject = { ...object, fontSize: candidate };
        const geometry = getTextBoxSafeGeometry(candidateObject);
        const metrics = estimateTextContentMetrics(candidateObject, geometry);
        if (
          metrics.width <= geometry.innerWidth &&
          metrics.height <= geometry.innerHeight
        ) {
          best = candidate;
          low = candidate;
        } else {
          high = candidate;
        }
      }
      object.fontSize = Math.max(8, Math.floor(best * 10) / 10);
    });
  }, [currentObject, updateCurrentObject]);

  const commitColorDraft = React.useCallback(
    (field: ColorInspectorField) => {
      if (!selectedObjectId) {
        return;
      }
      const draftValue = colorDraftsRef.current[field];
      if (!draftValue) {
        return;
      }
      let changed = false;
      const nextDocument = applyDocumentMutation((current) => {
        const target = current.edit.textObjects.find((object) => object.id === selectedObjectId);
        if (!target) {
          return current;
        }
        changed = target[field] !== draftValue;
        target[field] = draftValue;
        return current;
      }, { pushHistory: false });
      if (changed && nextDocument) {
        pushHistory(nextDocument);
      }
    },
    [applyDocumentMutation, pushHistory, selectedObjectId],
  );

  const applyTextBoxPosition = React.useCallback(
    (
      horizontal: TextBoxHorizontalPosition,
      vertical: TextBoxVerticalPosition,
    ) => {
      updateCurrentObject((object) => {
        const sourceImage = documentRef.current?.sourceImage;
        const geometry = getTextBoxSafeGeometry(object);
        const metrics = getTextContentMetrics(object, geometry, currentLayout);
        const nextOffset = getTextBoxPositionOffset(object, horizontal, vertical, sourceImage, metrics);
        object.textOffsetX = nextOffset.x;
        object.textOffsetY = nextOffset.y;
      });
    },
    [currentLayout, updateCurrentObject],
  );

  const getNumericFieldBounds = React.useCallback(
    (field: NumericInspectorField): NumericFieldBounds => {
      if (field === "width") {
        return { min: 120, max: documentRef.current ? Math.max(120, documentRef.current.sourceImage.width * 2) : 9999 };
      }
      if (field === "height") {
        return { min: 72, max: documentRef.current ? Math.max(72, documentRef.current.sourceImage.height * 2) : 9999 };
      }
      if (field === "tailWidth") {
        const object = documentRef.current?.edit.textObjects.find((candidate) => candidate.id === selectedObjectId);
        const maxAttachmentWidth = object ? Math.min(object.width, object.height) * 0.9 : 120;
        return { min: 8, max: Math.max(8, maxAttachmentWidth) };
      }
      if (field === "fontSize") {
        const sourceImage = documentRef.current?.sourceImage;
        return {
          min: STATIC_NUMERIC_BOUNDS.fontSize.min,
          max: sourceImage ? transformFontSizeMaxForSource(sourceImage) : STATIC_NUMERIC_BOUNDS.fontSize.max,
        };
      }
      if (field === "strokeWidth") {
        const sourceImage = documentRef.current?.sourceImage;
        return {
          min: STATIC_NUMERIC_BOUNDS.strokeWidth.min,
          max: sourceImage ? transformStrokeWidthMaxForSource(sourceImage) : STATIC_NUMERIC_BOUNDS.strokeWidth.max,
        };
      }
      if (field === "padding") {
        const object = documentRef.current?.edit.textObjects.find((candidate) => candidate.id === selectedObjectId);
        return {
          min: STATIC_NUMERIC_BOUNDS.padding.min,
          max: object ? transformPaddingMaxForObject(object) : STATIC_NUMERIC_BOUNDS.padding.max,
        };
      }
      if (field === "textOffsetX") {
        const object = documentRef.current?.edit.textObjects.find((candidate) => candidate.id === selectedObjectId);
        const sourceImage = documentRef.current?.sourceImage;
        const max = object && sourceImage
          ? transformTextOffsetXMax(object, sourceImage)
          : STATIC_NUMERIC_BOUNDS.textOffsetX.max;
        return { min: -max, max };
      }
      if (field === "textOffsetY") {
        const object = documentRef.current?.edit.textObjects.find((candidate) => candidate.id === selectedObjectId);
        const sourceImage = documentRef.current?.sourceImage;
        const max = object && sourceImage
          ? transformTextOffsetYMax(object, sourceImage)
          : STATIC_NUMERIC_BOUNDS.textOffsetY.max;
        return { min: -max, max };
      }
      return STATIC_NUMERIC_BOUNDS[field];
    },
    [selectedObjectId],
  );

  const resetNumericDraft = React.useCallback((field: NumericInspectorField) => {
    const object = documentRef.current?.edit.textObjects.find((candidate) => candidate.id === selectedObjectId);
    if (!object) {
      return;
    }
    setNumericDrafts((prev) => ({
      ...prev,
      [field]: formatNumericDraft(object[field]),
    }));
  }, [selectedObjectId]);

  const commitNumericDraft = React.useCallback(
    (field: NumericInspectorField) => {
      const object = documentRef.current?.edit.textObjects.find((candidate) => candidate.id === selectedObjectId);
      if (!object) {
        return;
      }
      const rawDraft = numericDrafts[field] ?? formatNumericDraft(object[field]);
      const trimmedDraft = rawDraft.trim();
      const parsedValue = Number(trimmedDraft);
      if (trimmedDraft === "" || !Number.isFinite(parsedValue)) {
        setNumericDrafts((prev) => ({
          ...prev,
          [field]: formatNumericDraft(object[field]),
        }));
        return;
      }

      const bounds = getNumericFieldBounds(field);
      const nextValue = clamp(parsedValue, bounds.min, bounds.max);
      setNumericDrafts((prev) => ({
        ...prev,
        [field]: formatNumericDraft(nextValue),
      }));
      if (Object.is(object[field], nextValue)) {
        return;
      }
      updateCurrentObject((target) => {
        target[field] = nextValue;
      });
    },
    [getNumericFieldBounds, numericDrafts, selectedObjectId, updateCurrentObject],
  );

  const renderNumericField = (
    field: NumericInspectorField,
    label: string,
  ) => {
    const object = currentObject;
    const bounds = getNumericFieldBounds(field);
    return (
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        <Input
          type="number"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={object ? numericDrafts[field] ?? formatNumericDraft(object[field]) : ""}
          onChange={(event) => {
            setNumericDrafts((prev) => ({
              ...prev,
              [field]: event.target.value,
            }));
          }}
          onBlur={() => commitNumericDraft(field)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commitNumericDraft(field);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              resetNumericDraft(field);
            }
          }}
          className="border-border bg-surface text-foreground"
        />
      </label>
    );
  };

  const commitCropNumericDraft = React.useCallback((field: NumericCropField) => {
    const current = documentRef.current;
    if (!current) return;
    const rawDraft = cropNumericDrafts[field] ?? "";
    const parsedValue = Number(rawDraft.trim());
    if (!Number.isFinite(parsedValue)) {
      setCropNumericDrafts((prev) => ({
        ...prev,
        [field]: formatNumericDraft(current.edit.crop[field]),
      }));
      return;
    }
    applyDocumentMutation((next) => {
      const crop = next.edit.crop;
      if (field === "x") crop.x = clamp(parsedValue, 0, next.sourceImage.width - crop.width);
      if (field === "y") crop.y = clamp(parsedValue, 0, next.sourceImage.height - crop.height);
      if (field === "width") crop.width = clamp(parsedValue, 1, next.sourceImage.width - crop.x);
      if (field === "height") crop.height = clamp(parsedValue, 1, next.sourceImage.height - crop.y);
      crop.enabled = true;
      return next;
    });
  }, [applyDocumentMutation, cropNumericDrafts]);

  const renderCropNumericField = (field: NumericCropField, label: string) => (
    <label className="space-y-1">
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={field === "width" || field === "height" ? 1 : 0}
        value={cropNumericDrafts[field] ?? ""}
        onChange={(event) => setCropNumericDrafts((prev) => ({ ...prev, [field]: event.target.value }))}
        onBlur={() => commitCropNumericDraft(field)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commitCropNumericDraft(field);
          }
        }}
        className="border-border bg-surface text-foreground"
      />
    </label>
  );

  const renderColorField = (
    field: ColorInspectorField,
    label: string,
  ) => {
    const object = currentObject;
    const fallbackValue =
      object && field === "fillColor" && object.fillColor === "rgba(255,255,255,0)"
        ? "#ffffff"
        : object?.[field] ?? "#000000";
    return (
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
        <Input
          type="color"
          value={colorDrafts[field] ?? fallbackValue}
          onChange={(event) => {
            const nextColor = event.target.value;
            colorDraftsRef.current = {
              ...colorDraftsRef.current,
              [field]: nextColor,
            };
            setColorDrafts((prev) => ({
              ...prev,
              [field]: nextColor,
            }));
          }}
          onBlur={() => commitColorDraft(field)}
          className="h-10 border-border bg-surface p-1"
        />
      </label>
    );
  };

  const handleTextChange = React.useCallback(
    (value: string) => {
      if (!editingDirtyRef.current) {
        editingHistoryStartRef.current = captureDragHistory();
      }
      editingDirtyRef.current = true;
      updateCurrentObject((object) => {
        object.text = value;
      }, { pushHistory: false });
    },
    [captureDragHistory, updateCurrentObject],
  );

  const commitEditingHistory = React.useCallback(() => {
    if (editingDirtyRef.current && documentRef.current) {
      pushHistory(documentRef.current, {
        beforeDocument: editingHistoryStartRef.current?.beforeDocument,
        beforeSelection: editingHistoryStartRef.current?.beforeSelection,
        afterSelection: getCurrentHistorySelection(),
      });
      editingDirtyRef.current = false;
      editingHistoryStartRef.current = null;
    }
  }, [getCurrentHistorySelection, pushHistory]);

  const handleDuplicate = React.useCallback(() => {
    if (!selectedObjectId || !documentState) {
      return;
    }
    const selectedLayer = documentState.edit.layers.find(
      (layer) => layer.refId === selectedObjectId,
    );
    const result = selectedLayer?.kind === "image_layer"
      ? duplicateTransformImageLayer(documentState, selectedObjectId)
      : duplicateTransformObject(documentState, selectedObjectId);
    const duplicatedLayer = result.duplicatedId
      ? result.document.edit.layers.find((layer) => layer.refId === result.duplicatedId)
      : null;
    replaceDocument(result.document, {
      afterSelection: {
        selectedObjectId: result.duplicatedId,
        selectedLayerId: duplicatedLayer?.id || null,
        editingObjectId: null,
      },
    });
    setSelectedObjectId(result.duplicatedId);
    setSelectedLayerId(duplicatedLayer?.id || null);
  }, [documentState, replaceDocument, selectedObjectId]);

  const handleDeleteObject = React.useCallback(() => {
    if (!selectedObjectId || !documentState) {
      return;
    }
    const selectedLayer = documentState.edit.layers.find(
      (layer) => layer.refId === selectedObjectId,
    );
    const next = selectedLayer
      ? deleteTransformLayer(documentState, selectedLayer.id)
      : deleteTransformObject(documentState, selectedObjectId);
    replaceDocument(next, {
      afterSelection: {
        selectedObjectId: null,
        selectedLayerId: null,
        editingObjectId: null,
      },
    });
    setSelectedObjectId(null);
    setSelectedLayerId(null);
    setEditingObjectId(null);
  }, [documentState, replaceDocument, selectedObjectId]);

  const updateSelectedLayer = React.useCallback(
    (mutate: (layer: TransformLayer) => void, options?: { pushHistory?: boolean }) => {
      if (!selectedLayerId) {
        return;
      }
      applyDocumentMutation((current) => updateTransformLayer(current, selectedLayerId, mutate), options);
    },
    [applyDocumentMutation, selectedLayerId],
  );

  const handleDeleteLayer = React.useCallback(async (requestedLayerId?: string) => {
    const layerId = requestedLayerId || selectedLayerId;
    if (!layerId || !documentState) {
      return;
    }
    const targetLayer = documentState.edit.layers.find((layer) => layer.id === layerId);
    const beforeSelection = getCurrentHistorySelection();
    let paintDiffs: TransformHistoryPaintDiff[] | undefined;
    if (targetLayer?.kind === "paint_layer") {
      let beforeCanvas = paintCanvasCacheRef.current.get(targetLayer.refId);
      const paintLayer = documentState.edit.paintLayers.find((layer) => layer.id === targetLayer.refId);
      if (!beforeCanvas && paintLayer) {
        beforeCanvas = await createCanvasFromPaintLayer(paintLayer, documentState.sourceImage);
      }
      const beforeContext = beforeCanvas?.getContext("2d");
      if (beforeCanvas && beforeContext) {
        const transaction = new RasterTileTransaction(targetLayer.refId, beforeContext);
        transaction.touch({
          x: 0,
          y: 0,
          width: beforeCanvas.width,
          height: beforeCanvas.height,
        });
        beforeContext.clearRect(0, 0, beforeCanvas.width, beforeCanvas.height);
        const diff = transaction.commit();
        paintDiffs = diff ? [diff] : undefined;
      }
      paintCanvasCacheRef.current.delete(targetLayer.refId);
      pendingPaintLayerFilesRef.current.delete(targetLayer.refId);
      dirtyPaintLayerIdsRef.current.delete(targetLayer.refId);
    } else if (targetLayer?.kind === "image_layer") {
      imageLayerImageCacheRef.current.delete(targetLayer.refId);
    }
    const next = deleteTransformLayer(documentState, layerId);
    replaceDocument(next, {
      beforeSelection,
      afterSelection: {
        selectedObjectId: null,
        selectedLayerId: null,
        editingObjectId: null,
      },
      paintDiffs,
      label: "Delete layer",
      affectedLayerIds: targetLayer ? [targetLayer.refId] : [],
    });
    setSelectedLayerId(null);
    setSelectedObjectId(null);
    setEditingObjectId(null);
  }, [dirtyPaintLayerIdsRef, documentState, getCurrentHistorySelection, imageLayerImageCacheRef, paintCanvasCacheRef, pendingPaintLayerFilesRef, replaceDocument, selectedLayerId]);

  const handleBringSelectedIntoFrame = React.useCallback(() => {
    if (!currentLayer || currentLayer.kind !== "text_object" || !documentState) {
      return;
    }
    const next = bringTransformTextObjectIntoFrame(documentState, currentLayer.refId);
    replaceDocument(next);
  }, [currentLayer, documentState, replaceDocument]);

  const handleFitSelectedLayer = React.useCallback(() => {
    const selectedVisual = currentObject || currentImageLayer;
    if (!selectedVisual || !editCanvasGeometry || !viewportRef.current) {
      return;
    }
    const rect = viewportRef.current.getBoundingClientRect();
    const availableWidth = Math.max(rect.width - 128, 1);
    const availableHeight = Math.max(rect.height - 128, 1);
    const selectionWidth = Math.max(selectedVisual.width, 1);
    const selectionHeight = Math.max(selectedVisual.height, 1);
    const nextZoom = clamp(
      Math.min(availableWidth / selectionWidth, availableHeight / selectionHeight) / Math.max(fitScale, 0.01),
      0.4,
      4,
    );
    const nextScale = fitScale * nextZoom;
    const selectionCenterX = selectedVisual.x + selectedVisual.width / 2 + editCanvasGeometry.offsetX;
    const selectionCenterY = selectedVisual.y + selectedVisual.height / 2 + editCanvasGeometry.offsetY;
    setViewportModeManual();
    setZoom(nextZoom);
    setPan({
      x: -(selectionCenterX - editCanvasGeometry.width / 2) * nextScale,
      y: -(selectionCenterY - editCanvasGeometry.height / 2) * nextScale,
    });
  }, [currentImageLayer, currentObject, editCanvasGeometry, fitScale, setPan, setViewportModeManual, setZoom, viewportRef]);

  const reloadOverwrittenImage = React.useCallback(
    async (imagePath: string) => {
      await loadLaunch({
        imagePath,
        initialMode: "edit",
        workspaceProjectSlug: null,
        workspaceFolder: null,
      });
    },
    [loadLaunch],
  );

  const handleTransformExported = React.useCallback(
    async (response?: TransformExportResponse) => {
      const isCurrent = captureSession();
      const operation = deliveryOperationRef.current;
      await onExported?.(response);
      if (!response || !isCurrent()) {
        return;
      }
      setDeliveryNotice({
        operation,
        filename: response.filename,
        folder: response.folder ?? null,
      });
    },
    [captureSession, onExported],
  );

  const {
    exportState,
    exportMessage,
    handleExport,
    handleMaskSave,
    handleMaskDraftChange,
  } = useTransformDelivery({
    active: open,
    sessionKey: transformSessionKey,
    maskDraftSaveRef,
    documentState,
    documentRef,
    sourceElement,
    launchImagePathRef,
    lastSavedDocumentRef,
    targetProjectSlug,
    exportTargetFolder,
    maskTargetFolder,
    buildCompositeCanvas,
    flushDirtyPaintLayers,
    setSaveState,
    onExported: handleTransformExported,
    reloadAfterOverwrite: reloadOverwrittenImage,
  });

  const [outpaintingPipeSheetOpen, setOutpaintingPipeSheetOpen] = React.useState(false);
  const [outpaintPreparing, setOutpaintPreparing] = React.useState(false);
  const [outpaintPreparation, setOutpaintPreparation] = React.useState<TransformOutpaintPrepareResponse | null>(null);
  const preparationScopeKey = JSON.stringify([transformSessionKey, targetProjectSlug, mode, documentState?.edit.expansion]);
  const capturePreparation = useTransformOperationScope(preparationScopeKey, open);
  React.useEffect(() => {
    setOutpaintPreparing(false); setOutpaintPreparation(null);
    setOutpaintingPipeSheetOpen(false);
  }, [transformSessionKey, open]);
  const prepareOutpaint = React.useCallback(async (options: { engineId?: number; stageInputs?: boolean } = {}) => {
    const isCurrent = capturePreparation();
    const requireCurrent = () => {
      if (!isCurrent()) throw new DOMException("The Transform session changed.", "AbortError");
    };
    requireCurrent();
    setOutpaintPreparing(true); setExpansionError(null);
    try {
      await document.fonts.ready;
      requireCurrent();
      await maskSurfaceRef.current?.flushDraft();
      requireCurrent();
      await flushDirtyPaintLayers();
      requireCurrent();
      if (mode === "mask" && !maskSurfaceState.isReady) throw new Error("Wait for the expanded mask to finish loading.");
      const current = documentRef.current;
      if (!current?.edit.expansion) throw new Error("Choose an expansion frame first.");
      const saved = await api.saveTransformDocument(current);
      requireCurrent();
      if (documentRef.current !== current) throw new Error("The composition changed. Prepare the updated image again.");
      documentRef.current = saved.document; lastSavedDocumentRef.current = saved.document;
      const canvas = await buildCompositeCanvas(saved.document);
      requireCurrent();
      if (!canvas) throw new Error("The expanded composition is unavailable.");
      const coverageFile = mode === "mask" && maskSurfaceState.isReady ? await maskSurfaceRef.current?.getCoverageFile() : null;
      requireCurrent();
      const compositionFile = await toBlob(canvas, "image/png");
      requireCurrent();
      if (documentRef.current !== saved.document) throw new Error("The composition changed. Prepare the updated image again.");
      const result = await api.prepareTransformOutpaint({ document: saved.document, compositionFile,
        coverageFile, engineId: options.engineId, stageInputs: options.stageInputs,
        projectSlug: targetProjectSlug || current.project.slug, subfolder: "input" });
      requireCurrent();
      setOutpaintPreparation(result);
      return result;
    } catch (error) {
      if (isCurrent()) setExpansionError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { if (isCurrent()) setOutpaintPreparing(false); }
  }, [capturePreparation, buildCompositeCanvas, flushDirtyPaintLayers, lastSavedDocumentRef, maskSurfaceState.isReady, mode, targetProjectSlug]);

  const handleLocalizedMaskSave = React.useCallback(
    async (maskFile: File) => {
      deliveryOperationRef.current = "mask";
      setDeliveryNotice(null);
      await handleMaskSave(maskFile);
    },
    [handleMaskSave],
  );

  const handleMaskSettingsChange = React.useCallback((maskState: TransformMaskState) => {
    const current = documentRef.current;
    if (!current || JSON.stringify(current.mask) === JSON.stringify(maskState)) {
      return;
    }
    const next = cloneTransformDocument(current);
    next.mask = { ...maskState, coverageAssetPath: current.mask.coverageAssetPath, draftPath: current.mask.draftPath,
      baseCoverageAssetPath: current.mask.baseCoverageAssetPath, coverageFrame: current.mask.coverageFrame };
    next.lastUsedMode = "mask";
    next.updatedAt = new Date().toISOString();
    documentRef.current = next;
    scheduleAutosave({
      publishResponse: false,
      updateStatus: false,
    });
  }, [scheduleAutosave]);

  const handleMaskSurfaceStateChange = React.useCallback((
    nextState: MaskCanvasSurfaceState,
  ) => {
    setMaskSurfaceState((currentState) => {
      const nextVisibleState: MaskCanvasSurfaceState = {
        ...nextState,
        historyBytes:
          rightDockTab === "history"
            ? nextState.historyBytes
            : currentState.historyBytes,
        draftState:
          nextState.draftState === "error"
            ? "error"
            : currentState.draftState === "error" && nextState.draftState === "saved"
              ? "saved"
              : currentState.draftState,
      };
      const unchanged = (
        Object.keys(nextVisibleState) as Array<keyof MaskCanvasSurfaceState>
      ).every((key) => Object.is(nextVisibleState[key], currentState[key]));
      return unchanged ? currentState : nextVisibleState;
    });
  }, [rightDockTab]);

  const handleTargetProjectChange = React.useCallback((value: string) => {
    const nextProjectSlug = value === NONE_SELECT_VALUE ? "" : value;
    setTargetProjectSlug(nextProjectSlug);
    setExportTargetFolder("");
    setMaskTargetFolder(nextProjectSlug || sourceProjectSlug ? "masks" : "");
  }, [sourceProjectSlug]);

  const handleExportSheetSubmit = React.useCallback(async () => {
    if (!documentState || exportState === "exporting") {
      return;
    }
    if (exportSaveMode === "overwrite_current") {
      const targetPath = launchImagePathRef.current || documentState.sourceImage.path;
      if (
        !targetPath ||
        !window.confirm(t("confirm.overwriteCurrentPath", { path: targetPath }))
      ) {
        return;
      }
      deliveryOperationRef.current = "overwrite_current";
      setDeliveryNotice(null);
      const response = await handleExport("overwrite_current");
      if (response) setExportSheetComplete(true);
      return;
    }
    let requestedFilename = exportFilename.trim();
    if (exportRequiresAlpha && !requestedFilename.toLowerCase().endsWith(".png")) {
      requestedFilename = `${requestedFilename.replace(/\.[^.]+$/, "") || "transform"}.png`;
      setExportFilename(requestedFilename);
    }
    deliveryOperationRef.current = "new_copy";
    setDeliveryNotice(null);
    const response = await handleExport("new_copy", { filename: requestedFilename });
    if (response) setExportSheetComplete(true);
  }, [
    documentState,
    exportFilename,
    exportRequiresAlpha,
    exportSaveMode,
    exportState,
    handleExport,
    t,
  ]);

  const handleDialogOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        onOpenChange(true);
        return;
      }
      const isCurrent = captureSession();
      void (async () => {
        try {
          setSaveState("saving");
          await maskSurfaceRef.current?.flushDraft();
          if (!isCurrent()) return;
          await flushDirtyPaintLayers();
          if (!isCurrent()) return;
          const current = documentRef.current;
          if (current) {
            const paintLayerFiles = [...pendingPaintLayerFilesRef.current.entries()].map(
              ([layerId, file]) => ({ layerId, file }),
            );
            const response = await api.saveTransformDocument(current, {
              paintLayerFiles,
            });
            if (!isCurrent()) return;
            if (documentRef.current !== current) {
              setSaveState("dirty");
              return;
            }
            for (const { layerId, file } of paintLayerFiles) {
              if (pendingPaintLayerFilesRef.current.get(layerId) === file) pendingPaintLayerFilesRef.current.delete(layerId);
            }
            documentRef.current = response.document;
            setDocumentState(response.document);
            lastSavedDocumentRef.current = response.document;
          }
          setSaveState("saved");
          onOpenChange(false);
        } catch (error) {
          if (!isCurrent()) return;
          console.error("Failed to flush Transform before close", error);
          setSaveState("error");
        }
      })();
    },
    [
      captureSession,
      flushDirtyPaintLayers,
      lastSavedDocumentRef,
      onOpenChange,
      pendingPaintLayerFilesRef,
    ],
  );

  const handleCreatePaintLayer = React.useCallback(async () => {
    const isCurrent = captureSession();
    if (!documentState) {
      return;
    }
    const nextTool: TransformEditTool =
      activeTool === "pencil" || activeTool === "brush"
        ? activeTool
        : "brush";
    const beforeSelection = getCurrentHistorySelection();
    const paintLayer = createTransformPaintLayer(documentState.sourceImage, "paint");
    const layerEntry = createTransformPaintLayerEntry(paintLayer, documentState.edit.layers.length);
    const nextDocument = cloneTransformDocument(documentState);
    nextDocument.edit.paintLayers.push(paintLayer);
    nextDocument.edit.layers.push(layerEntry);
    nextDocument.edit.lastUsedTool = nextTool;
    nextDocument.lastUsedMode = "edit";
    nextDocument.updatedAt = new Date().toISOString();
    nextDocument.text = {
      objects: nextDocument.edit.textObjects,
      layers: nextDocument.edit.layers.filter((layer) => layer.kind === "text_object"),
    };
    const canvas = await createCanvasFromPaintLayer(paintLayer, nextDocument.sourceImage);
    if (!isCurrent() || documentRef.current !== documentState) return;
    paintCanvasCacheRef.current.set(paintLayer.id, canvas);
    replaceDocument(nextDocument, {
      beforeSelection,
      afterSelection: {
        selectedObjectId: null,
        selectedLayerId: layerEntry.id,
        editingObjectId: null,
      },
      label: "Create paint layer",
      affectedLayerIds: [paintLayer.id],
    });
    renderCompositePreview();
    setActiveTool(nextTool);
    setSelectedLayerId(layerEntry.id);
    setSelectedObjectId(null);
    setEditingObjectId(null);
  }, [captureSession, activeTool, documentState, getCurrentHistorySelection, paintCanvasCacheRef, renderCompositePreview, replaceDocument]);

  const importImageBlob = React.useCallback(async (
    blob: Blob,
    options?: {
      sourcePath?: string | null;
      name?: string | null;
      center?: { x: number; y: number } | null;
    },
  ) => {
    const isCurrent = captureSession();
    if (!documentRef.current || !blob.type.startsWith("image/")) {
      return null;
    }
    const dataUrl = await readImageBlobAsDataUrl(blob);
    if (!isCurrent()) return null;
    const dimensions = await getImageDimensionsFromDataUrl(dataUrl);
    if (!isCurrent()) return null;
    const current = documentRef.current;
    if (!current) return null;
    const imageLayer = createTransformImageLayer({
      intrinsicWidth: dimensions.width,
      intrinsicHeight: dimensions.height,
      sourceWidth: current.sourceImage.width,
      sourceHeight: current.sourceImage.height,
      dataUrl,
      sourcePath: options?.sourcePath,
      center: options?.center,
    });
    const layerEntry = createTransformImageLayerEntry(
      imageLayer,
      current.edit.layers.length,
      options?.name?.replace(/\.[^.]+$/, "") || undefined,
    );
    const image = await createImageElementFromTransformLayer(imageLayer);
    if (!isCurrent() || documentRef.current?.id !== current.id) return null;
    // Add the new layer to the latest same-session edits after decoding.
    const next = cloneTransformDocument(documentRef.current);
    next.edit.imageLayers.push(imageLayer);
    next.edit.layers.push(layerEntry);
    next.edit.lastUsedTool = "select";
    next.updatedAt = new Date().toISOString();
    if (image) {
      image.dataset.transformSource = dataUrl;
      imageLayerImageCacheRef.current.set(imageLayer.id, image);
    }
    replaceDocument(next, {
      afterSelection: {
        selectedObjectId: imageLayer.id,
        selectedLayerId: layerEntry.id,
        editingObjectId: null,
      },
      label: "Import image layer",
      affectedLayerIds: [imageLayer.id],
    });
    setActiveTool("select");
    setSelectedObjectId(imageLayer.id);
    setSelectedLayerId(layerEntry.id);
    setEditingObjectId(null);
    setRasterSelection(null);
    renderCompositePreview();
    return imageLayer;
  }, [captureSession, imageLayerImageCacheRef, renderCompositePreview, replaceDocument]);

  const importImagePath = React.useCallback(async (
    path: string,
    center?: { x: number; y: number } | null,
  ) => {
    const isCurrent = captureSession();
    const response = await fetch(buildImageUrl(path));
    if (!isCurrent()) return null;
    if (!response.ok) {
      throw new Error("Failed to load the dropped Studio image.");
    }
    const blob = await response.blob();
    if (!isCurrent()) return null;
    return importImageBlob(blob, {
      sourcePath: path,
      name: path.split(/[\\/]/).pop() || "image",
      center,
    });
  }, [captureSession, importImageBlob]);

  const getSelectedPaintContext = React.useCallback(() => {
    const current = documentRef.current;
    const layerId = selectedLayerIdRef.current;
    if (!current || !layerId) {
      return null;
    }
    const layerEntry = current.edit.layers.find(
      (layer) => layer.id === layerId && layer.kind === "paint_layer",
    );
    const canvas = layerEntry
      ? paintCanvasCacheRef.current.get(layerEntry.refId)
      : null;
    const context = canvas?.getContext("2d") ?? null;
    return layerEntry && canvas && context
      ? { current, layerEntry, canvas, context }
      : null;
  }, [paintCanvasCacheRef]);

  const copyRasterSelection = React.useCallback(async () => {
    const active = getSelectedPaintContext();
    if (!active || !rasterSelection) {
      return null;
    }
    const selectionCanvas = extractRasterSelection(active.context, rasterSelection);
    if (!selectionCanvas) {
      return null;
    }
    const blob = await toBlob(selectionCanvas, "image/png");
    rasterClipboardRef.current = blob;
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
      } catch {
        // The in-workspace clipboard remains available when browser clipboard
        // permission is denied or the page is not in a secure context.
      }
    }
    return blob;
  }, [getSelectedPaintContext, rasterSelection]);

  const pasteRasterSelectionAsLayer = React.useCallback(async () => {
    const isCurrent = captureSession();
    let blob = rasterClipboardRef.current;
    if (!blob && navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        const imageType = items
          .flatMap((item) => item.types)
          .find((type) => type.startsWith("image/"));
        const item = imageType
          ? items.find((candidate) => candidate.types.includes(imageType))
          : null;
        blob = item && imageType ? await item.getType(imageType) : null;
      } catch {
        blob = null;
      }
    }
    if (blob && isCurrent()) {
      await importImageBlob(blob, { name: "Pasted selection" });
    }
  }, [captureSession, importImageBlob]);

  const deleteSelectedPixels = React.useCallback(async () => {
    const active = getSelectedPaintContext();
    const history = captureDragHistory();
    if (!active || !history || !rasterSelection) {
      return;
    }
    const transaction = new RasterTileTransaction(active.layerEntry.refId, active.context);
    deleteRasterSelection(active.context, rasterSelection, transaction);
    dirtyPaintLayerIdsRef.current.add(active.layerEntry.refId);
    scheduleCompositePreview();
    await commitPaintCanvasHistory({
      layerId: active.layerEntry.refId,
      transaction,
      history,
      label: "Delete selected pixels",
    });
    setRasterSelection(null);
  }, [
    captureDragHistory,
    commitPaintCanvasHistory,
    dirtyPaintLayerIdsRef,
    getSelectedPaintContext,
    rasterSelection,
    scheduleCompositePreview,
  ]);

  const createLayerFromRasterSelection = React.useCallback(async () => {
    const active = getSelectedPaintContext();
    const current = documentRef.current;
    if (!active || !current || !rasterSelection) {
      return;
    }
    const extracted = extractRasterSelection(active.context, rasterSelection);
    if (!extracted) {
      return;
    }
    const paintLayer = createTransformPaintLayer(current.sourceImage, "paint");
    const layerEntry = createTransformPaintLayerEntry(paintLayer, current.edit.layers.length);
    layerEntry.name = "Selection copy";
    const canvas = document.createElement("canvas");
    canvas.width = current.sourceImage.width;
    canvas.height = current.sourceImage.height;
    canvas.getContext("2d")?.drawImage(
      extracted,
      Math.floor(rasterSelection.bounds.x),
      Math.floor(rasterSelection.bounds.y),
    );
    paintLayer.dataUrl = canvas.toDataURL("image/png");
    paintCanvasCacheRef.current.set(paintLayer.id, canvas);
    dirtyPaintLayerIdsRef.current.add(paintLayer.id);
    const next = cloneTransformDocument(current);
    next.edit.paintLayers.push(paintLayer);
    next.edit.layers.push(layerEntry);
    replaceDocument(next, {
      afterSelection: {
        selectedObjectId: null,
        selectedLayerId: layerEntry.id,
        editingObjectId: null,
      },
      label: "Create layer from selection",
      affectedLayerIds: [paintLayer.id],
    });
    setSelectedLayerId(layerEntry.id);
    setSelectedObjectId(null);
    scheduleCompositePreview();
  }, [
    dirtyPaintLayerIdsRef,
    getSelectedPaintContext,
    paintCanvasCacheRef,
    rasterSelection,
    replaceDocument,
    scheduleCompositePreview,
  ]);

  React.useEffect(() => {
    if (!open || mode !== "edit") {
      return;
    }
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, [contenteditable='true']") ||
        !event.clipboardData
      ) {
        return;
      }
      const imageFile = [...event.clipboardData.files].find((file) =>
        file.type.startsWith("image/"),
      );
      if (imageFile) {
        event.preventDefault();
        void importImageBlob(imageFile, { name: imageFile.name || "Pasted image" });
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [importImageBlob, mode, open]);

  React.useEffect(() => {
    if (!open || mode !== "edit" || !rasterSelection) {
      return;
    }
    const handleSelectionShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) {
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        void deleteSelectedPixels();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copyRasterSelection();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteRasterSelectionAsLayer();
      }
    };
    window.addEventListener("keydown", handleSelectionShortcut, true);
    return () => window.removeEventListener("keydown", handleSelectionShortcut, true);
  }, [
    copyRasterSelection,
    deleteSelectedPixels,
    mode,
    open,
    pasteRasterSelectionAsLayer,
    rasterSelection,
  ]);

  const handleCanvasDragOver = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (
      event.dataTransfer.types.includes(SWEET_TEA_IMAGE_DRAG_MIME) ||
      [...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))
    ) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleCanvasDrop = React.useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    const studioPath = event.dataTransfer.getData(SWEET_TEA_IMAGE_DRAG_MIME).trim();
    const imageFiles = [...event.dataTransfer.files].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!studioPath && !imageFiles.length) {
      return;
    }
    event.preventDefault();
    const center = convertPointerToSource(
      event as unknown as React.MouseEvent,
      { clampToSource: true },
    );
    if (studioPath) {
      await importImagePath(studioPath, center);
      return;
    }
    for (const file of imageFiles) {
      await importImageBlob(file, { name: file.name, center });
    }
  }, [convertPointerToSource, importImageBlob, importImagePath]);

  const selectedLayerIndex = React.useMemo(
    () => documentState?.edit.layers.findIndex((layer) => layer.id === selectedLayerId) ?? -1,
    [documentState, selectedLayerId],
  );

  const handleLayerSelect = React.useCallback((layer: TransformLayer) => {
    setSelectedLayerId(layer.id);
    setSelectedObjectId(
      layer.kind === "text_object" || layer.kind === "image_layer"
        ? layer.refId
        : null,
    );
    setEditingObjectId(null);
  }, []);

  const handleLayerDrop = React.useCallback((sourceId: string, targetId: string) => {
    if (!documentRef.current) {
      return;
    }
    replaceDocument(
      moveTransformLayer(documentRef.current, sourceId, targetId),
      {
        label: "Reorder layers",
        affectedLayerIds: [sourceId, targetId],
      },
    );
  }, [replaceDocument]);

  const mutateLayerById = React.useCallback((
    layerId: string,
    mutate: (layer: TransformLayer) => void,
    options?: { pushHistory?: boolean; label?: string },
  ) => {
    applyDocumentMutation(
      (current) => updateTransformLayer(current, layerId, mutate),
      {
        pushHistory: options?.pushHistory,
        label: options?.label,
        affectedLayerIds: [layerId],
      },
    );
  }, [applyDocumentMutation]);

  const handleMaskPanStart = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    setViewportModeManual();
    dragStateRef.current = {
      kind: "pan",
      startClient: { x: event.clientX, y: event.clientY },
      originalPan: pan,
      currentPan: pan,
    };
  }, [pan, setViewportModeManual]);

  const handleUndoHistory = () => {
    if (mode === "mask") {
      if (maskSurfaceState.canUndo) {
        maskSurfaceRef.current?.undo();
      }
      return;
    }
    if (!canUndo) {
      return;
    }
    void applyHistoryStep("undo");
  };
  const handleRedoHistory = () => {
    if (mode === "mask") {
      if (maskSurfaceState.canRedo) {
        maskSurfaceRef.current?.redo();
      }
      return;
    }
    if (!canRedo) {
      return;
    }
    void applyHistoryStep("redo");
  };

  const renderMaskControls = () => {
    const previewUrl = maskSurfaceRef.current?.getOutputPreviewDataUrl(260);
    return (
      <div className="space-y-4">
        <section className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("mask.view")}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {(["overlay", "mask", "image"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={maskSurfaceState.viewMode === value ? "default" : "outline"}
                aria-pressed={maskSurfaceState.viewMode === value}
                onClick={() => maskSurfaceRef.current?.setViewMode(value)}
                className="h-8 px-2 text-[11px]"
              >
                {t(`mask.views.${value}`)}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-2 rounded-xl border border-border bg-surface/70 p-3">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("mask.outputPreview")}
          </div>
          <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border bg-black">
            {previewUrl ? (
              <img src={previewUrl} alt={t("mask.outputPreview")} className="h-full w-full object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">{t("mask.noCoverage")}</span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-1">
            {(["white", "black"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={maskSurfaceState.paintedPixels === value ? "default" : "outline"}
                aria-pressed={maskSurfaceState.paintedPixels === value}
                onClick={() => maskSurfaceRef.current?.setPaintedPixels(value)}
                className="h-auto min-h-8 whitespace-normal px-2 py-1.5 text-center text-[11px] leading-tight"
              >
                {value === "white" ? t("mask.paintedWhite") : t("mask.paintedBlack")}
              </Button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("mask.overlay")}
          </div>
          <div className="grid grid-cols-[54px_minmax(0,1fr)] items-center gap-2">
            <Input
              type="color"
              aria-label={t("mask.overlayColor")}
              value={maskSurfaceState.overlayColor}
              onChange={(event) => maskSurfaceRef.current?.setOverlayColor(event.target.value)}
              className="h-9 p-1"
            />
            <Slider
              aria-label={t("mask.overlayOpacity")}
              min={0.05}
              max={1}
              step={0.05}
              value={[maskSurfaceState.overlayOpacity]}
              onValueChange={(value) => maskSurfaceRef.current?.setOverlayOpacity(value[0] ?? 0.55)}
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("mask.edgeOperations")}
          </div>
          <Input
            type="number"
            min={1}
            max={256}
            value={maskOperationRadius}
            aria-label={t("mask.operationRadius")}
            onChange={(event) => setMaskOperationRadius(clamp(Number(event.target.value), 1, 256))}
            className="h-8"
          />
          <div className="grid grid-cols-3 gap-1">
            <Button type="button" size="sm" variant="outline" disabled={maskSurfaceState.isBusy} onClick={() => {
              void maskSurfaceRef.current?.featherCoverage(maskOperationRadius);
            }} className="h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-center text-[11px] leading-tight">
              {t("mask.feather")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={maskSurfaceState.isBusy} onClick={() => {
              void maskSurfaceRef.current?.growCoverage(maskOperationRadius);
            }} className="h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-center text-[11px] leading-tight">
              {t("mask.grow")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={maskSurfaceState.isBusy} onClick={() => {
              void maskSurfaceRef.current?.shrinkCoverage(maskOperationRadius);
            }} className="h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-center text-[11px] leading-tight">
              {t("mask.shrink")}
            </Button>
          </div>
        </section>

        <div className="grid grid-cols-3 gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => maskSurfaceRef.current?.invertCoverage()} className="h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-center text-[11px] leading-tight">
            {t("mask.invertCoverage")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => maskSurfaceRef.current?.fillAll()} className="h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-center text-[11px] leading-tight">
            {t("mask.fillAll")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => maskSurfaceRef.current?.clear()} className="h-auto min-h-8 min-w-0 whitespace-normal px-1 py-1 text-center text-[11px] leading-tight text-destructive">
            {t("actions.clear")}
          </Button>
        </div>
      </div>
    );
  };

  const renderLetteringShapePicker = (className = "") => (
    <div className={cn("space-y-2", className)}>
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {t("lettering.shape")}
      </span>
      <div className="grid grid-cols-2 gap-2">
        {LETTERING_SHAPE_OPTIONS.map((kind) => {
          const label = getLetteringShapeLabel(kind);
          const isActive = (currentObject?.kind ?? activeLetteringKind) === kind;
          return (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant={isActive ? "default" : "outline"}
              aria-pressed={isActive}
              title={label}
              onClick={() => handleLetteringShapeChange(kind)}
              className="min-w-0 justify-start px-2 text-[11px]"
            >
              {kind === "speech_bubble" || kind === "thought_bubble" ? (
                <MessageSquare className="mr-1 h-3.5 w-3.5 shrink-0" />
              ) : kind === "narration_box" || kind === "narration_rect" ? (
                <FileText className="mr-1 h-3.5 w-3.5 shrink-0" />
              ) : (
                <Type className="mr-1 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate">{label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );

  const renderSelectedLayerControls = () => {
    if (mode !== "edit" || !currentLayer) {
      return null;
    }
    return (
      <details open className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("layers.selected")}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={currentLayer.visible ? t("layers.hide") : t("layers.show")}
              onClick={(event) => {
                event.stopPropagation();
                updateSelectedLayer((layer) => {
                  layer.visible = !layer.visible;
                });
              }}
              className="h-8 w-8 p-0"
            >
              {currentLayer.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={currentLayer.locked ? t("layers.unlock") : t("layers.lock")}
              onClick={(event) => {
                event.stopPropagation();
                updateSelectedLayer((layer) => {
                  layer.locked = !layer.locked;
                });
              }}
              className="h-8 w-8 p-0"
            >
              {currentLayer.locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
            </Button>
            <span className="text-sm leading-none text-muted-foreground transition-transform group-open:rotate-90">&gt;</span>
          </div>
        </summary>
        <div className="mt-3 space-y-3">
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t("layers.name")}
            </span>
            <Input
              aria-label={t("layers.nameAria")}
              value={currentLayer.name}
              onChange={(event) => updateSelectedLayer((layer) => {
                layer.name = event.target.value;
              }, { pushHistory: false })}
              onBlur={() => {
                if (documentRef.current) {
                  pushHistory(documentRef.current);
                }
              }}
              className="h-9 border-border bg-surface text-foreground"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t("layers.opacity", {
                percent: formatLocalizedNumber(currentLayer.opacity, {
                  style: "percent",
                  maximumFractionDigits: 0,
                }),
              })}
            </span>
            <Input
              aria-label={t("layers.opacityAria")}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={currentLayer.opacity}
              onChange={(event) => updateSelectedLayer((layer) => {
                layer.opacity = clamp(Number(event.target.value), 0, 1);
              }, { pushHistory: false })}
              onPointerUp={() => {
                if (documentRef.current) {
                  pushHistory(documentRef.current);
                }
              }}
              className="h-9 border-border bg-surface text-foreground"
            />
          </label>
          <div className="grid grid-cols-1 gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!documentState || !selectedLayerId || selectedLayerIndex === -1 || selectedLayerIndex >= documentState.edit.layers.length - 1}
              onClick={() => {
                if (!documentState || !selectedLayerId) return;
                replaceDocument(reorderTransformLayer(documentState, selectedLayerId, 1));
              }}
              className="min-w-0 justify-center whitespace-normal px-2 text-xs leading-tight"
            >
              {t("actions.sendBack")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!selectedLayerId || selectedLayerIndex <= 0}
              onClick={() => {
                if (!documentState || !selectedLayerId) return;
                replaceDocument(reorderTransformLayer(documentState, selectedLayerId, -1));
              }}
              className="min-w-0 justify-center whitespace-normal px-2 text-xs leading-tight"
            >
              {t("actions.bringForward")}
            </Button>
            {(currentLayer.kind === "text_object" || currentLayer.kind === "image_layer") && (
              <>
                {currentLayer.kind === "text_object" && (
                <Button type="button" variant="outline" onClick={handleBringSelectedIntoFrame} className="min-w-0 justify-center whitespace-normal px-2 text-xs leading-tight">
                  {t("layers.bringIntoFrame")}
                </Button>
                )}
                <Button type="button" variant="outline" onClick={handleFitSelectedLayer} className="min-w-0 justify-center whitespace-normal px-2 text-xs leading-tight">
                  {t("layers.fitSelected")}
                </Button>
              </>
            )}
            <Button type="button" variant="destructive" onClick={() => {
              void handleDeleteLayer();
            }}>
              <Trash2 className="mr-1 h-4 w-4" />
              {t("layers.delete")}
            </Button>
          </div>
        </div>
      </details>
    );
  };

  const contextNumber = (
    label: string,
    value: number,
    options: {
      min: number;
      max: number;
      step?: number;
      onChange: (value: number) => void;
      width?: string;
    },
  ) => (
    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="whitespace-nowrap">{label}</span>
      <Input
        type="number"
        min={options.min}
        max={options.max}
        step={options.step ?? 1}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) {
            options.onChange(clamp(next, options.min, options.max));
          }
        }}
        className={cn("h-8 bg-surface px-2 text-right text-xs", options.width ?? "w-[72px]")}
      />
    </label>
  );

  const contextToggle = (
    label: string,
    checked: boolean,
    onCheckedChange: (checked: boolean) => void,
  ) => (
    <label className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[11px] text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className="accent-primary"
      />
      <span className="whitespace-nowrap">{label}</span>
    </label>
  );

  const updateRetouchSettings = (
    mutate: (settings: TransformDocument["edit"]["retouchSettings"]) => void,
  ) => {
    applyDocumentMutation((current) => {
      mutate(current.edit.retouchSettings);
      return current;
    }, { pushHistory: false });
  };

  const renderContextBarV2 = () => {
    if (!documentState) {
      return <span className="px-2 text-xs text-muted-foreground">{t("loading")}</span>;
    }
    if (mode === "mask") {
      const brushTool =
        maskSurfaceState.tool === "add" ||
        maskSurfaceState.tool === "subtract";
      const shapeTool =
        maskSurfaceState.tool === "rectangle" ||
        maskSurfaceState.tool === "lasso" ||
        maskSurfaceState.tool === "fill";
      return (
        <>
          <span className="rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-foreground">
            {getToolLabel(maskSurfaceState.tool)}
          </span>
          {shapeTool && (
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              {(["add", "subtract"] as const).map((operation) => (
                <Button
                  key={operation}
                  type="button"
                  size="sm"
                  variant={maskSurfaceState.shapeOperation === operation ? "default" : "ghost"}
                  onClick={() => maskSurfaceRef.current?.setShapeOperation(operation)}
                  className="h-7 px-2 text-[11px]"
                >
                  {operation === "add" ? t("mask.add") : t("mask.subtract")}
                </Button>
              ))}
            </div>
          )}
          {brushTool && contextNumber(t("paint.size"), maskSurfaceState.brushSize, {
            min: 1,
            max: 1024,
            onChange: (value) => maskSurfaceRef.current?.setBrushSize(value),
          })}
          {brushTool && contextNumber(t("paint.hardness"), maskSurfaceState.hardness, {
            min: 0,
            max: 1,
            step: 0.05,
            onChange: (value) => maskSurfaceRef.current?.setHardness(value),
          })}
          {maskSurfaceState.tool !== "pan" && contextNumber(t("mask.strength"), maskSurfaceState.strength, {
            min: 0.01,
            max: 1,
            step: 0.05,
            onChange: (value) => maskSurfaceRef.current?.setStrength(value),
          })}
          {(brushTool || shapeTool) && contextNumber(t("mask.feather"), maskSurfaceState.feather, {
            min: 0,
            max: 256,
            onChange: (value) => maskSurfaceRef.current?.setFeather(value),
          })}
          {brushTool && contextNumber(t("mask.overlayOpacity"), maskSurfaceState.overlayOpacity, {
            min: 0.05,
            max: 1,
            step: 0.05,
            onChange: (value) => maskSurfaceRef.current?.setOverlayOpacity(value),
          })}
          {maskSurfaceState.tool === "fill" && contextNumber(t("paint.tolerance"), maskSurfaceState.fillTolerance, {
            min: 0,
            max: 255,
            onChange: (value) => maskSurfaceRef.current?.setFillTolerance(value),
          })}
          <span className="text-[11px] text-muted-foreground">
            {maskSurfaceState.hasCoverage ? t("mask.coverageReady") : t("mask.noCoverage")}
          </span>
        </>
      );
    }

    const paintSettings = documentState.edit.paintSettings;
    const retouch = documentState.edit.retouchSettings;
    const updatePaint = (
      mutate: (settings: TransformDocument["edit"]["paintSettings"]) => void,
    ) => applyDocumentMutation((current) => {
      mutate(current.edit.paintSettings);
      return current;
    }, { pushHistory: false });

    if (activeTool === "select") {
      return (
        <>
          <span className="rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-foreground">
            {t("tools.objectSelect")}
          </span>
          {currentObject || currentImageLayer ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={handleDuplicate} className="h-8 px-2 text-[11px]">
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t("actions.duplicate")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={handleDeleteObject} className="h-8 px-2 text-[11px] text-destructive">
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {t("actions.delete")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={handleFitSelectedLayer} className="h-8 px-2 text-[11px]">
                {t("layers.fitSelected")}
              </Button>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t("viewport.objectSelectHint")}</span>
          )}
        </>
      );
    }

    if (activeTool === "rect_select" || activeTool === "select_by_color") {
      return (
        <>
          <span className="rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-foreground">
            {activeTool === "rect_select" ? t("tools.rectSelect") : t("tools.selectByColor")}
          </span>
          {activeTool === "select_by_color" && contextNumber(t("paint.tolerance"), retouch.fill.tolerance, {
            min: 0,
            max: 255,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.fill.tolerance = value;
            }),
          })}
          {activeTool === "select_by_color" && contextToggle(t("paint.contiguous"), retouch.fill.contiguous, (checked) => {
            updateRetouchSettings((settings) => {
              settings.fill.contiguous = checked;
            });
          })}
          {activeTool === "select_by_color" && contextToggle(t("paint.sampleMerged"), retouch.fill.sampleMerged, (checked) => {
            updateRetouchSettings((settings) => {
              settings.fill.sampleMerged = checked;
            });
          })}
          <Button type="button" size="sm" variant="outline" disabled={!rasterSelection} onClick={() => {
            void copyRasterSelection();
          }} className="h-8 px-2 text-[11px]">
            <Copy className="mr-1 h-3.5 w-3.5" />
            {t("selection.copy")}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => {
            void pasteRasterSelectionAsLayer();
          }} className="h-8 px-2 text-[11px]">
            <ImagePlus className="mr-1 h-3.5 w-3.5" />
            {t("selection.pasteLayer")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!rasterSelection} onClick={() => {
            void createLayerFromRasterSelection();
          }} className="h-8 px-2 text-[11px]">
            <Layers3 className="mr-1 h-3.5 w-3.5" />
            {t("selection.newLayer")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!rasterSelection} onClick={() => {
            void applyPixelateSelection();
          }} className="h-8 px-2 text-[11px]">
            {t("paint.applyPixelate")}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!rasterSelection} onClick={() => {
            void deleteSelectedPixels();
          }} className="h-8 px-2 text-[11px] text-destructive">
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t("selection.delete")}
          </Button>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Move className="h-3.5 w-3.5" />
            {rasterSelection ? t("selection.dragToMove") : t("selection.drawHint")}
          </span>
        </>
      );
    }

    if (activeTool === "lettering") {
      return (
        <>
          <span className="text-[11px] text-muted-foreground">{t("lettering.shape")}</span>
          <Select
            value={currentObject?.kind ?? activeLetteringKind}
            onValueChange={(value) => handleLetteringShapeChange(value as TransformTextObjectKind)}
          >
            <SelectTrigger className="h-8 w-[170px] bg-surface text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTERING_SHAPE_OPTIONS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {getLetteringShapeLabel(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentObject && (
            <Select
              value={
                availableFontOptions.includes(currentObject.fontFamily)
                  ? currentObject.fontFamily
                  : MISSING_FONT_SELECT_VALUE
              }
              onValueChange={(value) => updateCurrentObject((object) => {
                if (value !== MISSING_FONT_SELECT_VALUE) {
                  object.fontFamily = value;
                }
              })}
            >
              <SelectTrigger
                aria-label={t("text.fontAria")}
                className="h-8 w-[180px] min-w-0 bg-surface text-xs [&>span]:truncate"
              >
                <SelectValue placeholder={t("text.selectFont")} />
              </SelectTrigger>
              <SelectContent className="max-h-[min(var(--radix-select-content-available-height),16rem)]">
                {!availableFontOptions.includes(currentObject.fontFamily) && (
                  <SelectItem value={MISSING_FONT_SELECT_VALUE} disabled>
                    {t("text.importFontSettings", { font: currentObject.fontFamily })}
                  </SelectItem>
                )}
                {availableFontOptions.map((font) => (
                  <SelectItem key={font} value={font}>{font}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {currentObject && contextNumber(t("text.size"), currentObject.fontSize, {
            min: 8,
            max: transformFontSizeMaxForSource(documentState.sourceImage),
            onChange: (value) => updateCurrentObject((object) => {
              object.fontSize = value;
            }, { pushHistory: false }),
          })}
          {currentObject && (
            <>
              <div className="flex rounded-md border border-border bg-surface p-0.5">
                {([
                  ["left", AlignLeft, t("text.alignLeft")],
                  ["center", AlignCenter, t("text.alignCenter")],
                  ["right", AlignRight, t("text.alignRight")],
                ] as const).map(([alignment, Icon, label]) => (
                  <Button
                    key={alignment}
                    type="button"
                    size="sm"
                    variant={currentObject.textAlign === alignment ? "default" : "ghost"}
                    aria-label={label}
                    title={label}
                    onClick={() => updateCurrentObject((object) => {
                      object.textAlign = alignment;
                    })}
                    className="h-7 w-8 p-0"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </Button>
                ))}
              </div>
              <Button type="button" size="sm" variant="outline" onClick={handleAutoSizeLettering} className="h-8 px-2 text-[11px]">
                {t("lettering.autoSize")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={handleFitTextToBubble} className="h-8 px-2 text-[11px]">
                {t("lettering.fitText")}
              </Button>
            </>
          )}
        </>
      );
    }

    if (activeTool === "pencil" || activeTool === "brush" || activeTool === "eraser") {
      const size =
        activeTool === "pencil"
          ? paintSettings.pencilThicknessPx
          : activeTool === "eraser"
            ? paintSettings.eraserThicknessPx
            : paintSettings.brushThicknessPx;
      return (
        <>
          {activeTool !== "eraser" && (
            <Input
              type="color"
              aria-label={t("paint.color")}
              value={paintColorDraft}
              onChange={(event) => {
                updatePaintColorDraft(event.target.value);
                commitPaintColor(event.target.value, { pushHistory: false });
              }}
              className="h-8 w-10 bg-surface p-1"
            />
          )}
          {contextNumber(t("paint.size"), size, {
            min: 1,
            max: 512,
            onChange: (value) => updatePaint((settings) => {
              if (activeTool === "pencil") settings.pencilThicknessPx = value;
              else if (activeTool === "eraser") settings.eraserThicknessPx = value;
              else settings.brushThicknessPx = value;
            }),
          })}
          {activeTool !== "pencil" && contextNumber(t("paint.hardness"),
            activeTool === "eraser" ? paintSettings.eraserHardness : paintSettings.brushHardness, {
              min: 0,
              max: 1,
              step: 0.05,
              onChange: (value) => updatePaint((settings) => {
                if (activeTool === "eraser") settings.eraserHardness = value;
                else settings.brushHardness = value;
              }),
            })}
          {activeTool === "brush" && contextNumber(t("paint.opacity"), paintSettings.brushOpacity, {
            min: 0.05,
            max: 1,
            step: 0.05,
            onChange: (value) => updatePaint((settings) => {
              settings.brushOpacity = value;
            }),
          })}
          {activeTool === "brush" && contextNumber(t("paint.flow"), paintSettings.brushFlow, {
            min: 0.01,
            max: 1,
            step: 0.05,
            onChange: (value) => updatePaint((settings) => {
              settings.brushFlow = value;
            }),
          })}
          {activeTool === "eraser" && contextNumber(t("paint.opacity"), paintSettings.eraserOpacity, {
            min: 0.01,
            max: 1,
            step: 0.05,
            onChange: (value) => updatePaint((settings) => {
              settings.eraserOpacity = value;
            }),
          })}
          {activeTool === "eraser" && (
            <div className="flex rounded-md border border-border bg-surface p-0.5">
              {(["paint", "source"] as const).map((target) => (
                <Button
                  key={target}
                  type="button"
                  size="sm"
                  variant={paintSettings.eraserTarget === target ? "default" : "ghost"}
                  onClick={() => updatePaint((settings) => {
                    settings.eraserTarget = target;
                  })}
                  className="h-7 px-2 text-[11px]"
                >
                  {target === "paint" ? t("paint.activeLayer") : t("paint.baseImage")}
                </Button>
              ))}
            </div>
          )}
        </>
      );
    }

    if (activeTool === "fill_bucket") {
      return (
        <>
          <Input
            type="color"
            aria-label={t("paint.color")}
            value={paintColorDraft}
            onChange={(event) => {
              updatePaintColorDraft(event.target.value);
              commitPaintColor(event.target.value, { pushHistory: false });
            }}
            className="h-8 w-10 p-1"
          />
          {contextNumber(t("paint.tolerance"), retouch.fill.tolerance, {
            min: 0,
            max: 255,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.fill.tolerance = value;
            }),
          })}
          {contextToggle(t("paint.contiguous"), retouch.fill.contiguous, (checked) => {
            updateRetouchSettings((settings) => {
              settings.fill.contiguous = checked;
            });
          })}
          {contextToggle(t("paint.sampleMerged"), retouch.fill.sampleMerged, (checked) => {
            updateRetouchSettings((settings) => {
              settings.fill.sampleMerged = checked;
            });
          })}
          {contextNumber(t("paint.opacity"), paintSettings.fillOpacity, {
            min: 0.01,
            max: 1,
            step: 0.05,
            onChange: (value) => updatePaint((settings) => {
              settings.fillOpacity = value;
            }),
          })}
        </>
      );
    }

    if (activeTool === "smudge") {
      return (
        <>
          {contextNumber(t("paint.size"), retouch.smudge.sizePx, {
            min: 1,
            max: 512,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.smudge.sizePx = value;
            }),
          })}
          {contextNumber(t("paint.hardness"), retouch.smudge.hardness, {
            min: 0,
            max: 1,
            step: 0.05,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.smudge.hardness = value;
            }),
          })}
          {contextNumber(t("paint.strength"), retouch.smudge.strength, {
            min: 0.01,
            max: 1,
            step: 0.05,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.smudge.strength = value;
            }),
          })}
          {contextToggle(t("paint.sampleMerged"), retouch.smudge.sampleMerged, (checked) => {
            updateRetouchSettings((settings) => {
              settings.smudge.sampleMerged = checked;
            });
          })}
        </>
      );
    }

    if (activeTool === "pixelate") {
      return (
        <>
          <div className="flex rounded-md border border-border bg-surface p-0.5">
            {(["brush", "selection"] as const).map((interactionMode) => (
              <Button
                key={interactionMode}
                type="button"
                size="sm"
                variant={retouch.pixelate.interactionMode === interactionMode ? "default" : "ghost"}
                onClick={() => {
                  setRasterSelection(null);
                  updateRetouchSettings((settings) => {
                    settings.pixelate.interactionMode = interactionMode;
                  });
                }}
                className="h-7 px-2 text-[11px]"
              >
                {interactionMode === "brush" ? t("paint.brushMode") : t("paint.selectionMode")}
              </Button>
            ))}
          </div>
          {retouch.pixelate.interactionMode === "brush" && contextNumber(t("paint.size"), retouch.pixelate.brushSizePx, {
            min: 1,
            max: 1024,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.pixelate.brushSizePx = value;
            }),
          })}
          {contextNumber(t("paint.blockSize"), retouch.pixelate.blockSizePx, {
            min: 2,
            max: 256,
            onChange: (value) => updateRetouchSettings((settings) => {
              settings.pixelate.blockSizePx = value;
            }),
          })}
          <Select
            value={retouch.pixelate.footprint}
            onValueChange={(value) => updateRetouchSettings((settings) => {
              settings.pixelate.footprint = value as "round" | "square";
            })}
          >
            <SelectTrigger className="h-8 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="round">{t("paint.round")}</SelectItem>
              <SelectItem value="square">{t("paint.square")}</SelectItem>
            </SelectContent>
          </Select>
          {contextToggle(t("paint.sampleMerged"), retouch.pixelate.sampleMerged, (checked) => {
            updateRetouchSettings((settings) => {
              settings.pixelate.sampleMerged = checked;
            });
          })}
          {retouch.pixelate.interactionMode === "selection" && (
            <Button
              type="button"
              size="sm"
              disabled={
                !rasterSelection ||
                rasterSelection.bounds.width < 1 ||
                rasterSelection.bounds.height < 1
              }
              onClick={() => {
                void applyPixelateSelection();
              }}
              className="h-8 px-3 text-[11px]"
            >
              {t("paint.applyPixelate")}
            </Button>
          )}
        </>
      );
    }

    if (activeTool === "crop") {
      return (
        <>
          <span className="text-[11px] text-muted-foreground">{t("crop.aspect")}</span>
          <Select
            value={documentState.edit.crop.aspectRatio}
            onValueChange={(value) => applyDocumentMutation((current) => {
              current.edit.crop.aspectRatio = value as TransformDocument["edit"]["crop"]["aspectRatio"];
              current.edit.crop.enabled = true;
              return current;
            }, { label: "Change crop ratio" })}
          >
            <SelectTrigger className="h-8 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["free", "source", "1:1", "4:3", "3:4", "16:9", "9:16"].map((value) => (
                <SelectItem key={value} value={value}>{value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" variant="outline" onClick={() => applyDocumentMutation((current) => {
            current.edit.crop = {
              ...current.edit.crop,
              enabled: false,
              x: 0,
              y: 0,
              width: current.sourceImage.width,
              height: current.sourceImage.height,
            };
            return current;
          }, { label: "Reset crop" })} className="h-8 px-2 text-[11px]">
            {t("actions.reset")}
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {Math.round(documentState.edit.crop.enabled ? documentState.edit.crop.width : documentState.sourceImage.width)}
            {" × "}
            {Math.round(documentState.edit.crop.enabled ? documentState.edit.crop.height : documentState.sourceImage.height)}
          </span>
        </>
      );
    }

    if (activeTool === "eyedropper") {
      return (
        <>
          {contextToggle(
            t("paint.sampleMerged"),
            paintSettings.eyedropperSampleMerged,
            (checked) => updatePaint((settings) => {
              settings.eyedropperSampleMerged = checked;
            }),
          )}
          <span className="text-[11px] text-muted-foreground">{t("viewport.sampleHint")}</span>
        </>
      );
    }

    return (
      <span className="text-[11px] text-muted-foreground">
        {t("viewport.panHint")}
      </span>
    );
  };

  const renderSourceOrientation = () => (
    <section className="space-y-3 rounded-xl border border-border bg-surface/65 p-3">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {t("sections.imageTransform")}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => nudgeSourceRotationDegrees(-90)} className="h-8 px-2 text-[11px]">
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          {t("imageTransform.rotateLeft")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => nudgeSourceRotationDegrees(90)} className="h-8 px-2 text-[11px]">
          <RotateCw className="mr-1 h-3.5 w-3.5" />
          {t("imageTransform.rotateRight")}
        </Button>
        <Button type="button" size="sm" variant={currentSourceImageTransform.flipHorizontal ? "default" : "outline"} onClick={() => toggleSourceFlip("flipHorizontal")} className="h-8 px-2 text-[11px]">
          <FlipHorizontal className="mr-1 h-3.5 w-3.5" />
          {t("imageTransform.flipHorizontal")}
        </Button>
        <Button type="button" size="sm" variant={currentSourceImageTransform.flipVertical ? "default" : "outline"} onClick={() => toggleSourceFlip("flipVertical")} className="h-8 px-2 text-[11px]">
          <FlipVertical className="mr-1 h-3.5 w-3.5" />
          {t("imageTransform.flipVertical")}
        </Button>
      </div>
      <label className="space-y-1">
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("imageTransform.angle")}</span>
        <Input
          type="number"
          min={-180}
          max={180}
          value={sourceRotationDraft}
          onChange={(event) => setSourceRotationDraft(event.target.value)}
          onBlur={() => {
            const value = Number(sourceRotationDraft);
            if (Number.isFinite(value)) setSourceRotationDegrees(value);
          }}
          className="h-8"
        />
      </label>
      <Button type="button" size="sm" variant="outline" disabled={isIdentityTransformSourceImageTransform(currentSourceImageTransform)} onClick={resetSourceImageTransform} className="h-8 w-full text-[11px]">
        {t("imageTransform.reset")}
      </Button>
    </section>
  );

  const renderAdjustmentsControls = () => {
    if (!documentState) {
      return null;
    }
    const adjustments = documentState.edit.adjustments;
    const controls: Array<{
      key: "brightness" | "contrast" | "saturation" | "hueDegrees";
      label: string;
      min: number;
      max: number;
      step: number;
      formatValue: (value: number) => string;
    }> = [
      {
        key: "brightness",
        label: t("adjustments.brightness"),
        min: 0,
        max: 2,
        step: 0.01,
        formatValue: (value) => `${Math.round(value * 100)}%`,
      },
      {
        key: "contrast",
        label: t("adjustments.contrast"),
        min: 0,
        max: 2,
        step: 0.01,
        formatValue: (value) => `${Math.round(value * 100)}%`,
      },
      {
        key: "saturation",
        label: t("adjustments.saturation"),
        min: 0,
        max: 2,
        step: 0.01,
        formatValue: (value) => `${Math.round(value * 100)}%`,
      },
      {
        key: "hueDegrees",
        label: t("adjustments.hue"),
        min: -180,
        max: 180,
        step: 1,
        formatValue: (value) => `${Math.round(value)}°`,
      },
    ];
    return (
      <section className="space-y-3 rounded-xl border border-border bg-surface/65 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {t("adjustments.title")}
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => {
            previewAdjustmentDraftRef.current = null;
            applyDocumentMutation((current) => {
              current.edit.adjustments = defaultTransformAdjustments();
              return current;
            }, { label: "Reset adjustments" });
          }} className="h-7 px-2 text-[10px]">
            {t("actions.reset")}
          </Button>
        </div>
        {controls.map((control) => (
          <TransformAdjustmentSlider
            key={control.key}
            adjustmentKey={control.key}
            label={control.label}
            min={control.min}
            max={control.max}
            step={control.step}
            value={adjustments[control.key]}
            formatValue={control.formatValue}
            onPreview={previewAdjustment}
            onCommit={commitAdjustment}
          />
        ))}
      </section>
    );
  };

  const renderInspectorV2 = () => {
    if (!documentState) {
      return null;
    }
    if (currentObject) {
      return (
        <div className="space-y-4">
          {currentTextOverflow && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {t("lettering.overflowWarning")}
            </div>
          )}
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("text.text")}</span>
            <Textarea
              value={currentObject.text}
              onChange={(event) => handleTextChange(event.target.value)}
              onBlur={commitEditingHistory}
              className="min-h-[92px] bg-surface text-sm"
            />
          </label>
          {renderLetteringShapePicker()}
          <div className="grid grid-cols-2 gap-2">
            {renderNumericField("width", t("text.width"))}
            {renderNumericField("height", t("text.height"))}
            {renderNumericField("rotation", t("text.rotation"))}
            {renderNumericField("padding", t("text.textInset"))}
            {renderNumericField("lineHeight", t("text.lineHeight"))}
            {renderNumericField("letterSpacing", t("text.letterSpacing"))}
            {renderNumericField("strokeWidth", t("text.stroke"))}
            {currentObject.kind === "speech_bubble" && renderNumericField("tailWidth", t("text.tailWidth"))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {renderColorField("textColor", t("text.text"))}
            {renderColorField("fillColor", t("text.fill"))}
            {renderColorField("strokeColor", t("text.stroke"))}
          </div>
          {currentObject.kind !== "free_text" && (
            <section className="space-y-2">
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {t("text.position")}
              </span>
              <div className="grid grid-cols-3 gap-1">
                {TEXT_BOX_POSITION_OPTIONS.map((option) => {
                  const textGeometry = getTextBoxSafeGeometry(currentObject);
                  const textMetrics = getTextContentMetrics(
                    currentObject,
                    textGeometry,
                    currentLayout,
                  );
                  const targetOffset = getTextBoxPositionOffset(
                    currentObject,
                    option.horizontal,
                    option.vertical,
                    documentState.sourceImage,
                    textMetrics,
                  );
                  const isActive =
                    Math.abs(currentObject.textOffsetX - targetOffset.x) < 0.5 &&
                    Math.abs(currentObject.textOffsetY - targetOffset.y) < 0.5;
                  return (
                    <Button
                      key={`${option.vertical}-${option.horizontal}`}
                      type="button"
                      size="sm"
                      variant={isActive ? "default" : "outline"}
                      title={getTextPositionLabel(option.horizontal, option.vertical)}
                      aria-label={getTextPositionLabel(option.horizontal, option.vertical)}
                      onClick={() => applyTextBoxPosition(option.horizontal, option.vertical)}
                      className="h-7 min-w-0 px-1 text-[9px]"
                    >
                      {getTextPositionLabel(option.horizontal, option.vertical)}
                    </Button>
                  );
                })}
              </div>
            </section>
          )}
          <div className="grid grid-cols-2 gap-2">
            {renderNumericField("textOffsetX", t("text.offsetX"))}
            {renderNumericField("textOffsetY", t("text.offsetY"))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" size="sm" variant="outline" onClick={handleAutoSizeLettering} className="h-8 text-[11px]">
              {t("lettering.autoSize")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={handleFitTextToBubble} className="h-8 text-[11px]">
              {t("lettering.fitText")}
            </Button>
          </div>
          {renderSelectedLayerControls()}
          {renderAdjustmentsControls()}
        </div>
      );
    }
    if (currentImageLayer) {
      const updateImageGeometry = (
        field: "x" | "y" | "width" | "height" | "rotation",
        value: number,
      ) => applyDocumentMutation((current) => {
        const imageLayer = current.edit.imageLayers.find(
          (layer) => layer.id === currentImageLayer.id,
        );
        if (imageLayer) {
          imageLayer[field] = field === "rotation"
            ? normalizeTransformSourceImageRotation(value)
            : field === "width" || field === "height"
              ? Math.max(1, value)
              : value;
          imageLayer.updatedAt = new Date().toISOString();
        }
        return current;
      }, { label: "Edit image layer" });
      return (
        <div className="space-y-4">
          <section className="space-y-3 rounded-xl border border-border bg-surface/65 p-3">
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {t("imageLayer.title")}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                ["x", t("crop.x")],
                ["y", t("crop.y")],
                ["width", t("crop.width")],
                ["height", t("crop.height")],
                ["rotation", t("text.rotation")],
              ] as const).map(([field, label]) => (
                <label key={field} className="space-y-1">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {label}
                  </span>
                  <Input
                    type="number"
                    value={Math.round(currentImageLayer[field] * 100) / 100}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) updateImageGeometry(field, value);
                    }}
                    className="h-8"
                  />
                </label>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("imageLayer.source", {
                source: currentImageLayer.sourcePath || t("imageLayer.localCopy"),
              })}
            </p>
          </section>
          {renderSelectedLayerControls()}
          {renderAdjustmentsControls()}
        </div>
      );
    }
    if (activeTool === "crop" || documentState.edit.crop.enabled) {
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {renderCropNumericField("x", t("crop.x"))}
            {renderCropNumericField("y", t("crop.y"))}
            {renderCropNumericField("width", t("crop.width"))}
            {renderCropNumericField("height", t("crop.height"))}
          </div>
          {renderSourceOrientation()}
          {renderAdjustmentsControls()}
        </div>
      );
    }
    if (
      activeTool === "brush" ||
      activeTool === "pencil" ||
      activeTool === "eraser" ||
      activeTool === "smudge" ||
      activeTool === "pixelate" ||
      currentPaintLayer
    ) {
      return (
        <div className="space-y-4">
          {(activeTool === "brush" || activeTool === "pencil") && (
            <section className="space-y-3 rounded-xl border border-border bg-surface/65 p-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("paint.strokeDynamics")}</div>
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {t("paint.hex")}
                </span>
                <Input
                  value={paintHexDraft}
                  onChange={(event) => setPaintHexDraft(event.target.value)}
                  onBlur={() => {
                    if (!commitPaintColor(paintHexDraft, { pushHistory: false })) {
                      setPaintHexDraft(paintColorDraftRef.current);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!commitPaintColor(paintHexDraft, { pushHistory: false })) {
                        setPaintHexDraft(paintColorDraftRef.current);
                      }
                    }
                  }}
                  className="h-8 bg-surface font-mono text-xs"
                />
              </label>
              {activeTool === "brush" && contextNumber(t("paint.spacing"), documentState.edit.paintSettings.brushSpacing, {
                min: 0.02,
                max: 2,
                step: 0.02,
                onChange: (value) => applyDocumentMutation((current) => {
                  current.edit.paintSettings.brushSpacing = value;
                  return current;
                }, { pushHistory: false }),
              })}
              {contextNumber(t("paint.smoothing"),
                activeTool === "pencil"
                  ? documentState.edit.paintSettings.pencilSmoothing
                  : documentState.edit.paintSettings.brushSmoothing, {
                  min: 0,
                  max: 0.95,
                  step: 0.05,
                  onChange: (value) => applyDocumentMutation((current) => {
                    if (activeTool === "pencil") current.edit.paintSettings.pencilSmoothing = value;
                    else current.edit.paintSettings.brushSmoothing = value;
                    return current;
                  }, { pushHistory: false }),
                })}
              {contextToggle(t("paint.pressureSize"), documentState.edit.paintSettings.pressureSize, (checked) => applyDocumentMutation((current) => {
                current.edit.paintSettings.pressureSize = checked;
                return current;
              }, { pushHistory: false }))}
              {contextToggle(t("paint.pressureOpacity"), documentState.edit.paintSettings.pressureOpacity, (checked) => applyDocumentMutation((current) => {
                current.edit.paintSettings.pressureOpacity = checked;
                return current;
              }, { pushHistory: false }))}
            </section>
          )}
          {renderSelectedLayerControls()}
          {renderAdjustmentsControls()}
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {renderSourceOrientation()}
        {renderAdjustmentsControls()}
        <p className="text-xs leading-relaxed text-muted-foreground">{t("text.neutralInstruction")}</p>
      </div>
    );
  };

  const activeRegistryTool =
    mode === "edit"
      ? getTransformTool("edit", activeTool)
      : getTransformTool("mask", maskSurfaceState.tool);
  const statusText =
    mode === "mask"
      ? `${getToolLabel(maskSurfaceState.tool)} · ${Math.round(maskSurfaceState.brushSize)} px`
      : `${activeRegistryTool?.commandLabel ?? getToolLabel(activeTool)}${currentLayer ? ` · ${currentLayer.name}` : ""} · ${localizedSaveState}`;
  const activeCursorSize =
    !documentState
      ? 0
      : activeTool === "pencil"
        ? documentState.edit.paintSettings.pencilThicknessPx
        : activeTool === "brush"
          ? documentState.edit.paintSettings.brushThicknessPx
          : activeTool === "eraser"
            ? documentState.edit.paintSettings.eraserThicknessPx
            : activeTool === "smudge"
              ? documentState.edit.retouchSettings.smudge.sizePx
              : activeTool === "pixelate"
                ? documentState.edit.retouchSettings.pixelate.brushSizePx
                : 0;
  const showEditCursor =
    mode === "edit" &&
    activeCursorSize > 0 &&
    !(activeTool === "pixelate" && documentState?.edit.retouchSettings.pixelate.interactionMode === "selection");
  const pixelBlockSize = documentState?.edit.retouchSettings.pixelate.blockSizePx ?? 0;
  const maskPreviewUrl = maskSurfaceRef.current?.getOutputPreviewDataUrl(360) ?? null;

  const layersPanel = (
    <>
      <input
        ref={imageLayerFileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(event) => {
          const files = [...(event.target.files || [])];
          event.target.value = "";
          void (async () => {
            for (const file of files) {
              await importImageBlob(file, { name: file.name });
            }
          })();
        }}
      />
      <TransformLayersPanel
      document={documentState}
      selectedLayerId={selectedLayerId}
      onSelect={handleLayerSelect}
      onToggleVisible={(layer) => mutateLayerById(layer.id, (target) => {
        target.visible = !target.visible;
      }, { label: layer.visible ? "Hide layer" : "Show layer" })}
      onToggleLock={(layer) => mutateLayerById(layer.id, (target) => {
        target.locked = !target.locked;
      }, { label: layer.locked ? "Unlock layer" : "Lock layer" })}
      onRename={(layer, name) => mutateLayerById(layer.id, (target) => {
        target.name = name;
      }, { pushHistory: false })}
      onDropLayer={handleLayerDrop}
      onCreateLayer={() => {
        void handleCreatePaintLayer();
      }}
      onImportImage={() => imageLayerFileInputRef.current?.click()}
      onDeleteLayer={(layer) => {
        void handleDeleteLayer(layer.id);
      }}
      labels={{
        count: (count) => t("layers.count", { count }),
        select: (name) => t("layers.selectAria", { name }),
        nameAria: t("layers.nameAria"),
        background: t("layers.background"),
        newLayer: t("layers.new"),
        importImage: t("layers.importImage"),
        empty: t("layers.empty"),
        hide: t("layers.hide"),
        show: t("layers.show"),
        lock: t("layers.lock"),
        unlock: t("layers.unlock"),
        delete: t("layers.delete"),
      }}
      />
    </>
  );

  const historyPanel = (
    <TransformHistoryPanel
      entries={historyState.entries}
      index={historyState.index}
      commandsLabel={t("history.commands", { count: historyState.index })}
      memoryLabel={t("history.memory", {
        size: (historyState.bytes / (1024 * 1024)).toFixed(1),
      })}
      emptyLabel={t("history.empty")}
    />
  );

  const rightDock = (
    <TransformRightDock
      mode={mode}
      activeTab={rightDockTab}
      onTabChange={setRightDockTab}
      inspector={<>{documentState?.edit.expansion && <ExpansionControls value={documentState.edit.expansion} onChange={handleExpansionChange} onMask={() => { setMode("mask"); setFitRevision(v => v + 1); }} />}{expansionError && <p role="alert" className="p-3 text-xs text-destructive">{expansionError}</p>}{renderInspectorV2()}</>}
      layers={layersPanel}
      history={historyPanel}
      mask={renderMaskControls()}
      labels={{
        inspector: t("sections.inspector"),
        layers: t("sections.layers"),
        history: t("sections.history"),
        mask: t("modes.mask"),
      }}
    />
  );

  const modeControl = (
    <div className="flex rounded-lg border border-border bg-surface p-0.5 shadow-xs">
      <Button type="button" variant="ghost" size="sm" onClick={() => void handleStartExpansion()} className="h-7 px-3 text-[11px]">{t("expand.title")}</Button>
      {(["edit", "mask"] as const).map((nextMode) => (
        <Button
          key={nextMode}
          type="button"
          size="sm"
          variant={mode === nextMode ? "default" : "ghost"}
          aria-pressed={mode === nextMode}
          onClick={() => {
            if (mode === "mask" && nextMode === "edit") {
              void maskSurfaceRef.current?.flushDraft();
            }
            setMode(nextMode);
            setFitRevision((revision) => revision + 1);
            setActiveTool("select");
            setRasterSelection(null);
            applyDocumentMutation((current) => {
              current.lastUsedMode = nextMode;
              if (nextMode === "edit") current.edit.lastUsedTool = "select";
              return current;
            }, { pushHistory: false });
          }}
          className="h-7 px-3 text-[11px]"
        >
          {nextMode === "edit" ? t("modes.edit") : t("modes.mask")}
        </Button>
      ))}
    </div>
  );

  const headerActions = (
    <>
      {documentState?.edit.expansion && <Button size="sm" disabled={outpaintPreparing} className="h-8 px-2 text-[11px]" onClick={() => setOutpaintingPipeSheetOpen(true)}>{t("expand.usePipe")}</Button>}
      {documentState?.edit.expansion && <Button size="sm" disabled={outpaintPreparing} className="h-8 px-2 text-[11px]" onClick={() => { void prepareOutpaint().catch(() => {}); }}>{t(outpaintPreparing ? "expand.preparing" : "expand.prepare")}</Button>}
      <Button type="button" size="sm" variant="ghost" aria-label={t("actions.undo")} title={t("actions.undo")} disabled={mode === "mask" ? !maskSurfaceState.canUndo : !canUndo} onClick={handleUndoHistory} className="h-8 w-8 p-0">
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button type="button" size="sm" variant="ghost" aria-label={t("actions.redo")} title={t("actions.redo")} disabled={mode === "mask" ? !maskSurfaceState.canRedo : !canRedo} onClick={handleRedoHistory} className="h-8 w-8 p-0">
        <Redo2 className="h-4 w-4" />
      </Button>
      <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
      <Button type="button" size="sm" variant="ghost" aria-label={t("actions.zoomOut")} onClick={() => {
        setViewportModeManual();
        setZoom((current) => clamp(current * 0.9, 0.4, 4));
      }} className="h-8 w-8 p-0">
        <ZoomOut className="h-4 w-4" />
      </Button>
      <span className="min-w-[46px] text-center text-[11px] text-muted-foreground">{localizedZoomLabel}</span>
      <Button type="button" size="sm" variant="ghost" aria-label={t("actions.zoomIn")} onClick={() => {
        setViewportModeManual();
        setZoom((current) => clamp(current * 1.1, 0.4, 4));
      }} className="h-8 w-8 p-0">
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button type="button" size="sm" variant="ghost" aria-label={t("actions.fitImage")} title={t("actions.fitImage")} onClick={handleFitToViewport} className="h-8 w-8 p-0">
        <ScanSearch className="h-4 w-4" />
      </Button>
      <Button type="button" size="sm" variant="ghost" aria-label={t("actions.toggleDock")} title={t("actions.toggleDock")} onClick={() => setRightDockOpen((value) => !value)} className="h-8 w-8 p-0 lg:hidden">
        <Layers3 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={mode === "mask" ? !maskSurfaceState.isReady : exportState === "exporting"}
        onClick={() => {
          if (mode === "mask") {
            setMaskSaveSheetOpen(true);
          } else {
            setExportSaveMode("new_copy");
            setExportSheetComplete(false);
            setDeliveryNotice(null);
            setExportSheetOpen(true);
          }
        }}
        className="ml-1 h-8 px-3 text-[11px]"
      >
        {exportState === "exporting" || maskSurfaceState.isSaving
          ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          : <Save className="mr-1 h-3.5 w-3.5" />}
        {mode === "mask" ? t("actions.saveMask") : t("actions.export")}
      </Button>
    </>
  );

  const canvasStage = (
    <div
      ref={setViewportNode}
      data-testid="transform-viewport"
      data-outpainting={Boolean(documentState?.edit.expansion)}
      className="relative h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_20%_0%,color-mix(in_srgb,var(--color-primary)_10%,transparent),transparent_36%),linear-gradient(135deg,var(--color-surface),var(--color-surface-raised))]"
      onWheel={handleViewportWheel}
    >
      {expansionError && <p role="alert" className="absolute bottom-3 left-3 z-40 max-w-md rounded bg-surface px-3 py-2 text-xs text-destructive">{expansionError}</p>}
      {outpaintPreparation && <div className="absolute bottom-3 right-3 z-40 flex gap-3 rounded border border-border bg-surface p-2 text-xs">
        {(["image", "mask", "alpha"] as const).map(role => <a key={role} href={buildImageUrl(outpaintPreparation.paths[role])} download={`outpaint_${role}.png`}>{role === "image" ? "Image" : role === "mask" ? "Mask" : "Alpha PNG"}</a>)}
        <button onClick={() => setOutpaintPreparation(null)} aria-label="Close prepared files">×</button>
      </div>}
      {launchLoading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm shadow-md">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            {t("loadingTransform")}
          </div>
        </div>
      )}
      {!launchLoading && launchError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {launchError}
          </div>
        </div>
      )}
      {!launchLoading && !launchError && documentState && sourceElement && fitReady && (
        <div className="flex h-full items-center justify-center p-4">
          <div
            ref={transformedSurfaceRef}
            data-testid="transform-image-surface"
            className="relative shrink-0"
            style={{
              width: activeSurfaceGeometry?.width ?? documentState.sourceImage.width,
              height: activeSurfaceGeometry?.height ?? documentState.sourceImage.height,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${surfaceScale})`,
              transformOrigin: "center center",
            }}
          >
            {mode === "edit" ? (
              <div
                data-testid="transform-edit-surface"
                className="absolute inset-0 touch-none"
                style={{
                  cursor:
                    activeTool === "pan"
                      ? "grab"
                      : showEditCursor
                        ? "none"
                        : activeTool === "select"
                          ? "default"
                          : "crosshair",
                }}
                onDragOver={handleCanvasDragOver}
                onDrop={(event) => {
                  void handleCanvasDrop(event);
                }}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={(event) => {
                  if (dragStateRef.current) return;
                  const point = convertPointerToSource(event, { clampToSource: true });
                  updateEditCursorPosition(point);
                }}
                onPointerLeave={() => {
                  if (!dragStateRef.current) updateEditCursorPosition(null);
                }}
                onDoubleClick={handleCanvasDoubleClick}
              >
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 h-full w-full rounded-xl shadow-[0_20px_70px_rgba(15,23,42,0.3)] dark:shadow-[0_20px_70px_rgba(0,0,0,0.52)]"
                />
                <canvas
                  ref={decorationCanvasRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full rounded-xl"
                />
                {currentCanvasLayout && (
                  <>
                    <div
                      className="pointer-events-none absolute border-2 border-sky-400/90"
                      style={{
                        left: currentCanvasLayout.bounds.x - handleMetrics.selectionInset,
                        top: currentCanvasLayout.bounds.y - handleMetrics.selectionInset,
                        width: currentCanvasLayout.bounds.width + handleMetrics.selectionInset * 2,
                        height: currentCanvasLayout.bounds.height + handleMetrics.selectionInset * 2,
                        borderWidth: handleMetrics.selectionStrokeWidth,
                        transform: `rotate(${currentCanvasLayout.rotation}deg)`,
                        transformOrigin: `${currentCanvasLayout.center.x - (currentCanvasLayout.bounds.x - handleMetrics.selectionInset)}px ${currentCanvasLayout.center.y - (currentCanvasLayout.bounds.y - handleMetrics.selectionInset)}px`,
                      }}
                    />
                    {currentRotationHandle && (
                      <>
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute origin-bottom border-l border-dashed border-sky-300"
                          style={{
                            left: currentRotationHandle.x,
                            top: currentRotationHandle.y,
                            height: handleMetrics.rotationHandleOffset,
                            transform: `rotate(${currentCanvasLayout.rotation}deg)`,
                          }}
                        />
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-200 bg-sky-600"
                          style={{
                            left: currentRotationHandle.x,
                            top: currentRotationHandle.y,
                            width: handleMetrics.handleSize,
                            height: handleMetrics.handleSize,
                            borderWidth: handleMetrics.borderWidth,
                          }}
                        />
                      </>
                    )}
                    {currentCanvasLayout.tailBase && (
                      <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-200 bg-sky-600" style={{ left: currentCanvasLayout.tailBase.x, top: currentCanvasLayout.tailBase.y, width: handleMetrics.handleSize, height: handleMetrics.handleSize, borderWidth: handleMetrics.borderWidth }} />
                    )}
                    {currentCanvasLayout.tailTip && (
                      <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-300 bg-sky-500" style={{ left: currentCanvasLayout.tailTip.x, top: currentCanvasLayout.tailTip.y, width: handleMetrics.handleSize, height: handleMetrics.handleSize, borderWidth: handleMetrics.borderWidth }} />
                    )}
                    {currentCanvasLayout.textHandle && (
                      <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-100 bg-cyan-400" style={{ left: currentCanvasLayout.textHandle.x, top: currentCanvasLayout.textHandle.y, width: handleMetrics.textHandleSize, height: handleMetrics.textHandleSize }} />
                    )}
                    {[currentCanvasLayout.resizeHandles.right, currentCanvasLayout.resizeHandles.bottom].map((handle, index) => (
                      <div key={index} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-200 bg-sky-500" style={{ left: handle.x, top: handle.y, width: handleMetrics.textHandleSize, height: handleMetrics.textHandleSize }} />
                    ))}
                    <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-sky-300 bg-sky-500" style={{ left: currentCanvasLayout.resizeHandles.corner.x, top: currentCanvasLayout.resizeHandles.corner.y, width: handleMetrics.handleSize, height: handleMetrics.handleSize }} />
                  </>
                )}

                {rasterSelection && (
                  <div
                    aria-label={t("selection.outline")}
                    className="pointer-events-none absolute border border-dashed border-white bg-primary/15 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                    style={{
                      left:
                        rasterSelection.bounds.x +
                        rasterSelectionMoveOffset.x +
                        (editCanvasGeometry?.offsetX ?? 0),
                      top:
                        rasterSelection.bounds.y +
                        rasterSelectionMoveOffset.y +
                        (editCanvasGeometry?.offsetY ?? 0),
                      width: rasterSelection.bounds.width,
                      height: rasterSelection.bounds.height,
                    }}
                  />
                )}

                {showEditCursor && (
                  <>
                    <div
                      ref={editCursorRef}
                      aria-hidden="true"
                      className="pointer-events-none absolute left-0 top-0 rounded-full border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.78)]"
                      style={{
                        display: "none",
                        width: activeCursorSize,
                        height: activeCursorSize,
                        borderRadius:
                          activeTool === "pixelate" &&
                          documentState.edit.retouchSettings.pixelate.footprint === "square"
                            ? 2
                            : "9999px",
                      }}
                    />
                    {activeTool === "pixelate" && (
                      <div
                        ref={pixelBlockCursorRef}
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-0 border border-amber-300/90"
                        style={{
                          display: "none",
                          width: pixelBlockSize,
                          height: pixelBlockSize,
                        }}
                      />
                    )}
                  </>
                )}

                {documentState.edit.expansion && <ExpansionHandles value={documentState.edit.expansion} scale={surfaceScale} onChange={handleExpansionChange} />}
                {editingObjectId && currentCanvasLayout && currentObject && (
                  <Textarea
                    aria-label={t("viewport.inlineTextEditor")}
                    ref={inlineEditorRef}
                    value={currentObject.text}
                    onChange={(event) => handleTextChange(event.target.value)}
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onBlur={() => {
                      setEditingObjectId(null);
                      commitEditingHistory();
                    }}
                    className="absolute resize-none border border-sky-300/60 bg-white/88 text-slate-900 shadow-lg focus-visible:ring-1 focus-visible:ring-sky-300"
                    style={{
                      left: currentCanvasLayout.textBounds.x,
                      top: currentCanvasLayout.textBounds.y,
                      width: currentCanvasLayout.textBounds.width,
                      minHeight: Math.max(currentCanvasLayout.textBounds.height, 72),
                      transform: `rotate(${currentObject.rotation}deg)`,
                      transformOrigin: `${currentCanvasLayout.center.x - currentCanvasLayout.textBounds.x}px ${currentCanvasLayout.center.y - currentCanvasLayout.textBounds.y}px`,
                      fontFamily: currentObject.fontFamily,
                      fontSize: `${currentObject.fontSize}px`,
                      lineHeight: String(currentObject.lineHeight),
                      letterSpacing: `${currentObject.letterSpacing}px`,
                      color: currentObject.textColor,
                      textAlign: currentObject.textAlign,
                    }}
                  />
                )}
              </div>
            ) : (
              <MaskCanvasSurface
                ref={maskSurfaceRef}
                active={mode === "mask" && open}
                imageUrl={buildImageUrl(documentState.sourceImage.path, sourceImageUrlVersion)}
                draftImageUrl={
                  documentState.mask.coverageAssetPath || documentState.mask.draftPath
                    ? buildImageUrl(
                      documentState.mask.coverageAssetPath || documentState.mask.draftPath || "",
                      documentState.updatedAt,
                    )
                    : null
                }
                compositionCanvas={expandedMaskCanvas}
                expansion={documentState.edit.expansion}
                coverageFrame={documentState.mask.coverageFrame}
                baseDraftImageUrl={documentState.mask.baseCoverageAssetPath ? buildImageUrl(documentState.mask.baseCoverageAssetPath) : null}
                sourceWidth={documentState.edit.expansion ? editCanvasGeometry!.width : documentState.sourceImage.width}
                sourceHeight={documentState.edit.expansion ? editCanvasGeometry!.height : documentState.sourceImage.height}
                initialState={documentState.mask}
                spacePressed={spacePressed}
                onBeginPan={handleMaskPanStart}
                onFit={handleFitToViewport}
                onSave={handleLocalizedMaskSave}
                onDraftChange={handleMaskDraftChange}
                onSettingsChange={handleMaskSettingsChange}
                onStateChange={handleMaskSurfaceStateChange}
              />
            )}
          </div>
        </div>
      )}

      <OutpaintingPipeSheet open={outpaintingPipeSheetOpen} onClose={() => setOutpaintingPipeSheetOpen(false)}
        onDelivered={() => onOpenChange(false)} width={editCanvasGeometry?.width || 0} height={editCanvasGeometry?.height || 0}
        projectId={documentState?.project.id} prepare={prepareOutpaint} onAlign={async alignment => {
          const expansion = documentRef.current?.edit.expansion;
          if (!expansion || !editCanvasGeometry) return;
          await handleExpansionChange({ ...expansion, right: expansion.right + (alignment - editCanvasGeometry.width % alignment) % alignment,
            bottom: expansion.bottom + (alignment - editCanvasGeometry.height % alignment) % alignment });
        }} />
      <TransformSheet
        open={exportSheetOpen}
        title={t(exportSheetComplete ? "exportSheet.successTitle" : "exportSheet.title")}
        description={exportSheetComplete ? undefined : t("exportSheet.description")}
        onClose={() => setExportSheetOpen(false)}
        destructive={!exportSheetComplete && exportSaveMode === "overwrite_current"}
        footer={(
          exportSheetComplete ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => {
                setExportSheetComplete(false);
                setDeliveryNotice(null);
                setExportSaveMode("new_copy");
              }}>
                {t("exportSheet.exportAgain")}
              </Button>
              <Button autoFocus type="button" size="sm" onClick={() => setExportSheetOpen(false)}>
                {t("exportSheet.done")}
              </Button>
            </>
          ) : (<>
            <Button type="button" size="sm" variant="ghost" onClick={() => setExportSheetOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button type="button" size="sm" variant={exportSaveMode === "overwrite_current" ? "destructive" : "default"} disabled={exportState === "exporting"} onClick={() => {
              void handleExportSheetSubmit();
            }}>
              {exportState === "exporting" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {exportSaveMode === "overwrite_current" ? t("exportSheet.overwriteImage") : t("exportSheet.exportImage")}
            </Button>
          </>)
        )}
      >
        {exportSheetComplete ? (
          <div role="status" className="rounded-xl border border-border bg-surface/70 p-4 text-sm break-words">
            {localizedDeliveryMessage || exportMessage}
          </div>
        ) : (<>
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("workspace.project")}</span>
            <Select value={targetProjectSlug || NONE_SELECT_VALUE} onValueChange={handleTargetProjectChange}>
              <SelectTrigger className="h-9 bg-surface text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SELECT_VALUE}>{t("workspace.sameProject")}</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.slug || NONE_SELECT_VALUE}>{project.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("workspace.folder")}</span>
            <Select value={exportTargetFolder || NONE_SELECT_VALUE} onValueChange={(value) => setExportTargetFolder(value === NONE_SELECT_VALUE ? "" : value)}>
              <SelectTrigger className="h-9 bg-surface text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SELECT_VALUE}>{t("workspace.projectRoot")}</SelectItem>
                {availableFolders.map((folder) => <SelectItem key={folder} value={folder}>{folder}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("exportSheet.filename")}</span>
          <Input value={exportFilename} disabled={exportSaveMode === "overwrite_current"} onChange={(event) => setExportFilename(event.target.value)} className="h-9 bg-surface" />
        </label>
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface/70 p-3 text-xs">
          <div><span className="text-muted-foreground">{t("exportSheet.format")}: </span>{exportRequiresAlpha ? "PNG" : documentState?.sourceImage.format.toUpperCase()}</div>
          <div><span className="text-muted-foreground">{t("exportSheet.dimensions")}: </span>{documentState ? `${Math.round(documentState.edit.crop.enabled && !documentState.edit.expansion ? documentState.edit.crop.width : editCanvasGeometry?.width ?? documentState.sourceImage.width)} × ${Math.round(documentState.edit.crop.enabled && !documentState.edit.expansion ? documentState.edit.crop.height : editCanvasGeometry?.height ?? documentState.sourceImage.height)}` : "—"}</div>
          <div className="col-span-2 text-muted-foreground">{t("exportSheet.lineage")}</div>
          {exportRequiresAlpha && <div className="col-span-2 text-amber-700 dark:text-amber-300">{t("exportSheet.alphaForcesPng")}</div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" size="sm" variant={exportSaveMode === "new_copy" ? "default" : "outline"} onClick={() => setExportSaveMode("new_copy")} className="h-auto min-h-9 text-xs">
            {t("exportSheet.createNew")}
          </Button>
          <Button type="button" size="sm" variant={exportSaveMode === "overwrite_current" ? "destructive" : "outline"} onClick={() => setExportSaveMode("overwrite_current")} className="h-auto min-h-9 text-xs">
            {t("exportSheet.overwriteCurrent")}
          </Button>
        </div>
        {exportSaveMode === "overwrite_current" && (
          <div className="rounded-lg border border-destructive/35 bg-destructive/8 p-2 text-xs text-destructive break-all">
            {t("exportSheet.willReplace", { path: launchImagePathRef.current || documentState?.sourceImage.path || "" })}
          </div>
        )}
        {exportState === "error" && exportMessage && (
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
            {exportMessage}
          </div>
        )}
        </>)}
      </TransformSheet>

      <TransformSheet
        open={maskSaveSheetOpen}
        title={t("maskSaveSheet.title")}
        description={t("maskSaveSheet.description")}
        onClose={() => setMaskSaveSheetOpen(false)}
        footer={(
          <>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMaskSaveSheetOpen(false)}>{t("actions.cancel")}</Button>
            <Button type="button" size="sm" disabled={maskSurfaceState.isSaving || !maskSurfaceState.isReady} onClick={() => {
              void maskSurfaceRef.current?.save();
            }}>
              {maskSurfaceState.isSaving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("actions.saveMask")}
            </Button>
          </>
        )}
      >
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("workspace.project")}</span>
            <Select value={targetProjectSlug || NONE_SELECT_VALUE} onValueChange={handleTargetProjectChange}>
              <SelectTrigger className="h-9 bg-surface text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SELECT_VALUE}>{t("workspace.sameProject")}</SelectItem>
                {projects.map((project) => <SelectItem key={project.id} value={project.slug || NONE_SELECT_VALUE}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("workspace.folder")}</span>
            <Select value={maskTargetFolder || NONE_SELECT_VALUE} onValueChange={(value) => setMaskTargetFolder(value === NONE_SELECT_VALUE ? "" : value)}>
              <SelectTrigger className="h-9 bg-surface text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_SELECT_VALUE}>{t("workspace.projectRoot")}</SelectItem>
                {availableFolders.map((folder) => <SelectItem key={folder} value={folder}>{folder}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{t("mask.filename")}</span>
          <Input value={maskSurfaceState.filename} onChange={(event) => maskSurfaceRef.current?.setFilename(event.target.value)} className="h-9 bg-surface" />
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_130px] gap-3 rounded-xl border border-border bg-surface/70 p-3">
          <div className="space-y-1 text-xs">
            <div><span className="text-muted-foreground">{t("exportSheet.dimensions")}: </span>{documentState ? `${documentState.sourceImage.width} × ${documentState.sourceImage.height}` : "—"}</div>
            <div>{maskSurfaceState.paintedPixels === "white" ? t("mask.paintedWhite") : t("mask.paintedBlack")}</div>
            <div className="text-muted-foreground">{t("maskSaveSheet.grayscale")}</div>
          </div>
          <div className="aspect-square overflow-hidden rounded-lg border border-border bg-black">
            {maskPreviewUrl && <img src={maskPreviewUrl} alt={t("mask.outputPreview")} className="h-full w-full object-contain" />}
          </div>
        </div>
        {(localizedDeliveryMessage || exportMessage) && (
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
            {localizedDeliveryMessage || exportMessage}
          </div>
        )}
      </TransformSheet>
    </div>
  );

  return (
    <TransformWorkspaceShell
      open={open}
      onOpenChange={handleDialogOpenChange}
      onInteractionChange={handleWorkspaceInteractionChange}
      title={t("title")}
      header={(
        <TransformHeader
          filename={documentState ? buildDisplayName(documentState.sourceImage.path) : t("loading")}
          saveState={localizedSaveState}
          saveStateTitle={saveStateTooltip}
          help={<><ContextHelpTrigger helpKey="transform_workspace" />
            {documentState && <TransformRevisionHistory sourcePath={documentState.sourceImage.path} onRestore={async id => {
              const previous = documentRef.current;
              if (!previous) return;
              while (maskDraftSaveRef.current) await maskDraftSaveRef.current;
              const files = [...pendingPaintLayerFilesRef.current.entries()].map(([layerId, file]) => ({layerId, file}));
              await api.saveTransformDocument(previous, {paintLayerFiles: files});
              const result = await api.readTransformRevision(previous.sourceImage.path, id);
              if (documentRef.current?.sourceImage.path !== previous.sourceImage.path) return;
              pendingPaintLayerFilesRef.current.clear();
              documentRef.current = result.document;
              lastSavedDocumentRef.current = null;
              setDocumentState(result.document); setSaveState("dirty");
            }} />}
          </>}
          modeControl={modeControl}
          actions={headerActions}
        />
      )}
      contextBar={<TransformContextBar>{renderContextBarV2()}</TransformContextBar>}
      toolDock={(
        <TransformToolDock
          mode={mode}
          activeTool={(mode === "edit" ? activeTool : maskSurfaceState.tool) as TransformToolId}
          ariaLabel={mode === "edit" ? t("sections.editTools") : t("sections.maskTools")}
          getLabel={(tool) => getToolLabel(tool.id as TransformEditTool | MaskTool)}
          onSelect={(tool) => {
            if (tool.mode === "mask") {
              maskSurfaceRef.current?.setTool(tool.id as MaskTool);
            } else {
              setEditTool(tool.id as TransformEditTool);
              if (tool.id !== "pixelate") setRasterSelection(null);
            }
          }}
        />
      )}
      canvas={canvasStage}
      rightDock={rightDock}
      status={statusText}
      rightDockOpen={rightDockOpen}
    />
  );

}
