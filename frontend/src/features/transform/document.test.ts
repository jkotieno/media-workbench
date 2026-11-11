import { describe, expect, it } from "vitest";

import {
  createTransformDocument,
  createTransformTextObject,
  ensureTransformDocument,
  getTransformTextObjectLabel,
  retargetTransformTextObjectKind,
} from "@/features/transform/document";
import type { TransformDocument } from "@/shared/types";

describe("transform document defaults", () => {
  it("migrates schema 1 text documents into neutral schema 5 edit documents", () => {
    const legacy = createTransformDocument({
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
        available_folders: ["panels"],
      },
      initialMode: "text",
    }) as TransformDocument;
    legacy.schemaVersion = 1;
    legacy.lastUsedMode = "text" as never;
    delete (legacy as Partial<TransformDocument>).edit;

    const normalized = ensureTransformDocument(legacy, {
      sourceImage: legacy.sourceImage,
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "edit",
    });

    expect(normalized.schemaVersion).toBe(5);
    expect(normalized.lastUsedMode).toBe("edit");
    expect(normalized.edit.lastUsedTool).toBe("select");
    expect(normalized.edit.paintLayers).toEqual([]);
    expect(normalized.edit.imageLayers).toEqual([]);
    expect(normalized.edit.adjustments).toEqual({
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hueDegrees: 0,
    });
    expect(normalized.edit.retouchSettings).toMatchObject({
      smudge: { sampleMerged: true },
      pixelate: { blockSizePx: 16, interactionMode: "brush" },
      fill: { tolerance: 32, contiguous: true },
    });
    expect(normalized.mask).toMatchObject({
      coverageAssetPath: null,
      paintedPixels: "white",
      viewMode: "overlay",
    });
    expect(normalized.edit.crop).toMatchObject({
      enabled: false,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    });
    expect(normalized.edit.sourceImageTransform).toEqual({
      rotationDegrees: 0,
      flipHorizontal: false,
      flipVertical: false,
    });
  });

  it("migrates schema 3 raster and mask state without losing legacy draft intent", () => {
    const legacy = createTransformDocument({
      sourceImage: {
        path: "/tmp/source.webp",
        format: "webp",
        width: 1024,
        height: 768,
        hash: "source-hash",
      },
      project: {
        id: 7,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels", "masks"],
      },
      initialMode: "mask",
    }) as TransformDocument;
    legacy.schemaVersion = 3;
    delete (legacy.edit as Partial<TransformDocument["edit"]>).retouchSettings;
    delete (legacy.edit.paintSettings as Partial<TransformDocument["edit"]["paintSettings"]>).brushFlow;
    delete (legacy.edit.paintSettings as Partial<TransformDocument["edit"]["paintSettings"]>).eyedropperSampleMerged;
    legacy.mask = {
      hasDraft: true,
      draftPath: "/tmp/source.transform.assets/mask/draft.png",
      invertOutput: true,
      overlayColor: "#ff00aa",
      overlayOpacity: 0.4,
      viewMode: "mask",
    } as unknown as TransformDocument["mask"];

    const normalized = ensureTransformDocument(legacy, {
      sourceImage: legacy.sourceImage,
      project: legacy.project,
      initialMode: "mask",
    });

    expect(normalized.schemaVersion).toBe(5);
    expect(normalized.edit.paintSettings).toMatchObject({
      brushFlow: 1,
      eyedropperSampleMerged: true,
    });
    expect(normalized.edit.retouchSettings.pixelate).toMatchObject({
      blockSizePx: 16,
      sampleMerged: true,
      interactionMode: "brush",
    });
    expect(normalized.mask).toMatchObject({
      hasDraft: true,
      coverageAssetPath: "/tmp/source.transform.assets/mask/draft.png",
      draftPath: "/tmp/source.transform.assets/mask/draft.png",
      paintedPixels: "black",
      overlayColor: "#ff00aa",
      overlayOpacity: 0.4,
      viewMode: "mask",
    });
  });

  it("normalizes persisted source image transform state", () => {
    const legacy = createTransformDocument({
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
        available_folders: ["panels"],
      },
      initialMode: "edit",
    }) as TransformDocument;

    legacy.edit.sourceImageTransform = {
      rotationDegrees: 540.25,
      flipHorizontal: true,
      flipVertical: 0 as never,
    };

    const normalized = ensureTransformDocument(legacy, {
      sourceImage: legacy.sourceImage,
      project: legacy.project,
      initialMode: "edit",
    });

    expect(normalized.edit.sourceImageTransform).toEqual({
      rotationDegrees: -179.75,
      flipHorizontal: true,
      flipVertical: false,
    });
  });

  it("backfills rotation and tail-base state for older documents", () => {
    const legacy = createTransformDocument({
      sourceImage: {
        path: "/tmp/source.png",
        format: "png",
        width: 1024,
        height: 1024,
        hash: null,
      },
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "text",
    }) as TransformDocument;

    legacy.text.objects.push({
      id: "bubble-1",
      kind: "speech_bubble",
      x: 120,
      y: 180,
      width: 240,
      height: 140,
      text: "Hello",
      fontFamily: "Trebuchet MS",
      fontSize: 28,
      lineHeight: 1.2,
      letterSpacing: 0,
      textColor: "#000000",
      fillColor: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 3,
      padding: 18,
      textAlign: "center",
      textOffsetX: 0,
      textOffsetY: 0,
      tailX: 320,
      tailY: 360,
    } as TransformDocument["text"]["objects"][number]);

    const normalized = ensureTransformDocument(legacy, {
      sourceImage: legacy.sourceImage,
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "text",
    });

    expect(normalized.text.objects[0]?.rotation).toBe(0);
    expect(typeof normalized.text.objects[0]?.tailBaseAngle).toBe("number");
    expect(normalized.text.objects[0]?.tailWidth).toBeGreaterThan(0);
  });

  it("creates defaults for the added lettering shapes", () => {
    const sharpNarration = createTransformTextObject("narration_rect", 10, 20);
    const jaggedBurst = createTransformTextObject("burst_jagged", 10, 20);
    const wavyBurst = createTransformTextObject("burst_wavy", 10, 20);

    expect(sharpNarration).toMatchObject({
      kind: "narration_rect",
      text: "Narration",
      fillColor: "#fff7d6",
      tailWidth: 0,
      tailX: null,
      tailY: null,
    });
    expect(jaggedBurst).toMatchObject({
      kind: "burst_jagged",
      text: "Bang!",
      fillColor: "#ffffff",
      tailWidth: 0,
    });
    expect(wavyBurst).toMatchObject({
      kind: "burst_wavy",
      text: "Whoa!",
      fillColor: "#ffffff",
      tailWidth: 0,
    });
    expect(getTransformTextObjectLabel("narration_rect")).toBe("narration sharp");
  });

  it("retargets lettering shape while preserving style and adding thought-dot handles", () => {
    const object = createTransformTextObject("narration_rect", 10, 20);
    object.text = "Keep me";
    object.fillColor = "#123456";
    object.strokeColor = "#654321";

    retargetTransformTextObjectKind(object, "thought_bubble");

    expect(object).toMatchObject({
      kind: "thought_bubble",
      text: "Keep me",
      fillColor: "#123456",
      strokeColor: "#654321",
      tailWidth: 0,
    });
    expect(typeof object.tailBaseAngle).toBe("number");
    expect(typeof object.tailX).toBe("number");
    expect(typeof object.tailY).toBe("number");
  });

  it("normalizes invalid numeric object fields to renderable defaults", () => {
    const document = createTransformDocument({
      sourceImage: {
        path: "/tmp/source.png",
        format: "png",
        width: 512,
        height: 512,
        hash: null,
      },
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "text",
    }) as TransformDocument;

    document.text.objects.push({
      id: "bubble-1",
      kind: "speech_bubble",
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: Number.NEGATIVE_INFINITY,
      height: Number.NaN,
      rotation: Number.POSITIVE_INFINITY,
      text: "Hello",
      fontFamily: "Trebuchet MS",
      fontSize: Number.NaN,
      lineHeight: Number.POSITIVE_INFINITY,
      letterSpacing: Number.NEGATIVE_INFINITY,
      textColor: "#000000",
      fillColor: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: Number.NaN,
      padding: Number.POSITIVE_INFINITY,
      textAlign: "center",
      textOffsetX: Number.NaN,
      textOffsetY: Number.NEGATIVE_INFINITY,
      tailBaseAngle: Number.NaN,
      tailWidth: Number.NaN,
      tailX: Number.POSITIVE_INFINITY,
      tailY: Number.NaN,
    });

    const normalized = ensureTransformDocument(document, {
      sourceImage: document.sourceImage,
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "text",
    });
    const object = normalized.text.objects[0];

    expect(object).toMatchObject({
      x: 0,
      y: 0,
      width: 260,
      height: 150,
      rotation: 0,
      fontSize: 28,
      lineHeight: 1.2,
      letterSpacing: 0,
      strokeWidth: 3,
      padding: 18,
      textOffsetX: 0,
      textOffsetY: 0,
      tailWidth: 32,
      tailX: null,
      tailY: null,
    });
    expect(typeof object?.tailBaseAngle).toBe("number");
  });

  it("preserves off-frame text geometry and paint asset paths in schema 2 documents", () => {
    const document = createTransformDocument({
      sourceImage: {
        path: "/tmp/source.png",
        format: "png",
        width: 512,
        height: 512,
        hash: null,
      },
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "edit",
    }) as TransformDocument;

    document.edit.textObjects.push({
      id: "bubble-1",
      kind: "speech_bubble",
      x: -220,
      y: 640,
      width: 900,
      height: 820,
      rotation: 0,
      text: "Off frame",
      fontFamily: "Trebuchet MS",
      fontSize: 28,
      lineHeight: 1.2,
      letterSpacing: 0,
      textColor: "#000000",
      fillColor: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 3,
      padding: 18,
      textAlign: "center",
      textOffsetX: 0,
      textOffsetY: 0,
      tailBaseAngle: 0.8,
      tailWidth: 32,
      tailX: -40,
      tailY: 760,
    });
    document.edit.paintLayers.push({
      id: "paint-1",
      width: 512,
      height: 512,
      assetPath: "/tmp/source.transform.assets/paint/paint-1.png",
      dataUrl: null,
      createdAt: "2026-05-04T00:00:00Z",
      updatedAt: "2026-05-04T00:00:00Z",
    });
    document.edit.layers.push(
      {
        id: "layer-text",
        kind: "text_object",
        refId: "bubble-1",
        objectId: "bubble-1",
        name: "off-frame text",
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: "normal",
      },
      {
        id: "layer-paint",
        kind: "paint_layer",
        refId: "paint-1",
        name: "paint",
        visible: true,
        locked: false,
        opacity: 0.5,
        blendMode: "normal",
      },
    );

    const normalized = ensureTransformDocument(document, {
      sourceImage: document.sourceImage,
      project: {
        id: 1,
        slug: "demo",
        folder: "panels",
        available_folders: ["panels"],
      },
      initialMode: "edit",
    });

    expect(normalized.edit.textObjects[0]).toMatchObject({
      x: -220,
      y: 640,
      width: 900,
      height: 820,
    });
    expect(normalized.edit.paintLayers[0]?.assetPath).toBe("/tmp/source.transform.assets/paint/paint-1.png");
    expect(normalized.edit.layers[1]).toMatchObject({
      kind: "paint_layer",
      opacity: 0.5,
    });
  });
});
