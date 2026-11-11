import { afterEach, describe, expect, it } from "vitest";

import {
  createTransformDocument,
  createTransformImageLayer,
  createTransformImageLayerEntry,
  createTransformPaintLayer,
  createTransformPaintLayerEntry,
  getOrderedTransformLayers,
  moveTransformLayer,
} from "@/features/transform/document";
import {
  coverageToOpaqueRgbaBytes,
  coverageToOutputBytes,
  normalizeMaskDraftPixels,
} from "@/features/transform/maskCoverage";
import {
  applyRasterTileDiff,
  getSourceAnchoredPixelBlock,
  type RasterTileDiff,
} from "@/features/transform/rasterEngine";
import {
  computeFloodFillMask,
  computeFloodFillMaskCooperative,
} from "@/features/transform/rasterOperations";
import { selectionFromMask } from "@/features/transform/rasterSelection";
import { getTransformAdjustmentFilter, getTransformCanvasGeometry } from "@/features/transform/render";
import {
  getTransformTools,
  resolveTransformShortcut,
} from "@/features/transform/transformTools";
import {
  TRANSFORM_HISTORY_BYTE_LIMIT,
  capTransformHistoryEntriesByMemory,
  type TransformHistoryEntry,
} from "@/features/transform/useTransformHistory";
import { resolveTransformLaunchTargets } from "@/features/transform/useTransformLaunchSession";
import type { TransformDocument } from "@/shared/types";

function makeDocument(): TransformDocument {
  return createTransformDocument({
    sourceImage: {
      path: "/tmp/source.png",
      format: "png",
      width: 640,
      height: 480,
      hash: null,
    },
    project: {
      id: 1,
      slug: "demo",
      folder: "panels",
      available_folders: ["panels", "masks"],
    },
    initialMode: "edit",
  });
}

