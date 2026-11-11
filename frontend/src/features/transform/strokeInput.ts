export type StrokeSample = {
  x: number;
  y: number;
  pressure: number;
};

export type StrokeResamplerOptions = {
  spacing: number;
  preserveTurns?: boolean;
  turnCosine?: number;
};

export type StrokeDrainOptions = {
  budgetMs?: number;
  maxDabs?: number;
};

export type StrokeDrainResult = {
  dabs: number;
  remaining: boolean;
};

const DEFAULT_MAX_PENDING_SAMPLES = 4096;
const DEFAULT_MAX_PENDING_DABS = 4096;
const DEFAULT_BUDGET_MS = 8;
const DEFAULT_MAX_DABS = 256;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function distance(from: StrokeSample, to: StrokeSample): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function pressureChanged(from: StrokeSample, to: StrokeSample): boolean {
  return Math.abs(from.pressure - to.pressure) >= 0.08;
}

function turnCosine(
  before: StrokeSample,
  current: StrokeSample,
  after: StrokeSample,
): number {
  const beforeX = current.x - before.x;
  const beforeY = current.y - before.y;
  const afterX = after.x - current.x;
  const afterY = after.y - current.y;
  const beforeLength = Math.hypot(beforeX, beforeY);
  const afterLength = Math.hypot(afterX, afterY);
  if (beforeLength < 0.001 || afterLength < 0.001) {
    return 1;
  }
  return (beforeX * afterX + beforeY * afterY) / (beforeLength * afterLength);
}

function perpendicularDeviation(
  before: StrokeSample,
  current: StrokeSample,
  after: StrokeSample,
): number {
  const lineX = after.x - before.x;
  const lineY = after.y - before.y;
  const lineLength = Math.hypot(lineX, lineY);
  if (lineLength < 0.001) {
    return distance(before, current);
  }
  return Math.abs(
    lineY * current.x - lineX * current.y + after.x * before.y - after.y * before.x,
  ) / lineLength;
}

/**
 * Reduce a raw pointer polyline only when an interior point adds no useful
 * geometry or pressure information. Endpoints and direction changes survive.
 */
export function simplifyStrokeSamples(
  samples: readonly StrokeSample[],
  maxSamples = DEFAULT_MAX_PENDING_SAMPLES,
): StrokeSample[] {
  if (samples.length <= maxSamples) {
    return [...samples];
  }
  if (maxSamples < 2) {
    return samples.length ? [samples[0]] : [];
  }

  const retained: StrokeSample[] = [samples[0]];
  for (let index = 1; index < samples.length - 1; index += 1) {
    const before = samples[index - 1];
    const current = samples[index];
    const after = samples[index + 1];
    const isTurn = turnCosine(before, current, after) < 0.92;
    const hasPressureChange = pressureChanged(before, current) || pressureChanged(current, after);
    const isLowDeviation = perpendicularDeviation(before, current, after) < 0.75;
    if (isTurn || hasPressureChange || !isLowDeviation) {
      retained.push(current);
    }
  }
  retained.push(samples[samples.length - 1]);

  if (retained.length <= maxSamples) {
    return retained;
  }
  const result: StrokeSample[] = [retained[0]];
  const interiorCapacity = maxSamples - 2;
  for (let index = 0; index < interiorCapacity; index += 1) {
    const sourceIndex = Math.round(
      1 + (index * (retained.length - 2)) / Math.max(1, interiorCapacity - 1),
    );
    result.push(retained[sourceIndex]);
  }
  result.push(retained[retained.length - 1]);
  return result;
}

export class StrokeResampler {
  private readonly spacing: number;
  private readonly preserveTurns: boolean;
  private readonly turnCosineThreshold: number;
  private prior: StrokeSample | null = null;
  private previous: StrokeSample | null = null;
  private distanceUntilNext = 0;
  private lastEmitted: StrokeSample | null = null;

  constructor(options: StrokeResamplerOptions) {
    this.spacing = Math.max(0.5, options.spacing);
    this.preserveTurns = options.preserveTurns ?? true;
    this.turnCosineThreshold = options.turnCosine ?? 0.92;
  }

  reset(): void {
    this.previous = null;
    this.prior = null;
    this.distanceUntilNext = 0;
    this.lastEmitted = null;
  }

