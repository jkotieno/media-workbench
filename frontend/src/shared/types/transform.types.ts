export type TransformMode = "edit" | "mask";

export type LegacyTransformMode = "text" | "mask";

export type TransformEditTool =
  | "select"
  | "rect_select"
  | "select_by_color"
  | "pan"
  | "lettering"
  | "pencil"
  | "brush"
  | "eraser"
  | "fill_bucket"
  | "eyedropper"
  | "smudge"
  | "pixelate"
  | "crop";

export type TransformMaskTool =
  | "add"
  | "subtract"
  | "rectangle"
  | "lasso"
  | "fill"
  | "pan";

export type TransformMaskViewMode = "overlay" | "mask" | "image";

export type TransformPaintedPixels = "white" | "black";

export type TransformTextObjectKind =
  | "speech_bubble"
  | "thought_bubble"
  | "narration_box"
  | "narration_rect"
  | "burst_jagged"
  | "burst_wavy"
  | "free_text";

export type TransformTextAlign = "left" | "center" | "right";

export interface TransformRailImage {
  path: string;
  filename: string;
  mtime?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface TransformProjectContext {
  id?: number | null;
  slug?: string | null;
  folder?: string | null;
  available_folders?: string[];
}

export interface TransformSourceImage {
  path: string;
  format: "png" | "jpg" | "jpeg" | "webp";
  width: number;
  height: number;
  hash?: string | null;
}

export type TransformLayerKind = "text_object" | "paint_layer" | "image_layer";

export interface TransformLayer {
  id: string;
  kind: TransformLayerKind;
  refId: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: "normal";
  objectId?: string;
}

export interface TransformTextObject {
  id: string;
  kind: TransformTextObjectKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  textColor: string;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  padding: number;
  textAlign: TransformTextAlign;
  textOffsetX: number;
  textOffsetY: number;
  tailBaseAngle?: number | null;
  tailWidth: number;
  tailX?: number | null;
  tailY?: number | null;
}

export interface TransformPaintLayer {
  id: string;
  role?: "paint" | "retouch" | "source_eraser";
  width: number;
  height: number;
  assetPath?: string | null;
  dataUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TransformImageLayer {
  id: string;
  sourcePath?: string | null;
  assetPath?: string | null;
  dataUrl?: string | null;
  intrinsicWidth: number;
  intrinsicHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransformAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  hueDegrees: number;
}

export interface TransformPaintSettings {
  activeColor: string;
  recentColors: string[];
  pencilThicknessPx: number;
  brushThicknessPx: number;
  eraserThicknessPx: number;
  eraserTarget: "paint" | "source";
  brushOpacity: number;
  brushHardness: number;
  brushFlow: number;
  brushSpacing: number;
  brushSmoothing: number;
  pencilSmoothing: number;
  eraserHardness: number;
  eraserOpacity: number;
  fillOpacity: number;
  eyedropperSampleMerged: boolean;
  pressureSize: boolean;
  pressureOpacity: boolean;
}

export interface TransformRetouchSettings {
  smudge: {
    sizePx: number;
    hardness: number;
    strength: number;
    sampleMerged: boolean;
    pressureStrength: boolean;
  };
  pixelate: {
    brushSizePx: number;
    blockSizePx: number;
    footprint: "round" | "square";
    sampleMerged: boolean;
    featherPx: number;
    interactionMode: "brush" | "selection";
  };
  fill: {
    tolerance: number;
    contiguous: boolean;
    sampleMerged: boolean;
  };
}

export interface TransformRect {
  x: number; y: number; width: number; height: number;
}

export interface TransformExpansion {
  base: TransformRect;
  left: number; top: number; right: number; bottom: number; transition: number;
}

export interface TransformMaskState {
  coverageFrame?: TransformRect | null;
  baseCoverageAssetPath?: string | null;
  hasDraft: boolean;
  coverageAssetPath?: string | null;
  /** Kept while schema 3 documents and older backends are still loadable. */
  draftPath?: string | null;
  overlayColor: string;
  overlayOpacity: number;
  viewMode: TransformMaskViewMode;
  paintedPixels: TransformPaintedPixels;
  lastTool: TransformMaskTool;
  brush: {
    sizePx: number;
    hardness: number;
    strength: number;
    featherPx: number;
    smoothing: number;
  };
  fillTolerance: number;
  proposedFilename?: string | null;
}

export interface TransformCropFrame {
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio: "free" | "source" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
}

export interface TransformSourceImageTransform {
  rotationDegrees: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export interface TransformDocument {
  recipeRevision?: number;
  recipeHash?: string;
  rendererVersion?: string;
  sourceIdentity?: {sha256: string; size: number};
  id: string;
  schemaVersion: number;
  sourceImage: TransformSourceImage;
  project: {
    id?: number | null;
    slug?: string | null;
    folder?: string | null;
  };
  lastUsedMode: TransformMode;
  edit: {
    lastUsedTool: TransformEditTool;
    textObjects: TransformTextObject[];
    paintLayers: TransformPaintLayer[];
    imageLayers: TransformImageLayer[];
    adjustments: TransformAdjustments;
    paintSettings: TransformPaintSettings;
    retouchSettings: TransformRetouchSettings;
    layers: TransformLayer[];
    crop: TransformCropFrame;
    expansion?: TransformExpansion | null;
    sourceImageTransform: TransformSourceImageTransform;
  };
  text: {
    objects: TransformTextObject[];
    layers: TransformLayer[];
  };
  mask: TransformMaskState;
  createdAt: string;
  updatedAt: string;
}

export interface TransformLaunchResponse {
  action_label: "transform";
  source_image: TransformSourceImage;
  project: TransformProjectContext;
  document?: TransformDocument | null;
  resolved_source_path: string;
  launch_image_path: string;
}

export interface TransformDocumentResponse {
  document: TransformDocument;
  saved_at: string;
}

export type TransformSaveMode = "new_copy" | "overwrite_current";

export interface TransformExportResponse {
  source_recipe_revision?: number | null;
  id?: number | null;
  path: string;
  filename: string;
  project_slug?: string | null;
  folder?: string | null;
  saved_at: string;
  mtime?: string | null;
  save_mode?: TransformSaveMode;
  document_id?: string | null;
}

export type TransformMaskSaveLocation = "project_folder" | "project_masks" | "same_folder";

export interface TransformMaskSaveResponse {
  filename: string;
  path: string;
  comfy_filename?: string | null;
  saved_to: TransformMaskSaveLocation;
  project_slug?: string | null;
  project_id?: number | null;
  folder?: string | null;
  saved_at: string;
  mtime?: string | null;
}

export interface TransformFontInfo {
  id: string;
  name: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}

export interface TransformFontsResponse {
  fonts: TransformFontInfo[];
  max_bytes: number;
  allowed_extensions: string[];
}

export interface TransformWorkspaceLaunchPayload {
  imagePath: string;
  images: TransformRailImage[];
  initialMode: TransformMode | LegacyTransformMode;
  workspaceProjectSlug?: string | null;
  workspaceFolder?: string | null;
}
