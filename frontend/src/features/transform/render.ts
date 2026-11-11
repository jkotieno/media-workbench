import { expansionFrame } from "./expansion";
import type {
  TransformDocument,
  TransformImageLayer,
  TransformSourceImageTransform,
  TransformTextAlign,
  TransformTextObject,
  TransformTextObjectKind,
} from "@/shared/types";
import {
  defaultTailBaseAngleForObject,
  getOrderedTransformLayers,
  hasTransformTail,
  normalizeTransformSourceImageTransform,
} from "@/features/transform/document";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

export interface TransformCanvasGeometry {
  width: number;
  height: number;
  minX: number;
  minY: number;
  offsetX: number;
  offsetY: number;
  sourceBounds: Rect;
}

export interface TransformLayoutLine {
  text: string;
  width: number;
  x: number;
  y: number;
}

export interface TransformObjectLayout {
  objectId: string;
  kind: TransformTextObjectKind | "image_layer";
  rotation: number;
  center: Point;
  bounds: Rect;
  textBounds: Rect;
  lines: TransformLayoutLine[];
  outline: {
    topLeft: Point;
    topRight: Point;
    bottomRight: Point;
    bottomLeft: Point;
  };
  resizeHandles: {
    right: Point;
    bottom: Point;
    corner: Point;
  };
  textHandle: Point | null;
  tailBaseLocal: Point | null;
  tailBase: Point | null;
  tailTipLocal: Point | null;
  tailTip: Point | null;
}

