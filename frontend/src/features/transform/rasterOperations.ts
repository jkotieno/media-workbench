export type FloodFillRequest = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  startX: number;
  startY: number;
  tolerance: number;
  contiguous: boolean;
};

export type FloodFillResult = {
  mask: Uint8Array;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

function colorDistance(
  rgba: Uint8ClampedArray,
  offset: number,
  seed: readonly number[],
): number {
  const red = rgba[offset] - seed[0];
  const green = rgba[offset + 1] - seed[1];
  const blue = rgba[offset + 2] - seed[2];
  const alpha = rgba[offset + 3] - seed[3];
  return Math.sqrt(
    (red * red + green * green + blue * blue) / 3 + alpha * alpha * 0.25,
  );
}

function* computeFloodFillMaskSteps(
  request: FloodFillRequest,
  chunkPixelCount = 128 * 1024,
): Generator<void, FloodFillResult> {
  const { rgba, width, height, contiguous } = request;
  const startX = Math.max(0, Math.min(width - 1, Math.floor(request.startX)));
  const startY = Math.max(0, Math.min(height - 1, Math.floor(request.startY)));
  const tolerance = Math.max(0, Math.min(255, request.tolerance));
  const startOffset = (startY * width + startX) * 4;
  const seed = [
    rgba[startOffset],
    rgba[startOffset + 1],
    rgba[startOffset + 2],
    rgba[startOffset + 3],
  ] as const;
  const mask = new Uint8Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  const include = (pixelIndex: number) => {
    mask[pixelIndex] = 255;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  if (!contiguous) {
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
      if (colorDistance(rgba, pixelIndex * 4, seed) <= tolerance) {
        include(pixelIndex);
      }
      if (pixelIndex > 0 && pixelIndex % chunkPixelCount === 0) {
        yield;
      }
    }
  } else {
    const visited = new Uint8Array(width * height);
    const stack = new Uint32Array(width * height);
    let stackSize = 0;
    const startIndex = startY * width + startX;
    stack[stackSize] = startIndex;
    stackSize += 1;
    visited[startIndex] = 1;
    let processedPixels = 0;
    while (stackSize > 0) {
      stackSize -= 1;
      const pixelIndex = stack[stackSize];
      processedPixels += 1;
      if (processedPixels % chunkPixelCount === 0) {
        yield;
      }
      if (colorDistance(rgba, pixelIndex * 4, seed) > tolerance) {
        continue;
      }
      include(pixelIndex);
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      if (x > 0) {
        const next = pixelIndex - 1;
        if (!visited[next]) {
          visited[next] = 1;
          stack[stackSize] = next;
          stackSize += 1;
        }
      }
      if (x + 1 < width) {
        const next = pixelIndex + 1;
        if (!visited[next]) {
          visited[next] = 1;
          stack[stackSize] = next;
          stackSize += 1;
        }
      }
      if (y > 0) {
        const next = pixelIndex - width;
        if (!visited[next]) {
          visited[next] = 1;
          stack[stackSize] = next;
          stackSize += 1;
        }
      }
      if (y + 1 < height) {
        const next = pixelIndex + width;
        if (!visited[next]) {
          visited[next] = 1;
          stack[stackSize] = next;
          stackSize += 1;
        }
      }
    }
  }

  return {
    mask,
    bounds:
      maxX >= minX && maxY >= minY
        ? {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        }
        : null,
  };
}

export function computeFloodFillMask(request: FloodFillRequest): FloodFillResult {
  const steps = computeFloodFillMaskSteps(request);
  let next = steps.next();
  while (!next.done) {
    next = steps.next();
  }
  return next.value;
}

export async function computeFloodFillMaskCooperative(
  request: FloodFillRequest,
  yieldControl: () => Promise<void> = () =>
    new Promise((resolve) => globalThis.setTimeout(resolve, 0)),
): Promise<FloodFillResult> {
  const steps = computeFloodFillMaskSteps(request);
  let next = steps.next();
  while (!next.done) {
    await yieldControl();
    next = steps.next();
  }
  return next.value;
}

function boxBlurHorizontal(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    let count = 0;
    for (let x = -radius; x <= radius; x += 1) {
      if (x >= 0 && x < width) {
        sum += source[y * width + x];
        count += 1;
      }
    }
    for (let x = 0; x < width; x += 1) {
      result[y * width + x] = Math.round(sum / Math.max(1, count));
      const removeX = x - radius;
      const addX = x + radius + 1;
      if (removeX >= 0 && removeX < width) {
        sum -= source[y * width + removeX];
        count -= 1;
      }
      if (addX >= 0 && addX < width) {
        sum += source[y * width + addX];
        count += 1;
      }
    }
  }
  return result;
}

