import {
  blurMaskCoverage,
  computeFloodFillMask,
  morphMaskCoverage,
  type FloodFillResult,
} from "@/features/transform/rasterOperations";

type PendingWorkerRequest = {
  resolve: (value: {
    bytes: ArrayBuffer;
    bounds?: FloodFillResult["bounds"];
  }) => void;
  reject: (reason: unknown) => void;
};

let worker: Worker | null | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingWorkerRequest>();

function getWorker(): Worker | null {
  if (worker !== undefined) {
    return worker;
  }
  if (typeof Worker === "undefined") {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(
      new URL("./transformRaster.worker.ts", import.meta.url),
      { type: "module", name: "transform-raster" },
    );
    worker.addEventListener("message", (event: MessageEvent<{
      id: number;
      ok: boolean;
      bytes?: ArrayBuffer;
      bounds?: FloodFillResult["bounds"];
      error?: string;
    }>) => {
      const request = pending.get(event.data.id);
      if (!request) {
        return;
      }
      pending.delete(event.data.id);
      if (!event.data.ok || !event.data.bytes) {
        request.reject(new Error(event.data.error || "Raster worker failed"));
        return;
      }
      request.resolve({
        bytes: event.data.bytes,
        bounds: event.data.bounds,
      });
    });
    worker.addEventListener("error", (event) => {
      for (const request of pending.values()) {
        request.reject(event.error || new Error(event.message));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    });
  } catch {
    worker = null;
  }
  return worker;
}

async function runWorker(
  payload: Record<string, unknown>,
  transfers: Transferable[],
): Promise<{ bytes: ArrayBuffer; bounds?: FloodFillResult["bounds"] } | null> {
  const activeWorker = getWorker();
  if (!activeWorker) {
    return null;
  }
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ ...payload, id }, transfers);
  });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export async function runFloodFill(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
  contiguous: boolean,
  options: { transferInput?: boolean } = {},
): Promise<FloodFillResult> {
  const canTransferInput =
    options.transferInput === true &&
    rgba.byteOffset === 0 &&
    rgba.byteLength === rgba.buffer.byteLength &&
    rgba.buffer instanceof ArrayBuffer;
  // ImageData created solely for a fill can be transferred directly. Avoiding
  // a synchronous 4K RGBA clone here is what keeps pointer input responsive
  // while the worker scans the source.
  const workerBytes = canTransferInput
    ? rgba.buffer
    : rgba.slice().buffer;
  const response = await runWorker(
    {
      operation: "flood-fill",
      rgba: workerBytes,
      width,
      height,
      startX,
      startY,
      tolerance,
      contiguous,
    },
    [workerBytes],
  );
  if (response) {
    return {
      mask: new Uint8Array(response.bytes),
      bounds: response.bounds ?? null,
    };
  }
  await yieldToBrowser();
  return computeFloodFillMask({
    rgba,
    width,
    height,
    startX,
    startY,
    tolerance,
    contiguous,
  });
}

export async function runMaskFeather(
  coverage: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Promise<Uint8ClampedArray> {
  const workerBytes = coverage.slice().buffer;
  const response = await runWorker(
    {
      operation: "mask-feather",
      coverage: workerBytes,
      width,
      height,
      radius,
    },
    [workerBytes],
  );
  if (response) {
    return new Uint8ClampedArray(response.bytes);
  }
  await yieldToBrowser();
  return blurMaskCoverage(coverage, width, height, radius);
}

export async function runMaskMorph(
  coverage: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  mode: "grow" | "shrink",
): Promise<Uint8ClampedArray> {
  const workerBytes = coverage.slice().buffer;
  const response = await runWorker(
    {
      operation: "mask-morph",
      coverage: workerBytes,
      width,
      height,
      radius,
      mode,
    },
    [workerBytes],
  );
  if (response) {
    return new Uint8ClampedArray(response.bytes);
  }
  await yieldToBrowser();
  return morphMaskCoverage(coverage, width, height, radius, mode);
}