export interface DrawTransformDocumentOptions {
  skipTextObjectId?: string | null;
  paintLayerImages?: Map<string, CanvasImageSource>;
  imageLayerImages?: Map<string, CanvasImageSource>;
  renderCropOverlay?: boolean;
  applyAdjustments?: boolean;
  clear?: boolean;
  clipBounds?: Rect;
  renderDecorations?: boolean;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function unionRect(base: Rect | null, next: Rect | null): Rect | null {
  if (!next) {
    return base;
  }
  if (!base) {
    return next;
  }
  const minX = Math.min(base.x, next.x);
  const minY = Math.min(base.y, next.y);
  const maxX = Math.max(base.x + base.width, next.x + next.width);
  const maxY = Math.max(base.y + base.height, next.y + next.height);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function getTransformAdjustmentFilter(
  adjustments: TransformDocument["edit"]["adjustments"] | null | undefined,
): string {
  if (!adjustments) {
    return "none";
  }
  const brightness = clamp(Number(adjustments.brightness) || 0, 0, 2);
  const contrast = clamp(Number(adjustments.contrast) || 0, 0, 2);
  const saturation = clamp(Number(adjustments.saturation) || 0, 0, 2);
  const hueDegrees = clamp(Number(adjustments.hueDegrees) || 0, -180, 180);
  if (
    brightness === 1 &&
    contrast === 1 &&
    saturation === 1 &&
    hueDegrees === 0
  ) {
    return "none";
  }
  return `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${hueDegrees}deg)`;
}

function getRotatedRectBounds(rect: Rect, rotation: number): Rect {
  const center = {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
  return rectFromPoints([
    rotatePoint({ x: rect.x, y: rect.y }, center, rotation),
    rotatePoint({ x: rect.x + rect.width, y: rect.y }, center, rotation),
    rotatePoint({ x: rect.x + rect.width, y: rect.y + rect.height }, center, rotation),
    rotatePoint({ x: rect.x, y: rect.y + rect.height }, center, rotation),
  ]) ?? rect;
}

function rectFromPoints(points: Point[]): Rect | null {
  if (!points.length) {
    return null;
  }
  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = points[0]!.x;
  let maxY = points[0]!.y;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function getTransformSourceImageTransform(document: Pick<TransformDocument, "edit">): TransformSourceImageTransform {
  return normalizeTransformSourceImageTransform(document.edit.sourceImageTransform);
}

export function transformSourceImagePoint(
  point: Point,
  sourceImage: Pick<TransformDocument["sourceImage"], "width" | "height">,
  transform: Pick<TransformSourceImageTransform, "rotationDegrees" | "flipHorizontal" | "flipVertical">,
): Point {
  const center = {
    x: sourceImage.width / 2,
    y: sourceImage.height / 2,
  };
  const deltaX = point.x - center.x;
  const deltaY = point.y - center.y;
  const scaledX = deltaX * (transform.flipHorizontal ? -1 : 1);
  const scaledY = deltaY * (transform.flipVertical ? -1 : 1);
  const radians = degreesToRadians(transform.rotationDegrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: center.x + scaledX * cos - scaledY * sin,
    y: center.y + scaledX * sin + scaledY * cos,
  };
}

function getSourceImageTransformBounds(document: Pick<TransformDocument, "sourceImage" | "edit">): Rect {
  const { sourceImage } = document;
  const transform = getTransformSourceImageTransform(document);
  const corners = [
    { x: 0, y: 0 },
    { x: sourceImage.width, y: 0 },
    { x: sourceImage.width, y: sourceImage.height },
    { x: 0, y: sourceImage.height },
  ].map((point) => transformSourceImagePoint(point, sourceImage, transform));
  return rectFromPoints(corners) || {
    x: 0,
    y: 0,
    width: sourceImage.width,
    height: sourceImage.height,
  };
}

function getTransformObjectVisualBounds(object: TransformTextObject): Rect {
  const center = {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2,
  };
  const corners = [
    rotatePoint({ x: object.x, y: object.y }, center, object.rotation),
    rotatePoint({ x: object.x + object.width, y: object.y }, center, object.rotation),
    rotatePoint({ x: object.x + object.width, y: object.y + object.height }, center, object.rotation),
    rotatePoint({ x: object.x, y: object.y + object.height }, center, object.rotation),
  ];
  if (object.tailX != null && object.tailY != null) {
    if (object.kind === "thought_bubble") {
      const tailBaseAngle =
        typeof object.tailBaseAngle === "number"
          ? object.tailBaseAngle
          : defaultTailBaseAngleForObject(object) ?? Math.PI / 2;
      const radiusX = object.width / 2;
      const radiusY = object.height / 2;
      const denominator = Math.sqrt(
        (Math.cos(tailBaseAngle) ** 2) / Math.max(radiusX ** 2, 1e-6) +
          (Math.sin(tailBaseAngle) ** 2) / Math.max(radiusY ** 2, 1e-6),
      );
      const distance = denominator > 0 ? 1 / denominator : 0;
      const tailBase = {
        x: center.x + Math.cos(tailBaseAngle) * distance,
        y: center.y + Math.sin(tailBaseAngle) * distance,
      };
      const dotSpecs = [
        { ratio: 0.24, radius: 13 },
        { ratio: 0.55, radius: 9 },
        { ratio: 0.82, radius: 5 },
      ];
      for (const spec of dotSpecs) {
        const dotCenter = {
          x: tailBase.x + (object.tailX - tailBase.x) * spec.ratio,
          y: tailBase.y + (object.tailY - tailBase.y) * spec.ratio,
        };
        corners.push(
          { x: dotCenter.x - spec.radius, y: dotCenter.y - spec.radius },
          { x: dotCenter.x + spec.radius, y: dotCenter.y + spec.radius },
        );
      }
    } else {
      corners.push({ x: object.tailX, y: object.tailY });
    }
  }
  return rectFromPoints(corners) || {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  };
}

export function getTransformCanvasGeometry(document: Pick<TransformDocument, "sourceImage" | "edit">): TransformCanvasGeometry {
  if (document.edit.expansion) {
    const frame = expansionFrame(document.edit.expansion);
    return { ...frame, minX: frame.x, minY: frame.y, offsetX: -frame.x, offsetY: -frame.y,
      sourceBounds: getSourceImageTransformBounds(document) };
  }
  let bounds: Rect | null = {
    x: 0,
    y: 0,
    width: document.sourceImage.width,
    height: document.sourceImage.height,
  };
  const sourceBounds = getSourceImageTransformBounds(document);
  bounds = unionRect(bounds, sourceBounds);
  const visibleTextObjectIds = new Set(
    getOrderedTransformLayers(document)
      .filter((layer) => layer.kind === "text_object")
      .map((layer) => layer.refId),
  );
  for (const object of document.edit.textObjects) {
    if (!visibleTextObjectIds.has(object.id)) {
      continue;
    }
    bounds = unionRect(bounds, getTransformObjectVisualBounds(object));
  }
  const visibleImageLayerIds = new Set(
    getOrderedTransformLayers(document)
      .filter((layer) => layer.kind === "image_layer")
      .map((layer) => layer.refId),
  );
  for (const imageLayer of document.edit.imageLayers) {
    if (!visibleImageLayerIds.has(imageLayer.id)) {
      continue;
    }
    bounds = unionRect(bounds, getRotatedRectBounds(imageLayer, imageLayer.rotation));
  }
  const minX = bounds?.x ?? 0;
  const minY = bounds?.y ?? 0;
  const maxX = (bounds?.x ?? 0) + (bounds?.width ?? document.sourceImage.width);
  const maxY = (bounds?.y ?? 0) + (bounds?.height ?? document.sourceImage.height);
  return {
    width: Math.max(1, Math.ceil(maxX - minX)),
    height: Math.max(1, Math.ceil(maxY - minY)),
    minX,
    minY,
    offsetX: -minX,
    offsetY: -minY,
    sourceBounds,
  };
}

export function offsetTransformObjectLayout(
  layout: TransformObjectLayout,
  offsetX: number,
  offsetY: number,
): TransformObjectLayout {
  const offsetPoint = (point: Point | null): Point | null =>
    point ? { x: point.x + offsetX, y: point.y + offsetY } : null;
  return {
    ...layout,
    center: offsetPoint(layout.center)!,
    bounds: {
      x: layout.bounds.x + offsetX,
      y: layout.bounds.y + offsetY,
      width: layout.bounds.width,
      height: layout.bounds.height,
    },
    textBounds: {
      x: layout.textBounds.x + offsetX,
      y: layout.textBounds.y + offsetY,
      width: layout.textBounds.width,
      height: layout.textBounds.height,
    },
    lines: layout.lines.map((line) => ({
      ...line,
      x: line.x + offsetX,
      y: line.y + offsetY,
    })),
    outline: {
      topLeft: offsetPoint(layout.outline.topLeft)!,
      topRight: offsetPoint(layout.outline.topRight)!,
      bottomRight: offsetPoint(layout.outline.bottomRight)!,
      bottomLeft: offsetPoint(layout.outline.bottomLeft)!,
    },
    resizeHandles: {
      right: offsetPoint(layout.resizeHandles.right)!,
      bottom: offsetPoint(layout.resizeHandles.bottom)!,
      corner: offsetPoint(layout.resizeHandles.corner)!,
    },
    textHandle: offsetPoint(layout.textHandle),
    tailBaseLocal: offsetPoint(layout.tailBaseLocal),
    tailBase: offsetPoint(layout.tailBase),
    tailTipLocal: offsetPoint(layout.tailTipLocal),
    tailTip: offsetPoint(layout.tailTip),
  };
}

function computeImageLayerLayout(imageLayer: TransformImageLayer): TransformObjectLayout {
  const bounds = {
    x: imageLayer.x,
    y: imageLayer.y,
    width: imageLayer.width,
    height: imageLayer.height,
  };
  const center = {
    x: imageLayer.x + imageLayer.width / 2,
    y: imageLayer.y + imageLayer.height / 2,
  };
  return {
    objectId: imageLayer.id,
    kind: "image_layer",
    rotation: imageLayer.rotation,
    center,
    bounds,
    textBounds: bounds,
    lines: [],
    outline: {
      topLeft: { x: bounds.x, y: bounds.y },
      topRight: { x: bounds.x + bounds.width, y: bounds.y },
      bottomRight: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      bottomLeft: { x: bounds.x, y: bounds.y + bounds.height },
    },
    resizeHandles: {
      right: { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
      bottom: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
      corner: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    },
    textHandle: null,
    tailBaseLocal: null,
    tailBase: null,
    tailTipLocal: null,
    tailTip: null,
  };
}

export function rotatePoint(point: Point, center: Point, rotation: number): Point {
  if (!rotation) {
    return point;
  }
  const radians = degreesToRadians(rotation);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const deltaX = point.x - center.x;
  const deltaY = point.y - center.y;
  return {
    x: center.x + deltaX * cos - deltaY * sin,
    y: center.y + deltaX * sin + deltaY * cos,
  };
}

export function unrotatePoint(point: Point, center: Point, rotation: number): Point {
  return rotatePoint(point, center, -rotation);
}

export function pointDistance(pointA: Point, pointB: Point): number {
  const deltaX = pointA.x - pointB.x;
  const deltaY = pointA.y - pointB.y;
  return Math.sqrt(deltaX ** 2 + deltaY ** 2);
}

function setObjectFont(
  context: CanvasRenderingContext2D,
  object: TransformTextObject,
): void {
  context.font = `${object.fontSize}px "${object.fontFamily}"`;
  context.textBaseline = "top";
}

function measureTextWidth(
  context: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number,
): number {
  const measured = context.measureText(text).width;
  if (!text.length) {
    return measured;
  }
  return measured + Math.max(0, text.length - 1) * letterSpacing;
}

function wrapSingleLine(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  letterSpacing: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let currentLine = "";

  const pushCurrent = () => {
    lines.push(currentLine.trimEnd());
    currentLine = "";
  };

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (measureTextWidth(context, candidate, letterSpacing) <= maxWidth || !currentLine) {
      currentLine = candidate;
      if (measureTextWidth(context, candidate, letterSpacing) <= maxWidth) {
        continue;
      }
    }

    if (currentLine && measureTextWidth(context, currentLine, letterSpacing) > maxWidth) {
      currentLine = "";
      let chunk = "";
      for (const character of word) {
        const nextChunk = `${chunk}${character}`;
        if (chunk && measureTextWidth(context, nextChunk, letterSpacing) > maxWidth) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk = nextChunk;
        }
      }
      currentLine = chunk;
      continue;
    }

    pushCurrent();
    currentLine = word;
  }

  if (currentLine || lines.length === 0) {
    pushCurrent();
  }

  return lines;
}

function wrapText(
  context: CanvasRenderingContext2D,
  object: TransformTextObject,
  width: number,
): string[] {
  const paragraphs = object.text.split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    lines.push(...wrapSingleLine(context, paragraph, width, object.letterSpacing));
  }
  return lines.length ? lines : [""];
}

function computeTextX(
  align: TransformTextAlign,
  textBounds: { x: number; width: number },
  lineWidth: number,
): number {
  if (align === "left") {
    return textBounds.x;
  }
  if (align === "right") {
    return textBounds.x + textBounds.width - lineWidth;
  }
  return textBounds.x + (textBounds.width - lineWidth) / 2;
}

function projectRayToEllipsePerimeter(center: Point, bounds: Rect, angle: number): Point {
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const denominator = Math.sqrt(
    (directionX ** 2) / Math.max(radiusX ** 2, 1e-6) +
      (directionY ** 2) / Math.max(radiusY ** 2, 1e-6),
  );
  const distance = denominator > 0 ? 1 / denominator : 0;
  return {
    x: center.x + directionX * distance,
    y: center.y + directionY * distance,
  };
}

function computeTailBaseLocal(object: TransformTextObject, bounds: Rect, center: Point): Point | null {
  if (!hasTransformTail(object.kind)) {
    return null;
  }
  const angle =
    typeof object.tailBaseAngle === "number"
      ? object.tailBaseAngle
      : defaultTailBaseAngleForObject(object) ?? Math.PI / 2;
  return projectRayToEllipsePerimeter(center, bounds, angle);
}

function computeTextBounds(object: TransformTextObject, center: Point): Rect {
  const padding = object.padding;
  const baseBounds = {
    x: object.x + padding + object.textOffsetX,
    y: object.y + padding + object.textOffsetY,
    width: Math.max(24, object.width - padding * 2),
    height: Math.max(24, object.height - padding * 2),
  };

  if (object.kind === "free_text" || object.kind === "narration_box" || object.kind === "narration_rect") {
    return baseBounds;
  }

  const safeWidthFactor =
    object.kind === "thought_bubble"
      ? 0.72
      : object.kind === "burst_jagged" || object.kind === "burst_wavy"
        ? 0.62
        : 0.82;
  const safeHeightFactor =
    object.kind === "thought_bubble"
      ? 0.66
      : object.kind === "burst_jagged" || object.kind === "burst_wavy"
        ? 0.58
        : 0.74;
  const safeWidth = Math.max(24, baseBounds.width * safeWidthFactor);
  const safeHeight = Math.max(24, baseBounds.height * safeHeightFactor);
  return {
    x: center.x - safeWidth / 2 + object.textOffsetX,
    y: center.y - safeHeight / 2 + object.textOffsetY,
    width: safeWidth,
    height: safeHeight,
  };
}

export function computeObjectLayout(
  context: CanvasRenderingContext2D,
  object: TransformTextObject,
): TransformObjectLayout {
  setObjectFont(context, object);

  const bounds = {
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  };
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const textBounds = computeTextBounds(object, center);
  const wrappedLines = wrapText(context, object, textBounds.width);
  const lineHeightPx = object.fontSize * object.lineHeight;
  const lines = wrappedLines.map((line, index) => {
    const width = measureTextWidth(context, line, object.letterSpacing);
    return {
      text: line,
      width,
      x: computeTextX(object.textAlign, textBounds, width),
      y: textBounds.y + index * lineHeightPx,
    };
  });

  const tailBaseLocal = computeTailBaseLocal(object, bounds, center);
  const tailBase = tailBaseLocal ? rotatePoint(tailBaseLocal, center, object.rotation) : null;
  const tailTip =
    tailBase && object.tailX != null && object.tailY != null
      ? { x: object.tailX, y: object.tailY }
      : null;
  const tailTipLocal = tailTip ? unrotatePoint(tailTip, center, object.rotation) : null;

  const outline = {
    topLeft: rotatePoint({ x: bounds.x, y: bounds.y }, center, object.rotation),
    topRight: rotatePoint({ x: bounds.x + bounds.width, y: bounds.y }, center, object.rotation),
    bottomRight: rotatePoint(
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      center,
      object.rotation,
    ),
    bottomLeft: rotatePoint(
      { x: bounds.x, y: bounds.y + bounds.height },
      center,
      object.rotation,
    ),
  };

  return {
    objectId: object.id,
    kind: object.kind,
    rotation: object.rotation || 0,
    center,
    bounds,
    textBounds,
    lines,
    outline,
    resizeHandles: {
      right: rotatePoint(
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
        center,
        object.rotation,
      ),
      bottom: rotatePoint(
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
        center,
        object.rotation,
      ),
      corner: rotatePoint(
        { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        center,
        object.rotation,
      ),
    },
    textHandle:
      object.kind === "free_text"
        ? null
        : rotatePoint(
          {
            x: textBounds.x + textBounds.width / 2,
            y: textBounds.y + textBounds.height / 2,
          },
          center,
          object.rotation,
        ),
    tailBaseLocal,
    tailBase,
    tailTipLocal,
    tailTip,
  };
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  bounds: Rect,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, radius);
}

function pointOnEllipse(center: Point, radiusX: number, radiusY: number, angle: number): Point {
  return {
    x: center.x + radiusX * Math.cos(angle),
    y: center.y + radiusY * Math.sin(angle),
  };
}

function computeEllipseTailAttachment(layout: TransformObjectLayout, tailWidth: number): {
  start: Point;
  end: Point;
  startAngle: number;
  endAngle: number;
} | null {
  if (!layout.tailBaseLocal || !layout.tailTipLocal) {
    return null;
  }

  const radiusX = layout.bounds.width / 2;
  const radiusY = layout.bounds.height / 2;
  const baseAngle = Math.atan2(
    (layout.tailBaseLocal.y - layout.center.y) / Math.max(radiusY, 1e-6),
    (layout.tailBaseLocal.x - layout.center.x) / Math.max(radiusX, 1e-6),
  );
  const baseHalfWidth = clamp(tailWidth / 2, 4, Math.min(layout.bounds.width, layout.bounds.height) * 0.45);
  const angleSpan = clamp(baseHalfWidth / Math.max(Math.min(radiusX, radiusY), 1e-6), 0.04, 0.9);
  const startAngle = baseAngle - angleSpan;
  const endAngle = baseAngle + angleSpan;

  return {
    start: pointOnEllipse(layout.center, radiusX, radiusY, startAngle),
    end: pointOnEllipse(layout.center, radiusX, radiusY, endAngle),
    startAngle,
    endAngle,
  };
}

function drawSpeechBubble(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
  tailWidth: number,
  strokeWidth: number,
): void {
  const fullCircle = Math.PI * 2;
  const { x, y, width, height } = layout.bounds;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const fallbackTailWidth = Math.max(32, Math.min(width, height) * 0.18);
  const resolvedTailWidth = Number.isFinite(tailWidth) && tailWidth > 0 ? tailWidth : fallbackTailWidth;
  const tailAttachment = computeEllipseTailAttachment(layout, resolvedTailWidth);
  const previousLineJoin = context.lineJoin;
  const previousMiterLimit = context.miterLimit;

  context.lineJoin = "round";
  context.miterLimit = 2;
  context.beginPath();
  if (tailAttachment && layout.tailTipLocal) {
    context.ellipse(
      x + width / 2,
      y + height / 2,
      radiusX,
      radiusY,
      0,
      tailAttachment.endAngle,
      tailAttachment.startAngle + fullCircle,
    );
    context.lineTo(layout.tailTipLocal.x, layout.tailTipLocal.y);
    context.lineTo(tailAttachment.end.x, tailAttachment.end.y);
  } else {
    context.ellipse(x + width / 2, y + height / 2, radiusX, radiusY, 0, 0, fullCircle);
  }
  context.closePath();
  context.fill();
  if (strokeWidth > 0) {
    context.stroke();
  }

  context.lineJoin = previousLineJoin;
  context.miterLimit = previousMiterLimit;
}

function drawThoughtBubble(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
): void {
  const { x, y, width, height } = layout.bounds;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const segmentCount = 14;
  const startAngle = -Math.PI / 2;
  const first = pointOnEllipse({ x: centerX, y: centerY }, radiusX, radiusY, startAngle);
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 0; index < segmentCount; index += 1) {
    const angleA = startAngle + (index / segmentCount) * Math.PI * 2;
    const angleB = startAngle + ((index + 1) / segmentCount) * Math.PI * 2;
    const midAngle = (angleA + angleB) / 2;
    const end = pointOnEllipse({ x: centerX, y: centerY }, radiusX, radiusY, angleB);
    const control = {
      x: centerX + Math.cos(midAngle) * radiusX * 1.16,
      y: centerY + Math.sin(midAngle) * radiusY * 1.16,
    };
    context.quadraticCurveTo(control.x, control.y, end.x, end.y);
  }
  context.closePath();
}

function drawNarrationBox(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
  rounded: boolean,
): void {
  if (rounded) {
    drawRoundedRect(context, layout.bounds, 12);
    return;
  }
  context.beginPath();
  context.rect(layout.bounds.x, layout.bounds.y, layout.bounds.width, layout.bounds.height);
  context.closePath();
}

function drawJaggedBurst(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
): void {
  const { x, y, width, height } = layout.bounds;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const spikeCount = 18;
  const startAngle = -Math.PI / 2;
  context.beginPath();
  for (let index = 0; index <= spikeCount * 2; index += 1) {
    const isOuter = index % 2 === 0;
    const angle = startAngle + (index / (spikeCount * 2)) * Math.PI * 2;
    const radiusFactor = isOuter ? 0.98 : 0.58;
    const point = {
      x: centerX + Math.cos(angle) * radiusX * radiusFactor,
      y: centerY + Math.sin(angle) * radiusY * radiusFactor,
    };
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  }
  context.closePath();
}

function drawWavyBurst(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
): void {
  const { x, y, width, height } = layout.bounds;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  const waveCount = 18;
  const startAngle = -Math.PI / 2;
  const first = {
    x: centerX + Math.cos(startAngle) * radiusX * 0.96,
    y: centerY + Math.sin(startAngle) * radiusY * 0.96,
  };
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 0; index < waveCount; index += 1) {
    const angleA = startAngle + (index / waveCount) * Math.PI * 2;
    const angleB = startAngle + ((index + 1) / waveCount) * Math.PI * 2;
    const midAngle = (angleA + angleB) / 2;
    const end = {
      x: centerX + Math.cos(angleB) * radiusX * 0.96,
      y: centerY + Math.sin(angleB) * radiusY * 0.96,
    };
    const control = {
      x: centerX + Math.cos(midAngle) * radiusX * 0.68,
      y: centerY + Math.sin(midAngle) * radiusY * 0.68,
    };
    context.quadraticCurveTo(control.x, control.y, end.x, end.y);
  }
  context.closePath();
}

