import { describe, expect, it } from "vitest";

import {
  createRasterPixelSampler,
  createSmudgeState,
  drawSmudgeDab,
  getPixelateFeatherBlend,
} from "@/features/transform/rasterEngine";

class FakeContext {
  canvas: FakeCanvas;
  readonly getImageData: (x: number, y: number, width: number, height: number) => ImageData;
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = "source-over";

  constructor(canvas: FakeCanvas, getImageData: FakeContext["getImageData"] = () => ({
    data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
    width: canvas.width,
    height: canvas.height,
  } as ImageData)) {
    this.canvas = canvas;
    this.getImageData = getImageData;
  }

  clearRect(): void {}
  drawImage(): void {}
  setTransform(): void {}
  createImageData(width: number, height: number): ImageData {
    return {
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    } as ImageData;
  }
  putImageData(): void {}
}

class FakeCanvas {
  width: number;
  height: number;
  context: FakeContext;

  constructor(width: number, height: number, getImageData?: FakeContext["getImageData"]) {
    this.width = width;
    this.height = height;
    this.context = new FakeContext(this, getImageData);
  }

  getContext(): FakeContext {
    return this.context;
  }
}

describe("Transform raster sampling", () => {
  it("reads each touched tile once, averages RGBA independently, and preserves a snapshot", () => {
    const reads: Array<[number, number, number, number]> = [];
    const canvas = new FakeCanvas(512, 2, (x, y, width, height) => {
      reads.push([x, y, width, height]);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let localX = 0; localX < width; localX += 1) {
        const sourceX = x + localX;
        const offset = localX * 4;
        data[offset] = sourceX;
        data[offset + 1] = 20;
        data[offset + 2] = 40;
        data[offset + 3] = sourceX === 256 ? 0 : 255;
      }
      return { data, width, height } as ImageData;
    });
    const sampler = createRasterPixelSampler(
      canvas.context as unknown as CanvasRenderingContext2D,
      256,
    );

    expect(sampler.sampleBlock(250, 0, 12, 1)).toEqual([254, 20, 40, 234]);
    expect(sampler.sampleBlock(250, 0, 12, 1)).toEqual([254, 20, 40, 234]);
    expect(reads).toEqual([
      [0, 0, 256, 2],
      [256, 0, 256, 2],
    ]);
  });

  it("clips blocks at source edges", () => {
    const canvas = new FakeCanvas(2, 2, (x, y, width, height) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < width * height; index += 1) {
        data[index * 4] = x + index % width;
        data[index * 4 + 1] = y + Math.floor(index / width);
        data[index * 4 + 2] = 30;
        data[index * 4 + 3] = 255;
      }
      return { data, width, height } as ImageData;
    });
    const sampler = createRasterPixelSampler(
      canvas.context as unknown as CanvasRenderingContext2D,
      256,
    );

    expect(sampler.sampleBlock(-1, -1, 2, 2)).toEqual([0, 0, 30, 255]);
  });

  it("uses hard edges at feather zero and a monotonic original-to-pixelated blend band", () => {
    expect(getPixelateFeatherBlend(0, 0)).toBe(1);
    expect(getPixelateFeatherBlend(0, 8)).toBe(0);
    expect(getPixelateFeatherBlend(4, 8)).toBeGreaterThan(0);
    expect(getPixelateFeatherBlend(8, 8)).toBe(1);
  });

  it("reuses Smudge scratch canvases across dabs", () => {
    const originalDocument = globalThis.document;
    let created = 0;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => {
          created += 1;
          return new FakeCanvas(8, 8);
        },
      },
    });
    try {
      const sourceCanvas = new FakeCanvas(8, 8);
      const targetCanvas = new FakeCanvas(8, 8);
      const state = createSmudgeState(
        sourceCanvas.context as unknown as CanvasRenderingContext2D,
        { x: 4, y: 4, pressure: 1 },
        8,
        0.7,
      );
      const allocationsAfterStart = created;
      drawSmudgeDab(
        targetCanvas.context as unknown as CanvasRenderingContext2D,
        sourceCanvas.context as unknown as CanvasRenderingContext2D,
        state,
        { x: 4, y: 4, pressure: 1 },
        { sizePx: 8, hardness: 0.7, strength: 0.5 },
      );
      drawSmudgeDab(
        targetCanvas.context as unknown as CanvasRenderingContext2D,
        sourceCanvas.context as unknown as CanvasRenderingContext2D,
        state,
        { x: 5, y: 4, pressure: 1 },
        { sizePx: 8, hardness: 0.7, strength: 0.5 },
      );
      expect(allocationsAfterStart).toBe(3);
      expect(created).toBe(allocationsAfterStart);
    } finally {
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", {
          configurable: true,
          value: originalDocument,
        });
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });
});
