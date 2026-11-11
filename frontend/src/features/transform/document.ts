import { normalizeTransformExpansion, validateTransformFrame } from "./expansion";
import type {
  TransformDocument,
  TransformEditTool,
  TransformImageLayer,
  TransformLayer,
  LegacyTransformMode,
  TransformMode,
  TransformPaintLayer,
  TransformPaintSettings,
  TransformProjectContext,
  TransformRetouchSettings,
  TransformSourceImage,
  TransformSourceImageTransform,
  TransformTextObject,
  TransformTextObjectKind,
} from "@/shared/types";

export const DEFAULT_TRANSFORM_FONT = "Trebuchet MS";
export const TRANSFORM_DOCUMENT_SCHEMA_VERSION = 5;

export const TRANSFORM_TEXT_OBJECT_KINDS: TransformTextObjectKind[] = [
  "speech_bubble",
  "thought_bubble",
  "narration_box",
  "narration_rect",
  "burst_jagged",
  "burst_wavy",
  "free_text",
];

const DEFAULT_TEXT_BY_KIND: Record<TransformTextObjectKind, string> = {
  speech_bubble: "Type here",
  thought_bubble: "Thinking...",
  narration_box: "Narration",
  narration_rect: "Narration",
  burst_jagged: "Bang!",
  burst_wavy: "Whoa!",
  free_text: "Text",
};

const TEXT_OBJECT_LABELS: Record<TransformTextObjectKind, string> = {
  speech_bubble: "speech bubble",
  thought_bubble: "thought bubble",
  narration_box: "narration rounded",
  narration_rect: "narration sharp",
  burst_jagged: "burst jagged",
  burst_wavy: "burst wavy",
  free_text: "free text",
};

export function isTransformTextObjectKind(value: unknown): value is TransformTextObjectKind {
  return TRANSFORM_TEXT_OBJECT_KINDS.includes(value as TransformTextObjectKind);
}

export function getTransformTextObjectLabel(kind: TransformTextObjectKind): string {
  return TEXT_OBJECT_LABELS[kind];
}

export function hasTransformTail(kind: TransformTextObjectKind): boolean {
  return kind === "speech_bubble" || kind === "thought_bubble";
}

export function defaultTailBaseAngleForObject(object: {
  kind: TransformTextObjectKind;
  x: number;
  y: number;
  width: number;
  height: number;
}): number | null {
  if (!hasTransformTail(object.kind)) {
    return null;
  }
  const centerX = object.x + object.width / 2;
  const centerY = object.y + object.height / 2;
  const baseX = object.x + object.width * 0.68;
  const baseY = object.y + object.height;
  return Math.atan2(baseY - centerY, baseX - centerX);
}

export function cloneTransformDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeTransformMode(value: unknown, fallback: TransformMode = "edit"): TransformMode {
  if (value === "mask") {
    return "mask";
  }
  if (value === "edit" || value === "text") {
    return "edit";
  }
  return fallback;
}

export function normalizeTransformEditTool(value: unknown): TransformEditTool {
  if (
    value === "speech_bubble" ||
    value === "thought_bubble" ||
    value === "narration_box" ||
    value === "free_text"
  ) {
    return "lettering";
  }
  const knownTools: TransformEditTool[] = [
    "select",
    "rect_select",
    "select_by_color",
    "pan",
    "lettering",
    "pencil",
    "brush",
    "eraser",
    "fill_bucket",
    "eyedropper",
    "smudge",
    "pixelate",
    "crop",
  ];
  return knownTools.includes(value as TransformEditTool) ? value as TransformEditTool : "select";
}

function defaultDimensions(kind: TransformTextObjectKind): { width: number; height: number } {
  if (kind === "free_text") {
    return { width: 240, height: 88 };
  }
  if (kind === "narration_box" || kind === "narration_rect") {
    return { width: 260, height: 120 };
  }
  if (kind === "burst_jagged" || kind === "burst_wavy") {
    return { width: 260, height: 170 };
  }
  return { width: 260, height: 150 };
}