function drawTailCircles(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
): void {
  if (!layout.tailBaseLocal || !layout.tailTipLocal) {
    return;
  }
  const deltaX = layout.tailTipLocal.x - layout.tailBaseLocal.x;
  const deltaY = layout.tailTipLocal.y - layout.tailBaseLocal.y;
  const circles = [
    {
      x: layout.tailBaseLocal.x + deltaX * 0.24,
      y: layout.tailBaseLocal.y + deltaY * 0.24,
      radius: 13,
    },
    {
      x: layout.tailBaseLocal.x + deltaX * 0.55,
      y: layout.tailBaseLocal.y + deltaY * 0.55,
      radius: 9,
    },
    {
      x: layout.tailBaseLocal.x + deltaX * 0.82,
      y: layout.tailBaseLocal.y + deltaY * 0.82,
      radius: 5,
    },
  ];

  for (const circle of circles) {
    context.beginPath();
    context.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
    context.fill();
    if (context.lineWidth > 0) {
      context.stroke();
    }
  }
}

function drawTextObject(
  context: CanvasRenderingContext2D,
  layout: TransformObjectLayout,
  object: TransformTextObject,
): void {
  context.save();
  setObjectFont(context, object);
  context.fillStyle = object.textColor;
  context.textAlign = "left";

  if (object.kind !== "free_text") {
    context.save();
    context.beginPath();
    context.rect(
      layout.textBounds.x - 6,
      layout.textBounds.y - 6,
      layout.textBounds.width + 12,
      layout.textBounds.height + 12,
    );
    context.clip();
  }

  for (const line of layout.lines) {
    let cursorX = line.x;
    for (const character of line.text) {
      context.fillText(character, cursorX, line.y);
      cursorX += context.measureText(character).width + object.letterSpacing;
    }
  }

  if (object.kind !== "free_text") {
    context.restore();
  }
  context.restore();
}