function boxBlurVertical(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(source.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y <= radius; y += 1) {
      if (y >= 0 && y < height) {
        sum += source[y * width + x];
        count += 1;
      }
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = Math.round(sum / Math.max(1, count));
      const removeY = y - radius;
      const addY = y + radius + 1;
      if (removeY >= 0 && removeY < height) {
        sum -= source[removeY * width + x];
        count -= 1;
      }
      if (addY >= 0 && addY < height) {
        sum += source[addY * width + x];
        count += 1;
      }
    }
  }
  return result;
}

export function blurMaskCoverage(
  coverage: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const normalizedRadius = Math.max(0, Math.min(256, Math.round(radius)));
  if (normalizedRadius === 0) {
    return new Uint8ClampedArray(coverage);
  }
  // Three box passes closely approximate a Gaussian while keeping a 4K mask
  // linear in pixel count.
  let result: Uint8ClampedArray<ArrayBufferLike> =
    new Uint8ClampedArray(coverage);
  const boxRadius = Math.max(1, Math.round(normalizedRadius / 1.8));
  for (let pass = 0; pass < 3; pass += 1) {
    result = boxBlurVertical(
      boxBlurHorizontal(result, width, height, boxRadius),
      width,
      height,
      boxRadius,
    );
  }
  return result;
}

function slidingExtreme(
  source: Uint8ClampedArray,
  length: number,
  radius: number,
  takeMax: boolean,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(length);
  const deque = new Int32Array(length);
  let head = 0;
  let tail = 0;
  const better = (left: number, right: number) =>
    takeMax ? source[left] >= source[right] : source[left] <= source[right];
  for (let index = 0; index < length + radius; index += 1) {
    const addIndex = index;
    if (addIndex < length) {
      while (tail > head && better(addIndex, deque[tail - 1])) {
        tail -= 1;
      }
      deque[tail] = addIndex;
      tail += 1;
    }
    const outputIndex = index - radius;
    if (outputIndex >= 0 && outputIndex < length) {
      const minAllowed = outputIndex - radius;
      while (tail > head && deque[head] < minAllowed) {
        head += 1;
      }
      result[outputIndex] = tail > head
        ? source[deque[head]]
        : takeMax
          ? 0
          : 255;
    }
  }
  return result;
}

export function morphMaskCoverage(
  coverage: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  mode: "grow" | "shrink",
): Uint8ClampedArray {
  const normalizedRadius = Math.max(0, Math.min(256, Math.round(radius)));
  if (normalizedRadius === 0) {
    return new Uint8ClampedArray(coverage);
  }
  const takeMax = mode === "grow";
  const horizontal = new Uint8ClampedArray(coverage.length);
  for (let y = 0; y < height; y += 1) {
    const row = coverage.slice(y * width, (y + 1) * width);
    horizontal.set(slidingExtreme(row, width, normalizedRadius, takeMax), y * width);
  }
  const result = new Uint8ClampedArray(coverage.length);
  const column = new Uint8ClampedArray(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      column[y] = horizontal[y * width + x];
    }
    const morphed = slidingExtreme(column, height, normalizedRadius, takeMax);
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = morphed[y];
    }
  }
  return result;
}
