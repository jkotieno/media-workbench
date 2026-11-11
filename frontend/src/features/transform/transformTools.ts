import type {
  TransformEditTool,
  TransformMaskTool,
  TransformMode,
  TransformPaintLayer,
} from "@/shared/types";

export type TransformToolId = TransformEditTool | TransformMaskTool;

export type TransformToolIcon =
  | "select"
  | "hand"
  | "lettering"
  | "pencil"
  | "brush"
  | "eraser"
  | "fill"
  | "eyedropper"
  | "smudge"
  | "pixelate"
  | "crop"
  | "rectangle"
  | "lasso"
  | "subtract";

export type TransformToolController =
  | "object"
  | "raster-select"
  | "color-select"
  | "pan"
  | "lettering"
  | "paint"
  | "erase"
  | "fill"
  | "sample"
  | "smudge"
  | "pixelate"
  | "crop"
  | "mask";

export type TransformToolDefinition = {
  id: TransformToolId;
  labelKey: string;
  icon: TransformToolIcon;
  shortcut: string;
  mode: TransformMode;
  group: "navigation" | "objects" | "raster" | "retouch" | "frame" | "mask-shape";
  compatibleLayerRoles: Array<NonNullable<TransformPaintLayer["role"]>>;
  cursor: "default" | "grab" | "text" | "crosshair" | "none";
  controller: TransformToolController;
  contextControls: string[];
  inspectorControls: string[];
  statusKey: string;
  commandLabel: string;
};

const editTools: TransformToolDefinition[] = [
  {
    id: "select",
    labelKey: "tools.select",
    icon: "select",
    shortcut: "V",
    mode: "edit",
    group: "navigation",
    compatibleLayerRoles: [],
    cursor: "default",
    controller: "object",
    contextControls: ["selection-actions"],
    inspectorControls: ["object", "layer"],
    statusKey: "status.objectSelect",
    commandLabel: "Move object",
  },
  {
    id: "rect_select",
    labelKey: "tools.rectSelect",
    icon: "rectangle",
    shortcut: "M",
    mode: "edit",
    group: "navigation",
    compatibleLayerRoles: ["paint", "retouch"],
    cursor: "crosshair",
    controller: "raster-select",
    contextControls: ["raster-selection-actions"],
    inspectorControls: ["selection"],
    statusKey: "status.rectSelect",
    commandLabel: "Select pixels",
  },
  {
    id: "select_by_color",
    labelKey: "tools.selectByColor",
    icon: "eyedropper",
    shortcut: "O",
    mode: "edit",
    group: "navigation",
    compatibleLayerRoles: ["paint", "retouch"],
    cursor: "crosshair",
    controller: "color-select",
    contextControls: ["tolerance", "contiguous", "sample-merged"],
    inspectorControls: ["selection"],
    statusKey: "status.selectByColor",
    commandLabel: "Select by color",
  },
  {
    id: "pan",
    labelKey: "tools.pan",
    icon: "hand",
    shortcut: "H",
    mode: "edit",
    group: "navigation",
    compatibleLayerRoles: [],
    cursor: "grab",
    controller: "pan",
    contextControls: ["view"],
    inspectorControls: [],
    statusKey: "status.pan",
    commandLabel: "Pan view",
  },
  {
    id: "lettering",
    labelKey: "tools.lettering",
    icon: "lettering",
    shortcut: "T",
    mode: "edit",
    group: "objects",
    compatibleLayerRoles: [],
    cursor: "text",
    controller: "lettering",
    contextControls: ["lettering-shape", "font", "font-size", "alignment"],
    inspectorControls: ["lettering"],
    statusKey: "status.lettering",
    commandLabel: "Place lettering",
  },
  {
    id: "pencil",
    labelKey: "tools.pencil",
    icon: "pencil",
    shortcut: "P",
    mode: "edit",
    group: "raster",
    compatibleLayerRoles: ["paint"],
    cursor: "none",
    controller: "paint",
    contextControls: ["color", "size", "pressure-size"],
    inspectorControls: ["spacing", "smoothing"],
    statusKey: "status.pencil",
    commandLabel: "Pencil stroke",
  },
  {
    id: "brush",
    labelKey: "tools.brush",
    icon: "brush",
    shortcut: "B",
    mode: "edit",
    group: "raster",
    compatibleLayerRoles: ["paint"],
    cursor: "none",
    controller: "paint",
    contextControls: ["color", "size", "hardness", "opacity", "flow"],
    inspectorControls: ["spacing", "smoothing", "pressure"],
    statusKey: "status.brush",
    commandLabel: "Brush stroke",
  },
  {
    id: "eraser",
    labelKey: "tools.eraser",
    icon: "eraser",
    shortcut: "E",
    mode: "edit",
    group: "raster",
    compatibleLayerRoles: ["paint", "retouch", "source_eraser"],
    cursor: "none",
    controller: "erase",
    contextControls: ["size", "hardness", "opacity", "eraser-target"],
    inspectorControls: ["pressure"],
    statusKey: "status.eraser",
    commandLabel: "Erase stroke",
  },
  {
    id: "fill_bucket",
    labelKey: "tools.fillBucket",
    icon: "fill",
    shortcut: "G",
    mode: "edit",
    group: "raster",
    compatibleLayerRoles: ["paint"],
    cursor: "crosshair",
    controller: "fill",
    contextControls: ["color", "tolerance", "contiguous", "sample-merged"],
    inspectorControls: ["opacity"],
    statusKey: "status.fill",
    commandLabel: "Fill region",
  },
  {
    id: "eyedropper",
    labelKey: "tools.sample",
    icon: "eyedropper",
    shortcut: "I",
    mode: "edit",
    group: "raster",
    compatibleLayerRoles: ["paint", "retouch"],
    cursor: "crosshair",
    controller: "sample",
    contextControls: ["sample-source"],
    inspectorControls: [],
    statusKey: "status.sample",
    commandLabel: "Sample color",
  },
  {
    id: "smudge",
    labelKey: "tools.smudge",
    icon: "smudge",
    shortcut: "S",
    mode: "edit",
    group: "retouch",
    compatibleLayerRoles: ["retouch"],
    cursor: "none",
    controller: "smudge",
    contextControls: ["size", "hardness", "strength", "sample-merged"],
    inspectorControls: ["pressure-strength"],
    statusKey: "status.smudge",
    commandLabel: "Smudge stroke",
  },
  {
    id: "pixelate",
    labelKey: "tools.pixelate",
    icon: "pixelate",
    shortcut: "X",
    mode: "edit",
    group: "retouch",
    compatibleLayerRoles: ["retouch"],
    cursor: "none",
    controller: "pixelate",
    contextControls: ["interaction-mode", "size", "block-size", "footprint", "sample-merged"],
    inspectorControls: ["edge-feather"],
    statusKey: "status.pixelate",
    commandLabel: "Pixelate stroke",
  },
  {
    id: "crop",
    labelKey: "tools.crop",
    icon: "crop",
    shortcut: "C",
    mode: "edit",
    group: "frame",
    compatibleLayerRoles: [],
    cursor: "crosshair",
    controller: "crop",
    contextControls: ["aspect", "crop-reset"],
    inspectorControls: ["crop-geometry"],
    statusKey: "status.crop",
    commandLabel: "Crop image",
  },
];