export function drawTransformDocumentDecorations(
  context: CanvasRenderingContext2D,
  document: TransformDocument,
  layouts: TransformObjectLayout[],
  selectedObjectId: string | null,
  options: Pick<DrawTransformDocumentOptions, "renderCropOverlay"> = {},
): void {
  const { width, height } = document.sourceImage;
  const geometry = getTransformCanvasGeometry(document);
  context.save();
  context.translate(geometry.offsetX, geometry.offsetY);

  const selectedLayout = selectedObjectId
    ? layouts.find((layout) => layout.objectId === selectedObjectId)
    : null;
  if (selectedLayout) {
    context.save();
    context.translate(selectedLayout.center.x, selectedLayout.center.y);
    context.rotate(degreesToRadians(selectedLayout.rotation));
    context.translate(-selectedLayout.center.x, -selectedLayout.center.y);
    context.strokeStyle = "#60a5fa";
    context.lineWidth = 2;
    context.setLineDash([8, 6]);
    context.strokeRect(
      selectedLayout.bounds.x - 3,
      selectedLayout.bounds.y - 3,
      selectedLayout.bounds.width + 6,
      selectedLayout.bounds.height + 6,
    );
    context.restore();
  }

  const crop = document.edit.crop;
  if (options.renderCropOverlay && crop.enabled && !document.edit.expansion) {
    context.save();
    context.fillStyle = "rgba(15, 23, 42, 0.45)";
    context.beginPath();
    context.rect(geometry.minX, geometry.minY, geometry.width, geometry.height);
    context.rect(crop.x, crop.y, crop.width, crop.height);
    context.fill("evenodd");
    context.strokeStyle = "#f8fafc";
    context.lineWidth = Math.max(2, Math.min(width, height) * 0.003);
    context.setLineDash([12, 8]);
    context.strokeRect(crop.x, crop.y, crop.width, crop.height);
    context.restore();
  }

  context.restore();
}