describe("Transform V2 foundational contracts", () => {
  it("keeps mask coverage intermediate values and maps polarity deterministically", () => {
    const coverage = new Uint8ClampedArray([0, 17, 127, 254]);
    const rgba = coverageToOpaqueRgbaBytes(coverage, "white");

    expect(normalizeMaskDraftPixels(rgba, 4, 1)).toEqual(coverage);
    expect(coverageToOutputBytes(coverage, "white")).toEqual(coverage);
    expect(coverageToOutputBytes(coverage, "black")).toEqual(
      new Uint8ClampedArray([255, 238, 128, 1]),
    );
  });

  it("anchors every Pixelate block to source coordinates", () => {
    expect(getSourceAnchoredPixelBlock(31.9, 47.2, 16)).toEqual({
      x: 16,
      y: 32,
      width: 16,
      height: 16,
    });
    expect(getSourceAnchoredPixelBlock(31.9, 47.2, 16)).toEqual(
      getSourceAnchoredPixelBlock(31.9, 47.2, 16),
    );
    expect(getSourceAnchoredPixelBlock(32.1, 47.2, 16).x).toBe(32);
  });

  it("restores exact raster tile bytes in both directions", () => {
    const originalImageData = globalThis.ImageData;
    class TestImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    }
    Object.defineProperty(globalThis, "ImageData", {
      configurable: true,
      value: TestImageData,
    });
    const width = 4;
    const target = new Uint8ClampedArray(width * 3 * 4);
    const context = {
      canvas: { width, height: 3 },
      putImageData: (
        imageData: { data: Uint8ClampedArray; width: number; height: number },
        x: number,
        y: number,
      ) => {
        for (let row = 0; row < imageData.height; row += 1) {
          const targetOffset = ((y + row) * width + x) * 4;
          const sourceOffset = row * imageData.width * 4;
          target.set(
            imageData.data.subarray(
              sourceOffset,
              sourceOffset + imageData.width * 4,
            ),
            targetOffset,
          );
        }
      },
    } as unknown as CanvasRenderingContext2D;
    const before = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const after = new Uint8ClampedArray([9, 10, 11, 12, 13, 14, 15, 16]);
    const diff: RasterTileDiff = {
      layerId: "retouch-1",
      tileSize: 128,
      patches: [{ x: 1, y: 1, width: 2, height: 1, before, after }],
      byteLength: before.byteLength + after.byteLength,
    };

    applyRasterTileDiff(context, diff, "after");
    expect(target.slice(20, 28)).toEqual(after);
    applyRasterTileDiff(context, diff, "before");
    expect(target.slice(20, 28)).toEqual(before);

    Object.defineProperty(globalThis, "ImageData", {
      configurable: true,
      value: originalImageData,
    });
  });

  it("uses tolerance and contiguity for continuous-tone fill regions", () => {
    const rgba = new Uint8ClampedArray([
      10, 10, 10, 255,
      16, 16, 16, 255,
      120, 120, 120, 255,
      10, 10, 10, 255,
    ]);
    const contiguous = computeFloodFillMask({
      rgba,
      width: 4,
      height: 1,
      startX: 0,
      startY: 0,
      tolerance: 10,
      contiguous: true,
    });
    const global = computeFloodFillMask({
      rgba,
      width: 4,
      height: 1,
      startX: 0,
      startY: 0,
      tolerance: 10,
      contiguous: false,
    });

    expect([...contiguous.mask]).toEqual([255, 255, 0, 0]);
    expect([...global.mask]).toEqual([255, 255, 0, 255]);
  });

  it("keeps cooperative worker fill byte-identical to synchronous fill", async () => {
    const rgba = new Uint8ClampedArray([
      10, 10, 10, 255,
      16, 16, 16, 255,
      120, 120, 120, 255,
      10, 10, 10, 255,
    ]);
    const request = {
      rgba,
      width: 4,
      height: 1,
      startX: 0,
      startY: 0,
      tolerance: 10,
      contiguous: false,
    };

    const synchronous = computeFloodFillMask(request);
    const cooperative = await computeFloodFillMaskCooperative(
      request,
      async () => undefined,
    );

    expect(cooperative.bounds).toEqual(synchronous.bounds);
    expect(cooperative.mask).toEqual(synchronous.mask);
  });

  it("registers every required Edit and Mask tool with resolvable shortcuts", () => {
    expect(getTransformTools("edit").map((tool) => tool.id)).toEqual([
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
    ]);
    expect(getTransformTools("mask").map((tool) => tool.id)).toEqual([
      "add",
      "subtract",
      "rectangle",
      "lasso",
      "fill",
      "pan",
    ]);
    for (const mode of ["edit", "mask"] as const) {
      for (const tool of getTransformTools(mode)) {
        expect(tool.controller).toBeTruthy();
        expect(tool.contextControls.length).toBeGreaterThan(0);
        expect(resolveTransformShortcut(mode, tool.shortcut)?.id).toBe(tool.id);
      }
    }
  });

  it("keeps imported image layers ordered, transformable, and inside canvas geometry", () => {
    const document = makeDocument();
    const imageLayer = createTransformImageLayer({
      intrinsicWidth: 1200,
      intrinsicHeight: 600,
      sourceWidth: document.sourceImage.width,
      sourceHeight: document.sourceImage.height,
      dataUrl: "data:image/png;base64,AAAA",
      sourcePath: "/project/gallery/reference.png",
      center: { x: 700, y: 520 },
    });
    const entry = createTransformImageLayerEntry(imageLayer, 0, "reference");
    document.edit.imageLayers.push(imageLayer);
    document.edit.layers.push(entry);

    const geometry = getTransformCanvasGeometry(document);

    expect(entry.kind).toBe("image_layer");
    expect(imageLayer.width / imageLayer.height).toBeCloseTo(2);
    expect(geometry.width).toBeGreaterThan(document.sourceImage.width);
    expect(geometry.height).toBeGreaterThan(document.sourceImage.height);
  });

  it("builds one deterministic compositor filter for simple adjustments", () => {
    expect(getTransformAdjustmentFilter({
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hueDegrees: 0,
    })).toBe("none");
    expect(getTransformAdjustmentFilter({
      brightness: 1.2,
      contrast: 0.8,
      saturation: 1.5,
      hueDegrees: -30,
    })).toBe(
      "brightness(1.2) contrast(0.8) saturate(1.5) hue-rotate(-30deg)",
    );
  });

  it("retains the exact full-canvas color-selection mask and its bounds", () => {
    const mask = new Uint8Array([255, 0, 0, 255]);
    const selection = selectionFromMask(mask, {
      x: 0,
      y: 0,
      width: 4,
      height: 1,
    });
    expect(selection?.mask).toBe(mask);
    expect(selection?.bounds).toEqual({ x: 0, y: 0, width: 4, height: 1 });
  });

  it("defaults Export and Save Mask to the caller's project folder", () => {
    expect(resolveTransformLaunchTargets(
      {
        workspaceProjectSlug: "caller-project",
        workspaceFolder: "storyboards/chapter-2",
      },
      { slug: "source-project", folder: "source-folder" },
      "mask",
    )).toEqual({
      projectSlug: "caller-project",
      exportFolder: "storyboards/chapter-2",
      maskFolder: "storyboards/chapter-2",
    });
  });

  it("uses layer order as compositor order after drag reordering", () => {
    const document = makeDocument();
    const first = createTransformPaintLayer(document.sourceImage, "paint");
    const second = createTransformPaintLayer(document.sourceImage, "retouch");
    const firstEntry = createTransformPaintLayerEntry(first, 0);
    const secondEntry = createTransformPaintLayerEntry(second, 1);
    document.edit.paintLayers.push(first, second);
    document.edit.layers.push(firstEntry, secondEntry);

    const reordered = moveTransformLayer(document, secondEntry.id, firstEntry.id);

    expect(getOrderedTransformLayers(reordered).map((layer) => layer.id)).toEqual([
      secondEntry.id,
      firstEntry.id,
    ]);
  });

  it("truncates unreachable raster history by bytes", () => {
    const document = makeDocument();
    const selection = {
      selectedObjectId: null,
      selectedLayerId: null,
      editingObjectId: null,
    };
    const makeEntry = (label: string): TransformHistoryEntry => ({
      label,
      timestamp: "2026-07-19T00:00:00Z",
      affectedLayerIds: ["retouch-1"],
      beforeDocument: document,
      afterDocument: document,
      beforeSelection: selection,
      afterSelection: selection,
      paintDiffs: [{
        layerId: "retouch-1",
        tileSize: 128,
        patches: [],
        byteLength: 60 * 1024 * 1024,
      }],
    });

    const capped = capTransformHistoryEntriesByMemory([
      makeEntry("one"),
      makeEntry("two"),
      makeEntry("three"),
    ]);

    expect(capped.bytes).toBeLessThanOrEqual(TRANSFORM_HISTORY_BYTE_LIMIT);
    expect(capped.entries.map((entry) => entry.label)).toEqual(["three"]);
  });
});

afterEach(() => {
  // The test that supplies a minimal ImageData implementation restores it
  // synchronously; this is a final guard for failed assertions.
  if (
    typeof globalThis.ImageData === "function" &&
    globalThis.ImageData.name === "TestImageData"
  ) {
    Reflect.deleteProperty(globalThis, "ImageData");
  }
});