const maskTools: TransformToolDefinition[] = [
  {
    id: "add",
    labelKey: "tools.maskAdd",
    icon: "brush",
    shortcut: "B",
    mode: "mask",
    group: "raster",
    compatibleLayerRoles: [],
    cursor: "none",
    controller: "mask",
    contextControls: ["mask-size", "hardness", "strength", "feather"],
    inspectorControls: ["mask-smoothing"],
    statusKey: "status.maskAdd",
    commandLabel: "Add to mask",
  },
  {
    id: "subtract",
    labelKey: "tools.maskSubtract",
    icon: "subtract",
    shortcut: "E",
    mode: "mask",
    group: "raster",
    compatibleLayerRoles: [],
    cursor: "none",
    controller: "mask",
    contextControls: ["mask-size", "hardness", "strength", "feather"],
    inspectorControls: ["mask-smoothing"],
    statusKey: "status.maskSubtract",
    commandLabel: "Subtract from mask",
  },
  {
    id: "rectangle",
    labelKey: "tools.rectangle",
    icon: "rectangle",
    shortcut: "R",
    mode: "mask",
    group: "mask-shape",
    compatibleLayerRoles: [],
    cursor: "crosshair",
    controller: "mask",
    contextControls: ["mask-operation", "strength", "feather"],
    inspectorControls: [],
    statusKey: "status.maskRectangle",
    commandLabel: "Mask rectangle",
  },
  {
    id: "lasso",
    labelKey: "tools.lasso",
    icon: "lasso",
    shortcut: "L",
    mode: "mask",
    group: "mask-shape",
    compatibleLayerRoles: [],
    cursor: "crosshair",
    controller: "mask",
    contextControls: ["mask-operation", "strength", "feather"],
    inspectorControls: [],
    statusKey: "status.maskLasso",
    commandLabel: "Mask lasso",
  },
  {
    id: "fill",
    labelKey: "tools.maskFill",
    icon: "fill",
    shortcut: "G",
    mode: "mask",
    group: "mask-shape",
    compatibleLayerRoles: [],
    cursor: "crosshair",
    controller: "mask",
    contextControls: ["mask-operation", "tolerance", "strength"],
    inspectorControls: [],
    statusKey: "status.maskFill",
    commandLabel: "Fill mask region",
  },
  {
    id: "pan",
    labelKey: "tools.pan",
    icon: "hand",
    shortcut: "H",
    mode: "mask",
    group: "navigation",
    compatibleLayerRoles: [],
    cursor: "grab",
    controller: "pan",
    contextControls: ["view"],
    inspectorControls: [],
    statusKey: "status.pan",
    commandLabel: "Pan view",
  },
];

export const TRANSFORM_TOOL_REGISTRY = [...editTools, ...maskTools] as const;

export function getTransformTools(mode: TransformMode): TransformToolDefinition[] {
  return TRANSFORM_TOOL_REGISTRY.filter((tool) => tool.mode === mode);
}

export function getTransformTool(
  mode: TransformMode,
  id: TransformToolId,
): TransformToolDefinition | null {
  return TRANSFORM_TOOL_REGISTRY.find((tool) => tool.mode === mode && tool.id === id) ?? null;
}

export function resolveTransformShortcut(
  mode: TransformMode,
  key: string,
): TransformToolDefinition | null {
  const normalized = key.length === 1 ? key.toUpperCase() : key;
  return (
    TRANSFORM_TOOL_REGISTRY.find(
      (tool) => tool.mode === mode && tool.shortcut.toUpperCase() === normalized,
    ) ?? null
  );
}