function defaultTailWidth(kind: TransformTextObjectKind, width: number, height: number): number {
  if (kind !== "speech_bubble") {
    return 0;
  }
  return Math.max(32, Math.min(width, height) * 0.18);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumberInRange(value: unknown, fallback: number, min: number, max: number): number {
  return clamp(finiteNumber(value, fallback), min, max);
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function transformFontSizeMaxForSource(
  sourceImage: Pick<TransformSourceImage, "width" | "height">,
): number {
  return Math.max(144, Math.ceil(Math.max(sourceImage.width, sourceImage.height) * 0.2));
}

export function transformStrokeWidthMaxForSource(
  sourceImage: Pick<TransformSourceImage, "width" | "height">,
): number {
  return Math.max(12, Math.ceil(Math.max(sourceImage.width, sourceImage.height) * 0.02));
}

export function transformPaddingMaxForObject(
  object: Pick<TransformTextObject, "width" | "height">,
): number {
  return Math.max(60, Math.ceil(Math.min(object.width, object.height) * 0.45));
}

export function transformTextOffsetXMax(
  object: Pick<TransformTextObject, "width">,
  sourceImage: Pick<TransformSourceImage, "width">,
): number {
  return Math.max(120, Math.ceil(Math.max(object.width, sourceImage.width * 0.5)));
}

export function transformTextOffsetYMax(
  object: Pick<TransformTextObject, "height">,
  sourceImage: Pick<TransformSourceImage, "height">,
): number {
  return Math.max(120, Math.ceil(Math.max(object.height, sourceImage.height * 0.5)));
}

export function createTransformTextObject(
  kind: TransformTextObjectKind,
  x: number,
  y: number,
  initialText?: string,
): TransformTextObject {
  const { width, height } = defaultDimensions(kind);
  const hasTail = hasTransformTail(kind);
  const tailBaseAngle = defaultTailBaseAngleForObject({ kind, x, y, width, height });
  return {
    id: makeId("transform_object"),
    kind,
    x,
    y,
    width,
    height,
    rotation: 0,
    text: initialText ?? DEFAULT_TEXT_BY_KIND[kind],
    fontFamily: DEFAULT_TRANSFORM_FONT,
    fontSize: kind === "free_text" ? 34 : 28,
    lineHeight: 1.2,
    letterSpacing: 0,
    textColor: "#000000",
    fillColor:
      kind === "narration_box" || kind === "narration_rect"
        ? "#fff7d6"
        : kind === "free_text"
          ? "rgba(255,255,255,0)"
          : "#ffffff",
    strokeColor: "#000000",
    strokeWidth: kind === "free_text" ? 0 : 3,
    padding: kind === "free_text" ? 0 : 18,
    textAlign: kind === "free_text" ? "left" : "center",
    textOffsetX: 0,
    textOffsetY: 0,
    tailBaseAngle,
    tailWidth: defaultTailWidth(kind, width, height),
    tailX: hasTail ? x + width * 0.76 : null,
    tailY: hasTail ? y + height + 48 : null,
  };
}

export function retargetTransformTextObjectKind(
  object: TransformTextObject,
  nextKind: TransformTextObjectKind,
): void {
  if (object.kind === nextKind) {
    return;
  }
  object.kind = nextKind;
  if (hasTransformTail(nextKind)) {
    object.tailBaseAngle =
      typeof object.tailBaseAngle === "number" && Number.isFinite(object.tailBaseAngle)
        ? object.tailBaseAngle
        : defaultTailBaseAngleForObject(object);
    object.tailX =
      typeof object.tailX === "number" && Number.isFinite(object.tailX)
        ? object.tailX
        : object.x + object.width * 0.76;
    object.tailY =
      typeof object.tailY === "number" && Number.isFinite(object.tailY)
        ? object.tailY
        : object.y + object.height + 48;
    object.tailWidth = nextKind === "speech_bubble"
      ? finiteNumberInRange(
        object.tailWidth,
        defaultTailWidth(nextKind, object.width, object.height),
        8,
        Math.max(8, Math.min(object.width, object.height) * 0.9),
      )
      : 0;
    return;
  }
  object.tailBaseAngle = null;
  object.tailWidth = 0;
  object.tailX = null;
  object.tailY = null;
}

export function createTransformLayer(
  object: TransformTextObject,
  index: number,
  name?: string,
): TransformLayer {
  return {
    id: makeId("transform_layer"),
    kind: "text_object",
    refId: object.id,
    objectId: object.id,
    name: name ?? `${getTransformTextObjectLabel(object.kind)} ${index + 1}`,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
  };
}

export function createTransformPaintLayer(
  sourceImage: Pick<TransformSourceImage, "width" | "height">,
  role: TransformPaintLayer["role"] = "paint",
): TransformPaintLayer {
  const timestamp = new Date().toISOString();
  return {
    id: makeId("transform_paint"),
    role,
    width: sourceImage.width,
    height: sourceImage.height,
    assetPath: null,
    dataUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createTransformPaintLayerEntry(
  layer: TransformPaintLayer,
  index: number,
): TransformLayer {
  const role = layer.role ?? "paint";
  return {
    id: makeId("transform_layer"),
    kind: "paint_layer",
    refId: layer.id,
    name:
      role === "source_eraser"
        ? `image eraser ${index + 1}`
        : role === "retouch"
          ? `Retouch ${index + 1}`
          : `paint layer ${index + 1}`,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
  };
}

export function createTransformImageLayer(args: {
  intrinsicWidth: number;
  intrinsicHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  dataUrl?: string | null;
  sourcePath?: string | null;
  center?: { x: number; y: number } | null;
}): TransformImageLayer {
  const timestamp = new Date().toISOString();
  const maxWidth = Math.max(1, args.sourceWidth * 0.7);
  const maxHeight = Math.max(1, args.sourceHeight * 0.7);
  const scale = Math.min(
    1,
    maxWidth / Math.max(1, args.intrinsicWidth),
    maxHeight / Math.max(1, args.intrinsicHeight),
  );
  const width = Math.max(1, args.intrinsicWidth * scale);
  const height = Math.max(1, args.intrinsicHeight * scale);
  const center = args.center ?? {
    x: args.sourceWidth / 2,
    y: args.sourceHeight / 2,
  };
  return {
    id: makeId("transform_image"),
    sourcePath: args.sourcePath ?? null,
    assetPath: null,
    dataUrl: args.dataUrl ?? null,
    intrinsicWidth: Math.max(1, args.intrinsicWidth),
    intrinsicHeight: Math.max(1, args.intrinsicHeight),
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    rotation: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createTransformImageLayerEntry(
  imageLayer: TransformImageLayer,
  index: number,
  name?: string,
): TransformLayer {
  return {
    id: makeId("transform_layer"),
    kind: "image_layer",
    refId: imageLayer.id,
    name: name ?? `image ${index + 1}`,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "normal",
  };
}

export function defaultTransformAdjustments(): TransformDocument["edit"]["adjustments"] {
  return {
    brightness: 1,
    contrast: 1,
    saturation: 1,
    hueDegrees: 0,
  };
}

function defaultPaintSettings(): TransformPaintSettings {
  return {
    activeColor: "#ef4444",
    recentColors: ["#ef4444", "#000000", "#ffffff"],
    pencilThicknessPx: 4,
    brushThicknessPx: 24,
    eraserThicknessPx: 32,
    eraserTarget: "paint",
    brushOpacity: 1,
    brushHardness: 1,
    brushFlow: 1,
    brushSpacing: 0.18,
    brushSmoothing: 0.35,
    pencilSmoothing: 0,
    eraserHardness: 1,
    eraserOpacity: 1,
    fillOpacity: 1,
    eyedropperSampleMerged: true,
    pressureSize: false,
    pressureOpacity: false,
  };
}

export function defaultTransformRetouchSettings(): TransformRetouchSettings {
  return {
    smudge: {
      sizePx: 48,
      hardness: 0.65,
      strength: 0.48,
      sampleMerged: true,
      pressureStrength: false,
    },
    pixelate: {
      brushSizePx: 96,
      blockSizePx: 16,
      footprint: "round",
      sampleMerged: true,
      featherPx: 0,
      interactionMode: "brush",
    },
    fill: {
      tolerance: 32,
      contiguous: true,
      sampleMerged: true,
    },
  };
}

export function defaultTransformMaskState(): TransformDocument["mask"] {
  return {
    hasDraft: false,
    coverageAssetPath: null,
    draftPath: null,
    overlayColor: "#16b8d4",
    overlayOpacity: 0.55,
    viewMode: "overlay",
    paintedPixels: "white",
    lastTool: "add",
    brush: {
      sizePx: 64,
      hardness: 0.75,
      strength: 1,
      featherPx: 0,
      smoothing: 0.3,
    },
    fillTolerance: 32,
    proposedFilename: null,
  };
}

function defaultCrop(sourceImage: Pick<TransformSourceImage, "width" | "height">) {
  return {
    enabled: false,
    x: 0,
    y: 0,
    width: sourceImage.width,
    height: sourceImage.height,
    aspectRatio: "free" as const,
  };
}

export function normalizeTransformSourceImageRotation(value: unknown): number {
  const fallback = 0;
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const normalized = ((raw % 360) + 360) % 360;
  const signed = normalized > 180 ? normalized - 360 : normalized;
  return Object.is(signed, -0) ? 0 : Math.round(signed * 100) / 100;
}

export function defaultTransformSourceImageTransform(): TransformSourceImageTransform {
  return {
    rotationDegrees: 0,
    flipHorizontal: false,
    flipVertical: false,
  };
}

export function normalizeTransformSourceImageTransform(value: unknown): TransformSourceImageTransform {
  const payload = value && typeof value === "object" ? value as Partial<TransformSourceImageTransform> : {};
  return {
    rotationDegrees: normalizeTransformSourceImageRotation(payload.rotationDegrees),
    flipHorizontal: Boolean(payload.flipHorizontal),
    flipVertical: Boolean(payload.flipVertical),
  };
}

export function isIdentityTransformSourceImageTransform(
  value: Pick<TransformSourceImageTransform, "rotationDegrees" | "flipHorizontal" | "flipVertical">,
): boolean {
  return !value.flipHorizontal && !value.flipVertical && normalizeTransformSourceImageRotation(value.rotationDegrees) === 0;
}

export function createTransformDocument(args: {
  sourceImage: TransformSourceImage;
  project: TransformProjectContext;
  initialMode: TransformMode | LegacyTransformMode;
}): TransformDocument {
  const timestamp = new Date().toISOString();
  const mode = normalizeTransformMode(args.initialMode);
  return {
    id: makeId("transform_document"),
    schemaVersion: TRANSFORM_DOCUMENT_SCHEMA_VERSION,
    sourceImage: args.sourceImage,
    project: {
      id: args.project.id ?? null,
      slug: args.project.slug ?? null,
      folder: args.project.folder ?? null,
    },
    lastUsedMode: mode,
    edit: {
      lastUsedTool: "select",
      textObjects: [],
      paintLayers: [],
      imageLayers: [],
      adjustments: defaultTransformAdjustments(),
      paintSettings: defaultPaintSettings(),
      retouchSettings: defaultTransformRetouchSettings(),
      layers: [],
      crop: defaultCrop(args.sourceImage),
      sourceImageTransform: defaultTransformSourceImageTransform(),
    },
    text: {
      objects: [],
      layers: [],
    },
    mask: defaultTransformMaskState(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function ensureTransformDocument(
  document: TransformDocument | null | undefined,
  args: {
    sourceImage: TransformSourceImage;
    project: TransformProjectContext;
    initialMode: TransformMode | LegacyTransformMode;
  },
): TransformDocument {
  if (!document) {
    return createTransformDocument(args);
  }
  const normalized = cloneTransformDocument(document);
  const fallbackDocument = createTransformDocument(args);
  const legacyText = (normalized as TransformDocument).text || { objects: [], layers: [] };
  const legacyEdit = (normalized as TransformDocument).edit;
  const rawEditTextObjects = Array.isArray(legacyEdit?.textObjects) ? legacyEdit.textObjects : [];
  const rawLegacyTextObjects = Array.isArray(legacyText.objects) ? legacyText.objects : [];
  const rawTextObjects = rawEditTextObjects.length ? rawEditTextObjects : rawLegacyTextObjects;
  const rawPaintLayers = Array.isArray(legacyEdit?.paintLayers) ? legacyEdit.paintLayers : [];
  const rawImageLayers = Array.isArray(legacyEdit?.imageLayers) ? legacyEdit.imageLayers : [];
  const rawEditLayers = Array.isArray(legacyEdit?.layers) ? legacyEdit.layers : [];
  const rawLegacyLayers = Array.isArray(legacyText.layers) ? legacyText.layers : [];
  const rawLayers = rawEditLayers.length ? rawEditLayers : rawLegacyLayers;

  normalized.sourceImage = args.sourceImage;
  normalized.project = {
    id: args.project.id ?? null,
    slug: args.project.slug ?? null,
    folder: args.project.folder ?? null,
  };
  normalized.schemaVersion = TRANSFORM_DOCUMENT_SCHEMA_VERSION;
  normalized.lastUsedMode = normalizeTransformMode(normalized.lastUsedMode, normalizeTransformMode(args.initialMode));
  const textObjects = rawTextObjects.map((object) => {
    const nextObject = cloneTransformDocument(object);
    nextObject.kind = isTransformTextObjectKind(nextObject.kind) ? nextObject.kind : "speech_bubble";
    const fallbackDimensions = defaultDimensions(nextObject.kind);
    const widthMax = Math.max(120, (args.sourceImage.width || fallbackDimensions.width) * 2);
    const heightMax = Math.max(72, (args.sourceImage.height || fallbackDimensions.height) * 2);
    nextObject.x = finiteNumber(nextObject.x, 0);
    nextObject.y = finiteNumber(nextObject.y, 0);
    nextObject.width = finiteNumberInRange(nextObject.width, fallbackDimensions.width, 120, widthMax);
    nextObject.height = finiteNumberInRange(nextObject.height, fallbackDimensions.height, 72, heightMax);
    nextObject.rotation = finiteNumberInRange(nextObject.rotation, 0, -180, 180);
    nextObject.text = typeof nextObject.text === "string" ? nextObject.text : DEFAULT_TEXT_BY_KIND[nextObject.kind];
    nextObject.fontFamily = nextObject.fontFamily || DEFAULT_TRANSFORM_FONT;
    nextObject.fontSize = finiteNumberInRange(
      nextObject.fontSize,
      nextObject.kind === "free_text" ? 34 : 28,
      8,
      transformFontSizeMaxForSource(args.sourceImage),
    );
    nextObject.lineHeight = finiteNumberInRange(nextObject.lineHeight, 1.2, 0.8, 2.4);
    nextObject.letterSpacing = finiteNumberInRange(nextObject.letterSpacing, 0, -2, 16);
    nextObject.strokeWidth = finiteNumberInRange(
      nextObject.strokeWidth,
      nextObject.kind === "free_text" ? 0 : 3,
      0,
      transformStrokeWidthMaxForSource(args.sourceImage),
    );
    nextObject.padding = finiteNumberInRange(
      nextObject.padding,
      nextObject.kind === "free_text" ? 0 : 18,
      0,
      transformPaddingMaxForObject(nextObject),
    );
    nextObject.textAlign = ["left", "center", "right"].includes(nextObject.textAlign)
      ? nextObject.textAlign
      : nextObject.kind === "free_text"
        ? "left"
        : "center";
    const textOffsetXMax = transformTextOffsetXMax(nextObject, args.sourceImage);
    const textOffsetYMax = transformTextOffsetYMax(nextObject, args.sourceImage);
    nextObject.textOffsetX = finiteNumberInRange(nextObject.textOffsetX, 0, -textOffsetXMax, textOffsetXMax);
    nextObject.textOffsetY = finiteNumberInRange(nextObject.textOffsetY, 0, -textOffsetYMax, textOffsetYMax);
    nextObject.tailX = optionalFiniteNumber(nextObject.tailX);
    nextObject.tailY = optionalFiniteNumber(nextObject.tailY);
    nextObject.tailBaseAngle =
      hasTransformTail(nextObject.kind)
        ? (typeof nextObject.tailBaseAngle === "number" && Number.isFinite(nextObject.tailBaseAngle)
          ? nextObject.tailBaseAngle
          : defaultTailBaseAngleForObject(nextObject))
        : null;
    nextObject.tailWidth =
      nextObject.kind === "speech_bubble"
        ? finiteNumberInRange(
          nextObject.tailWidth,
          defaultTailWidth(nextObject.kind, nextObject.width, nextObject.height),
          8,
          Math.max(8, Math.min(nextObject.width, nextObject.height) * 0.9),
        )
        : 0;
    return nextObject;
  });

  const paintLayers: TransformPaintLayer[] = rawPaintLayers.map((layer) => {
    const nextLayer = cloneTransformDocument(layer) as TransformPaintLayer;
    const timestamp = new Date().toISOString();
    nextLayer.id = typeof nextLayer.id === "string" && nextLayer.id ? nextLayer.id : makeId("transform_paint");
    nextLayer.role =
      nextLayer.role === "source_eraser"
        ? "source_eraser"
        : nextLayer.role === "retouch"
          ? "retouch"
          : "paint";
    nextLayer.width = finiteNumberInRange(nextLayer.width, args.sourceImage.width, 1, args.sourceImage.width);
    nextLayer.height = finiteNumberInRange(nextLayer.height, args.sourceImage.height, 1, args.sourceImage.height);
    nextLayer.assetPath = typeof nextLayer.assetPath === "string" && nextLayer.assetPath ? nextLayer.assetPath : null;
    nextLayer.dataUrl = typeof nextLayer.dataUrl === "string" && nextLayer.dataUrl.startsWith("data:image/")
      ? nextLayer.dataUrl
      : null;
    nextLayer.createdAt = typeof nextLayer.createdAt === "string" ? nextLayer.createdAt : timestamp;
    nextLayer.updatedAt = typeof nextLayer.updatedAt === "string" ? nextLayer.updatedAt : nextLayer.createdAt;
    return nextLayer;
  });

  const imageLayers: TransformImageLayer[] = rawImageLayers.map((layer) => {
    const nextLayer = cloneTransformDocument(layer) as TransformImageLayer;
    const timestamp = new Date().toISOString();
    nextLayer.id = typeof nextLayer.id === "string" && nextLayer.id ? nextLayer.id : makeId("transform_image");
    nextLayer.sourcePath = typeof nextLayer.sourcePath === "string" && nextLayer.sourcePath ? nextLayer.sourcePath : null;
    nextLayer.assetPath = typeof nextLayer.assetPath === "string" && nextLayer.assetPath ? nextLayer.assetPath : null;
    nextLayer.dataUrl = typeof nextLayer.dataUrl === "string" && nextLayer.dataUrl.startsWith("data:image/")
      ? nextLayer.dataUrl
      : null;
    nextLayer.intrinsicWidth = finiteNumberInRange(nextLayer.intrinsicWidth, args.sourceImage.width, 1, 100_000);
    nextLayer.intrinsicHeight = finiteNumberInRange(nextLayer.intrinsicHeight, args.sourceImage.height, 1, 100_000);
    nextLayer.x = finiteNumber(nextLayer.x, 0);
    nextLayer.y = finiteNumber(nextLayer.y, 0);
    nextLayer.width = finiteNumberInRange(nextLayer.width, nextLayer.intrinsicWidth, 1, 100_000);
    nextLayer.height = finiteNumberInRange(nextLayer.height, nextLayer.intrinsicHeight, 1, 100_000);
    nextLayer.rotation = finiteNumberInRange(nextLayer.rotation, 0, -180, 180);
    nextLayer.createdAt = typeof nextLayer.createdAt === "string" ? nextLayer.createdAt : timestamp;
    nextLayer.updatedAt = typeof nextLayer.updatedAt === "string" ? nextLayer.updatedAt : nextLayer.createdAt;
    return nextLayer;
  });

  const textIds = new Set(textObjects.map((object) => object.id));
  const paintIds = new Set(paintLayers.map((layer) => layer.id));
  const imageIds = new Set(imageLayers.map((layer) => layer.id));
  const layers = rawLayers
    .map((layer, index): TransformLayer | null => {
      const kind: TransformLayer["kind"] =
        layer.kind === "paint_layer"
          ? "paint_layer"
          : layer.kind === "image_layer"
            ? "image_layer"
            : "text_object";
      const refId = typeof layer.refId === "string" && layer.refId
        ? layer.refId
        : typeof layer.objectId === "string" && layer.objectId
          ? layer.objectId
          : "";
      if (
        !refId ||
        (kind === "text_object" && !textIds.has(refId)) ||
        (kind === "paint_layer" && !paintIds.has(refId)) ||
        (kind === "image_layer" && !imageIds.has(refId))
      ) {
        return null;
      }
      return {
        id: typeof layer.id === "string" && layer.id ? layer.id : makeId("transform_layer"),
        kind,
        refId,
        objectId: kind === "text_object" ? refId : undefined,
        name: typeof layer.name === "string" && layer.name
          ? layer.name
          : kind === "text_object"
            ? `text ${index + 1}`
            : kind === "paint_layer"
              ? `paint layer ${index + 1}`
              : `image ${index + 1}`,
        visible: layer.visible !== false,
        locked: Boolean(layer.locked),
        opacity: finiteNumberInRange(layer.opacity, 1, 0, 1),
        blendMode: "normal" as const,
      };
    })
    .filter((layer): layer is TransformLayer => layer !== null);
  const represented = new Set(layers.map((layer) => `${layer.kind}:${layer.refId}`));
  for (const object of textObjects) {
    const key = `text_object:${object.id}`;
    if (!represented.has(key)) {
      layers.push(createTransformLayer(object, layers.length));
      represented.add(key);
    }
  }
  for (const paintLayer of paintLayers) {
    const key = `paint_layer:${paintLayer.id}`;
    if (!represented.has(key)) {
      layers.push(createTransformPaintLayerEntry(paintLayer, layers.length));
      represented.add(key);
    }
  }
  for (const imageLayer of imageLayers) {
    const key = `image_layer:${imageLayer.id}`;
    if (!represented.has(key)) {
      layers.push(createTransformImageLayerEntry(imageLayer, layers.length));
      represented.add(key);
    }
  }

  const rawSettings = legacyEdit?.paintSettings || {};
  const fallbackSettings = defaultPaintSettings();
  const rawRetouchSettings = legacyEdit?.retouchSettings || {};
  const fallbackRetouchSettings = defaultTransformRetouchSettings();
  const rawSmudge = rawRetouchSettings.smudge || {};
  const rawPixelate = rawRetouchSettings.pixelate || {};
  const rawFill = rawRetouchSettings.fill || {};
  const rawAdjustments = legacyEdit?.adjustments || {};
  const fallbackAdjustments = defaultTransformAdjustments();
  const activeColor = typeof rawSettings.activeColor === "string" && rawSettings.activeColor
    ? rawSettings.activeColor
    : fallbackSettings.activeColor;
  const recentColors = Array.isArray(rawSettings.recentColors)
    ? rawSettings.recentColors.filter((color): color is string => typeof color === "string" && Boolean(color)).slice(0, 12)
    : fallbackSettings.recentColors;
  const rawCrop = legacyEdit?.crop || {};
  const sourceImageTransform = normalizeTransformSourceImageTransform(legacyEdit?.sourceImageTransform);
  const crop = {
    enabled: Boolean(rawCrop.enabled),
    x: finiteNumberInRange(rawCrop.x, 0, 0, args.sourceImage.width),
    y: finiteNumberInRange(rawCrop.y, 0, 0, args.sourceImage.height),
    width: finiteNumberInRange(rawCrop.width, args.sourceImage.width, 1, args.sourceImage.width),
    height: finiteNumberInRange(rawCrop.height, args.sourceImage.height, 1, args.sourceImage.height),
    aspectRatio: ["free", "source", "1:1", "4:3", "3:4", "16:9", "9:16"].includes(rawCrop.aspectRatio)
      ? rawCrop.aspectRatio
      : "free",
  };
  crop.x = clamp(crop.x, 0, Math.max(0, args.sourceImage.width - crop.width));
  crop.y = clamp(crop.y, 0, Math.max(0, args.sourceImage.height - crop.height));

  normalized.edit = {
    lastUsedTool: normalizeTransformEditTool(legacyEdit?.lastUsedTool),
    textObjects,
    paintLayers,
    imageLayers,
    adjustments: {
      brightness: finiteNumberInRange(rawAdjustments.brightness, fallbackAdjustments.brightness, 0, 2),
      contrast: finiteNumberInRange(rawAdjustments.contrast, fallbackAdjustments.contrast, 0, 2),
      saturation: finiteNumberInRange(rawAdjustments.saturation, fallbackAdjustments.saturation, 0, 2),
      hueDegrees: finiteNumberInRange(rawAdjustments.hueDegrees, fallbackAdjustments.hueDegrees, -180, 180),
    },
    paintSettings: {
      activeColor,
      recentColors: recentColors.length ? recentColors : [activeColor],
      pencilThicknessPx: finiteNumberInRange(rawSettings.pencilThicknessPx, fallbackSettings.pencilThicknessPx, 1, 512),
      brushThicknessPx: finiteNumberInRange(rawSettings.brushThicknessPx, fallbackSettings.brushThicknessPx, 1, 512),
      eraserThicknessPx: finiteNumberInRange(rawSettings.eraserThicknessPx, fallbackSettings.eraserThicknessPx, 1, 512),
      eraserTarget: rawSettings.eraserTarget === "source" ? "source" : "paint",
      brushOpacity: finiteNumberInRange(rawSettings.brushOpacity, fallbackSettings.brushOpacity, 0.05, 1),
      brushHardness: finiteNumberInRange(rawSettings.brushHardness, fallbackSettings.brushHardness, 0, 1),
      brushFlow: finiteNumberInRange(rawSettings.brushFlow, fallbackSettings.brushFlow, 0.01, 1),
      brushSpacing: finiteNumberInRange(rawSettings.brushSpacing, fallbackSettings.brushSpacing, 0.02, 2),
      brushSmoothing: finiteNumberInRange(rawSettings.brushSmoothing, fallbackSettings.brushSmoothing, 0, 0.95),
      pencilSmoothing: finiteNumberInRange(rawSettings.pencilSmoothing, fallbackSettings.pencilSmoothing, 0, 0.95),
      eraserHardness: finiteNumberInRange(rawSettings.eraserHardness, fallbackSettings.eraserHardness, 0, 1),
      eraserOpacity: finiteNumberInRange(rawSettings.eraserOpacity, fallbackSettings.eraserOpacity, 0.01, 1),
      fillOpacity: finiteNumberInRange(rawSettings.fillOpacity, fallbackSettings.fillOpacity, 0.01, 1),
      eyedropperSampleMerged: rawSettings.eyedropperSampleMerged !== false,
      pressureSize: Boolean(rawSettings.pressureSize),
      pressureOpacity: Boolean(rawSettings.pressureOpacity),
    },
    retouchSettings: {
      smudge: {
        sizePx: finiteNumberInRange(rawSmudge.sizePx, fallbackRetouchSettings.smudge.sizePx, 1, 512),
        hardness: finiteNumberInRange(rawSmudge.hardness, fallbackRetouchSettings.smudge.hardness, 0, 1),
        strength: finiteNumberInRange(rawSmudge.strength, fallbackRetouchSettings.smudge.strength, 0.01, 1),
        sampleMerged: rawSmudge.sampleMerged !== false,
        pressureStrength: Boolean(rawSmudge.pressureStrength),
      },
      pixelate: {
        brushSizePx: finiteNumberInRange(rawPixelate.brushSizePx, fallbackRetouchSettings.pixelate.brushSizePx, 1, 1024),
        blockSizePx: finiteNumberInRange(rawPixelate.blockSizePx, fallbackRetouchSettings.pixelate.blockSizePx, 2, 256),
        footprint: rawPixelate.footprint === "square" ? "square" : "round",
        sampleMerged: rawPixelate.sampleMerged !== false,
        featherPx: finiteNumberInRange(rawPixelate.featherPx, fallbackRetouchSettings.pixelate.featherPx, 0, 256),
        interactionMode: rawPixelate.interactionMode === "selection" ? "selection" : "brush",
      },
      fill: {
        tolerance: finiteNumberInRange(rawFill.tolerance, fallbackRetouchSettings.fill.tolerance, 0, 255),
        contiguous: rawFill.contiguous !== false,
        sampleMerged: rawFill.sampleMerged !== false,
      },
    },
    layers,
    crop,
    expansion: normalizeTransformExpansion(legacyEdit?.expansion),
    sourceImageTransform,
  };
  normalized.text = {
    objects: normalized.edit.textObjects,
    layers: normalized.edit.layers.filter((layer) => layer.kind === "text_object"),
  };
  const rawMask: Record<string, unknown> =
    normalized.mask && typeof normalized.mask === "object"
      ? normalized.mask as unknown as Record<string, unknown>
      : {};
  const fallbackMask = defaultTransformMaskState();
  const rawMaskBrush: Record<string, unknown> =
    rawMask.brush && typeof rawMask.brush === "object"
      ? rawMask.brush as Record<string, unknown>
      : {};
  const legacyDraftPath = typeof rawMask.draftPath === "string" && rawMask.draftPath
    ? rawMask.draftPath
    : null;
  const coverageAssetPath =
    typeof rawMask.coverageAssetPath === "string" && rawMask.coverageAssetPath
      ? rawMask.coverageAssetPath
      : legacyDraftPath;
  normalized.mask = {
    coverageFrame: rawMask.coverageFrame ? validateTransformFrame(rawMask.coverageFrame as TransformDocument["mask"]["coverageFrame"] & {})
      : { x: 0, y: 0, width: args.sourceImage.width, height: args.sourceImage.height },
    baseCoverageAssetPath: typeof rawMask.baseCoverageAssetPath === "string" ? rawMask.baseCoverageAssetPath : null,
    hasDraft: Boolean(rawMask.hasDraft || coverageAssetPath),
    coverageAssetPath,
    draftPath: coverageAssetPath,
    overlayColor:
      typeof rawMask.overlayColor === "string" && /^#[0-9a-f]{6}$/i.test(rawMask.overlayColor)
        ? rawMask.overlayColor.toLowerCase()
        : fallbackMask.overlayColor,
    overlayOpacity: finiteNumberInRange(
      rawMask.overlayOpacity,
      fallbackMask.overlayOpacity,
      0.05,
      1,
    ),
    viewMode: ["overlay", "mask", "image"].includes(String(rawMask.viewMode))
      ? rawMask.viewMode as TransformDocument["mask"]["viewMode"]
      : fallbackMask.viewMode,
    paintedPixels:
      rawMask.paintedPixels === "black" || rawMask.invertOutput === true
        ? "black"
        : "white",
    lastTool: ["add", "subtract", "rectangle", "lasso", "fill", "pan"].includes(String(rawMask.lastTool))
      ? rawMask.lastTool as TransformDocument["mask"]["lastTool"]
      : fallbackMask.lastTool,
    brush: {
      sizePx: finiteNumberInRange(rawMaskBrush.sizePx, fallbackMask.brush.sizePx, 1, 1024),
      hardness: finiteNumberInRange(rawMaskBrush.hardness, fallbackMask.brush.hardness, 0, 1),
      strength: finiteNumberInRange(rawMaskBrush.strength, fallbackMask.brush.strength, 0.01, 1),
      featherPx: finiteNumberInRange(rawMaskBrush.featherPx, fallbackMask.brush.featherPx, 0, 256),
      smoothing: finiteNumberInRange(rawMaskBrush.smoothing, fallbackMask.brush.smoothing, 0, 0.95),
    },
    fillTolerance: finiteNumberInRange(
      rawMask.fillTolerance,
      fallbackMask.fillTolerance,
      0,
      255,
    ),
    proposedFilename:
      typeof rawMask.proposedFilename === "string" && rawMask.proposedFilename.trim()
        ? rawMask.proposedFilename
        : null,
  };
  normalized.createdAt = normalized.createdAt || fallbackDocument.createdAt;
  normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
  return normalized;
}

export function getOrderedTransformObjects(document: TransformDocument): TransformTextObject[] {
  const objectMap = new Map(document.edit.textObjects.map((object) => [object.id, object]));
  const layerOrder = document.edit.layers
    .filter((layer) => layer.visible && layer.kind === "text_object")
    .map((layer) => objectMap.get(layer.refId))
    .filter((object): object is TransformTextObject => Boolean(object));
  const orderedIds = new Set(layerOrder.map((object) => object.id));
  const leftovers = document.edit.textObjects.filter((object) => !orderedIds.has(object.id));
  return [...layerOrder, ...leftovers];
}

export function getOrderedTransformLayers(document: Pick<TransformDocument, "edit">): TransformLayer[] {
  return document.edit.layers.filter((layer) => layer.visible);
}

export function updateTransformLayer(
  document: TransformDocument,
  layerId: string,
  mutate: (layer: TransformLayer) => void,
): TransformDocument {
  const next = cloneTransformDocument(document);
  const layer = next.edit.layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    return next;
  }
  mutate(layer);
  layer.opacity = finiteNumberInRange(layer.opacity, 1, 0, 1);
  layer.name = typeof layer.name === "string" && layer.name.trim() ? layer.name.trim() : "layer";
  next.text.layers = next.edit.layers.filter((candidate) => candidate.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return next;
}

export function reorderTransformObject(
  document: TransformDocument,
  objectId: string,
  direction: -1 | 1,
): TransformDocument {
  const next = cloneTransformDocument(document);
  const index = next.edit.layers.findIndex((layer) => layer.kind === "text_object" && layer.refId === objectId);
  if (index === -1) {
    return next;
  }
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= next.edit.layers.length) {
    return next;
  }
  const [layer] = next.edit.layers.splice(index, 1);
  next.edit.layers.splice(targetIndex, 0, layer);
  next.text.layers = next.edit.layers.filter((candidate) => candidate.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return next;
}

export function reorderTransformLayer(
  document: TransformDocument,
  layerId: string,
  direction: -1 | 1,
): TransformDocument {
  const next = cloneTransformDocument(document);
  const index = next.edit.layers.findIndex((layer) => layer.id === layerId);
  if (index === -1) {
    return next;
  }
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= next.edit.layers.length) {
    return next;
  }
  const [layer] = next.edit.layers.splice(index, 1);
  next.edit.layers.splice(targetIndex, 0, layer);
  next.text.layers = next.edit.layers.filter((candidate) => candidate.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return next;
}

export function moveTransformLayer(
  document: TransformDocument,
  layerId: string,
  targetLayerId: string,
): TransformDocument {
  const next = cloneTransformDocument(document);
  const sourceIndex = next.edit.layers.findIndex((layer) => layer.id === layerId);
  const targetIndex = next.edit.layers.findIndex((layer) => layer.id === targetLayerId);
  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return next;
  }
  const [layer] = next.edit.layers.splice(sourceIndex, 1);
  const insertionIndex = next.edit.layers.findIndex((candidate) => candidate.id === targetLayerId);
  next.edit.layers.splice(Math.max(0, insertionIndex), 0, layer);
  next.text.layers = next.edit.layers.filter((candidate) => candidate.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return next;
}

export function duplicateTransformObject(
  document: TransformDocument,
  objectId: string,
): { document: TransformDocument; duplicatedId: string | null } {
  const next = cloneTransformDocument(document);
  const source = next.edit.textObjects.find((object) => object.id === objectId);
  if (!source) {
    return { document: next, duplicatedId: null };
  }
  const duplicated: TransformTextObject = {
    ...source,
    id: makeId("transform_object"),
    x: source.x + 24,
    y: source.y + 24,
    tailX: source.tailX != null ? source.tailX + 24 : null,
    tailY: source.tailY != null ? source.tailY + 24 : null,
  };
  const duplicatedLayer = createTransformLayer(duplicated, next.edit.layers.length);
  next.edit.textObjects.push(duplicated);
  next.edit.layers.push(duplicatedLayer);
  next.text.objects = next.edit.textObjects;
  next.text.layers = next.edit.layers.filter((layer) => layer.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return { document: next, duplicatedId: duplicated.id };
}

export function duplicateTransformImageLayer(
  document: TransformDocument,
  imageLayerId: string,
): { document: TransformDocument; duplicatedId: string | null } {
  const next = cloneTransformDocument(document);
  const source = next.edit.imageLayers.find((layer) => layer.id === imageLayerId);
  const sourceEntry = next.edit.layers.find(
    (layer) => layer.kind === "image_layer" && layer.refId === imageLayerId,
  );
  if (!source || !sourceEntry) {
    return { document: next, duplicatedId: null };
  }
  const timestamp = new Date().toISOString();
  const duplicated: TransformImageLayer = {
    ...source,
    id: makeId("transform_image"),
    x: source.x + 24,
    y: source.y + 24,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  next.edit.imageLayers.push(duplicated);
  next.edit.layers.push(createTransformImageLayerEntry(
    duplicated,
    next.edit.layers.length,
    `${sourceEntry.name} copy`,
  ));
  next.updatedAt = timestamp;
  return { document: next, duplicatedId: duplicated.id };
}

export function deleteTransformObject(
  document: TransformDocument,
  objectId: string,
): TransformDocument {
  const next = cloneTransformDocument(document);
  next.edit.textObjects = next.edit.textObjects.filter((object) => object.id !== objectId);
  next.edit.layers = next.edit.layers.filter((layer) => !(layer.kind === "text_object" && layer.refId === objectId));
  next.text.objects = next.edit.textObjects;
  next.text.layers = next.edit.layers.filter((layer) => layer.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return next;
}

export function deleteTransformLayer(
  document: TransformDocument,
  layerId: string,
): TransformDocument {
  const targetLayer = document.edit.layers.find((layer) => layer.id === layerId);
  if (!targetLayer) {
    return cloneTransformDocument(document);
  }
  if (targetLayer.kind === "text_object") {
    return deleteTransformObject(document, targetLayer.refId);
  }
  const next = cloneTransformDocument(document);
  next.edit.layers = next.edit.layers.filter((layer) => layer.id !== layerId);
  if (targetLayer.kind === "paint_layer") {
    next.edit.paintLayers = next.edit.paintLayers.filter((layer) => layer.id !== targetLayer.refId);
  } else {
    next.edit.imageLayers = next.edit.imageLayers.filter((layer) => layer.id !== targetLayer.refId);
  }
  next.text.layers = next.edit.layers.filter((layer) => layer.kind === "text_object");
  next.updatedAt = new Date().toISOString();
  return next;
}

export function bringTransformTextObjectIntoFrame(
  document: TransformDocument,
  objectId: string,
): TransformDocument {
  const next = cloneTransformDocument(document);
  const object = next.edit.textObjects.find((candidate) => candidate.id === objectId);
  if (!object) {
    return next;
  }
  const previousX = object.x;
  const previousY = object.y;
  const maxX = Math.max(0, next.sourceImage.width - object.width);
  const maxY = Math.max(0, next.sourceImage.height - object.height);
  object.x = clamp(object.x, 0, maxX);
  object.y = clamp(object.y, 0, maxY);
  const deltaX = object.x - previousX;
  const deltaY = object.y - previousY;
  if (object.tailX != null) {
    object.tailX = clamp(object.tailX + deltaX, 0, next.sourceImage.width);
  }
  if (object.tailY != null) {
    object.tailY = clamp(object.tailY + deltaY, 0, next.sourceImage.height);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}