export function drawTransformDocument(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  document: TransformDocument,
  selectedObjectId: string | null,
  options: DrawTransformDocumentOptions = {},
): TransformObjectLayout[] {
  const { width, height } = document.sourceImage;
  const geometry = getTransformCanvasGeometry(document);
  const sourceTransform = getTransformSourceImageTransform(document);
  const sourceCenter = {
    x: width / 2,
    y: height / 2,
  };
  context.save();
  if (options.clipBounds) {
    context.beginPath();
    context.rect(
      options.clipBounds.x,
      options.clipBounds.y,
      options.clipBounds.width,
      options.clipBounds.height,
    );
    context.clip();
  }
  if (options.clear !== false) {
    context.clearRect(0, 0, geometry.width, geometry.height);
  }

  const layouts: TransformObjectLayout[] = [];
  const objectMap = new Map(document.edit.textObjects.map((object) => [object.id, object]));
  const paintMap = new Map(document.edit.paintLayers.map((layer) => [layer.id, layer]));
  const imageMap = new Map(document.edit.imageLayers.map((layer) => [layer.id, layer]));
  const adjustmentFilter = options.applyAdjustments === false
    ? "none"
    : getTransformAdjustmentFilter(document.edit.adjustments);
  context.save();
  context.translate(geometry.offsetX, geometry.offsetY);
  context.save();
  context.translate(sourceCenter.x, sourceCenter.y);
  context.rotate(degreesToRadians(sourceTransform.rotationDegrees));
  context.scale(sourceTransform.flipHorizontal ? -1 : 1, sourceTransform.flipVertical ? -1 : 1);
  context.filter = adjustmentFilter;
  context.drawImage(image, -width / 2, -height / 2, width, height);
  context.restore();
  for (const layer of getOrderedTransformLayers(document)) {
    if (!layer.visible || layer.kind !== "paint_layer") {
      continue;
    }
    const paintLayer = paintMap.get(layer.refId);
    if (paintLayer?.role !== "source_eraser") {
      continue;
    }
    const paintImage = options.paintLayerImages?.get(layer.refId);
    if (!paintImage) {
      continue;
    }
    context.save();
    context.globalAlpha = layer.opacity;
    context.globalCompositeOperation = "destination-out";
    context.drawImage(paintImage, 0, 0, width, height);
    context.restore();
  }
  for (const layer of getOrderedTransformLayers(document)) {
    if (!layer.visible) {
      continue;
    }
    if (layer.kind === "paint_layer") {
      const paintLayer = paintMap.get(layer.refId);
      const paintImage = options.paintLayerImages?.get(layer.refId);
      if (!paintLayer || !paintImage) {
        continue;
      }
      if (paintLayer.role === "source_eraser") {
        continue;
      }
      context.save();
      context.globalAlpha = layer.opacity;
      context.filter = adjustmentFilter;
      context.drawImage(paintImage, 0, 0, width, height);
      context.restore();
      continue;
    }
    if (layer.kind === "image_layer") {
      const imageLayer = imageMap.get(layer.refId);
      const imageLayerImage = options.imageLayerImages?.get(layer.refId);
      if (!imageLayer || !imageLayerImage) {
        continue;
      }
      const layout = computeImageLayerLayout(imageLayer);
      layouts.push(layout);
      context.save();
      context.globalAlpha = layer.opacity;
      context.filter = adjustmentFilter;
      context.translate(layout.center.x, layout.center.y);
      context.rotate(degreesToRadians(layout.rotation));
      context.drawImage(
        imageLayerImage,
        -imageLayer.width / 2,
        -imageLayer.height / 2,
        imageLayer.width,
        imageLayer.height,
      );
      context.restore();
      continue;
    }

    const object = objectMap.get(layer.refId);
    if (!object) {
      continue;
    }
    const layout = computeObjectLayout(context, object);
    layouts.push(layout);

    context.save();
    context.globalAlpha = layer.opacity;
    context.filter = adjustmentFilter;
    context.translate(layout.center.x, layout.center.y);
    context.rotate(degreesToRadians(layout.rotation));
    context.translate(-layout.center.x, -layout.center.y);

    if (object.kind === "speech_bubble") {
      context.fillStyle = object.fillColor;
      context.strokeStyle = object.strokeColor;
      context.lineWidth = object.strokeWidth;
      drawSpeechBubble(context, layout, object.tailWidth, object.strokeWidth);
    } else if (object.kind === "thought_bubble") {
      context.fillStyle = object.fillColor;
      context.strokeStyle = object.strokeColor;
      context.lineWidth = object.strokeWidth;
      drawThoughtBubble(context, layout);
      context.fill();
      if (object.strokeWidth > 0) {
        context.stroke();
      }
      drawTailCircles(context, layout);
    } else if (object.kind === "narration_box" || object.kind === "narration_rect") {
      context.fillStyle = object.fillColor;
      context.strokeStyle = object.strokeColor;
      context.lineWidth = object.strokeWidth;
      drawNarrationBox(context, layout, object.kind === "narration_box");
      context.fill();
      if (object.strokeWidth > 0) {
        context.stroke();
      }
    } else if (object.kind === "burst_jagged" || object.kind === "burst_wavy") {
      context.fillStyle = object.fillColor;
      context.strokeStyle = object.strokeColor;
      context.lineWidth = object.strokeWidth;
      if (object.kind === "burst_jagged") {
        drawJaggedBurst(context, layout);
      } else {
        drawWavyBurst(context, layout);
      }
      context.fill();
      if (object.strokeWidth > 0) {
        context.stroke();
      }
    }

    if (options.skipTextObjectId !== object.id) {
      drawTextObject(context, layout, object);
    }

    context.restore();
  }

  context.restore();
  if (options.renderDecorations !== false) {
    drawTransformDocumentDecorations(
      context,
      document,
      layouts,
      selectedObjectId,
      options,
    );
  }
  context.restore();

  return layouts;
}

function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function findObjectAtPoint(
  layouts: TransformObjectLayout[],
  point: Point,
): TransformObjectLayout | null {
  for (let index = layouts.length - 1; index >= 0; index -= 1) {
    const layout = layouts[index];
    const localPoint = unrotatePoint(point, layout.center, layout.rotation);
    if (pointInRect(localPoint, layout.bounds)) {
      return layout;
    }
  }
  return null;
}

export function distanceToTailHandle(
  layout: TransformObjectLayout,
  point: Point,
): number {
  if (!layout.tailTip) {
    return Number.POSITIVE_INFINITY;
  }
  return pointDistance(point, layout.tailTip);
}

export function distanceToResizeHandle(
  layout: TransformObjectLayout,
  point: Point,
): number {
  return pointDistance(point, layout.resizeHandles.corner);
}
