/// <reference lib="webworker" />

import {
  blurMaskCoverage,
  computeFloodFillMaskCooperative,
  morphMaskCoverage,
} from "@/features/transform/rasterOperations";

type WorkerRequest =
  | {
    id: number;
    operation: "flood-fill";
    rgba: ArrayBuffer;
    width: number;
    height: number;
    startX: number;
    startY: number;
    tolerance: number;
    contiguous: boolean;
  }
  | {
    id: number;
    operation: "mask-feather";
    coverage: ArrayBuffer;
    width: number;
    height: number;
    radius: number;
  }
  | {
    id: number;
    operation: "mask-morph";
    coverage: ArrayBuffer;
    width: number;
    height: number;
    radius: number;
    mode: "grow" | "shrink";
  };

type WorkerResponse = {
  id: number;
  ok: boolean;
  bytes?: ArrayBuffer;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  error?: string;
};

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.operation === "flood-fill") {
      const result = await computeFloodFillMaskCooperative({
        rgba: new Uint8ClampedArray(request.rgba),
        width: request.width,
        height: request.height,
        startX: request.startX,
        startY: request.startY,
        tolerance: request.tolerance,
        contiguous: request.contiguous,
      });
      const resultBuffer = result.mask.buffer as ArrayBuffer;
      const response: WorkerResponse = {
        id: request.id,
        ok: true,
        bytes: resultBuffer,
        bounds: result.bounds,
      };
      workerScope.postMessage(response, [resultBuffer]);
      return;
    }

    const coverage = new Uint8ClampedArray(request.coverage);
    const result =
      request.operation === "mask-feather"
        ? blurMaskCoverage(
          coverage,
          request.width,
          request.height,
          request.radius,
        )
        : morphMaskCoverage(
          coverage,
          request.width,
          request.height,
          request.radius,
          request.mode,
        );
    const resultBuffer = result.buffer as ArrayBuffer;
    const response: WorkerResponse = {
      id: request.id,
      ok: true,
      bytes: resultBuffer,
    };
    workerScope.postMessage(response, [resultBuffer]);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
});

export {};