  push(sample: StrokeSample): StrokeSample[] {
    const next = {
      x: sample.x,
      y: sample.y,
      pressure: Number.isFinite(sample.pressure) ? sample.pressure : 1,
    };
    if (!this.previous) {
      this.previous = next;
      this.lastEmitted = next;
      this.distanceUntilNext = this.spacing;
      return [next];
    }

    const from = this.previous;
    const segmentLength = distance(from, next);
    if (segmentLength < 0.001) {
      this.previous = next;
      return [];
    }

    const emitted: StrokeSample[] = [];
    let consumed = 0;
    while (segmentLength - consumed >= this.distanceUntilNext - 0.0001) {
      const travel = consumed + this.distanceUntilNext;
      const ratio = travel / segmentLength;
      const dab = {
        x: from.x + (next.x - from.x) * ratio,
        y: from.y + (next.y - from.y) * ratio,
        pressure: from.pressure + (next.pressure - from.pressure) * ratio,
      };
      emitted.push(dab);
      this.lastEmitted = dab;
      consumed = travel;
      this.distanceUntilNext = this.spacing;
    }

    this.distanceUntilNext -= segmentLength - consumed;
    if (this.preserveTurns && this.prior && this.lastEmitted) {
      const turn = turnCosine(this.prior, from, next);
      if (
        turn < this.turnCosineThreshold &&
        distance(this.lastEmitted, from) > this.spacing * 0.35
      ) {
        emitted.push({ ...from });
        this.lastEmitted = { ...from };
      }
    }
    this.prior = from;
    this.previous = next;
    return emitted;
  }

  /** Emit the final endpoint for pointer-up, but not for cancellation. */
  finish(includeEndpoint: boolean): StrokeSample[] {
    if (!includeEndpoint || !this.previous || !this.lastEmitted) {
      return [];
    }
    if (distance(this.lastEmitted, this.previous) < 0.001) {
      return [];
    }
    const endpoint = { ...this.previous };
    this.lastEmitted = endpoint;
    this.distanceUntilNext = this.spacing;
    return [endpoint];
  }
}

export class StrokeWorkQueue {
  private readonly maxPendingSamples: number;
  private readonly maxPendingDabs: number;
  private samples: StrokeSample[] = [];
  private pendingDabs: StrokeSample[] = [];

  constructor(
    maxPendingSamples = DEFAULT_MAX_PENDING_SAMPLES,
    maxPendingDabs = DEFAULT_MAX_PENDING_DABS,
  ) {
    this.maxPendingSamples = Math.max(2, Math.floor(maxPendingSamples));
    this.maxPendingDabs = Math.max(2, Math.floor(maxPendingDabs));
  }

  enqueue(samples: readonly StrokeSample[]): void {
    if (!samples.length) {
      return;
    }
    this.samples = simplifyStrokeSamples(
      [...this.samples, ...samples],
      this.maxPendingSamples,
    );
  }

  enqueueDabs(dabs: readonly StrokeSample[]): void {
    if (!dabs.length) {
      return;
    }
    this.pendingDabs.push(...dabs);
    if (this.pendingDabs.length > this.maxPendingDabs) {
      this.pendingDabs = simplifyStrokeSamples(this.pendingDabs, this.maxPendingDabs);
    }
  }

  drain(
    resampler: StrokeResampler,
    applyDab: (sample: StrokeSample) => void,
    options: StrokeDrainOptions = {},
  ): StrokeDrainResult {
    const startedAt = now();
    const budgetMs = Math.max(0.5, options.budgetMs ?? DEFAULT_BUDGET_MS);
    const maxDabs = Math.max(1, Math.floor(options.maxDabs ?? DEFAULT_MAX_DABS));
    let dabs = 0;

    while (dabs < maxDabs && now() - startedAt < budgetMs) {
      if (this.pendingDabs.length) {
        const nextDab = this.pendingDabs.shift();
        if (nextDab) {
          applyDab(nextDab);
          dabs += 1;
        }
        continue;
      }
      const nextSample = this.samples.shift();
      if (!nextSample) {
        break;
      }
      this.pendingDabs.push(...resampler.push(nextSample));
      if (this.pendingDabs.length > this.maxPendingDabs) {
        this.pendingDabs = simplifyStrokeSamples(this.pendingDabs, this.maxPendingDabs);
      }
    }

    return {
      dabs,
      remaining: this.hasPendingWork(),
    };
  }

  hasPendingWork(): boolean {
    return this.samples.length > 0 || this.pendingDabs.length > 0;
  }

  clear(): void {
    this.samples = [];
    this.pendingDabs = [];
  }
}

export const STROKE_WORK_BUDGET_MS = DEFAULT_BUDGET_MS;
export const STROKE_WORK_MAX_DABS = DEFAULT_MAX_DABS;
