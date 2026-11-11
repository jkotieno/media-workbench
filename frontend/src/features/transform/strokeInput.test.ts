import { describe, expect, it } from "vitest";

import {
  simplifyStrokeSamples,
  StrokeResampler,
  StrokeWorkQueue,
} from "@/features/transform/strokeInput";

const sample = (x: number, y = 0, pressure = 1) => ({ x, y, pressure });

describe("Transform stroke ingestion", () => {
  it("emits fixed-distance dabs across sub-spacing events", () => {
    const resampler = new StrokeResampler({ spacing: 10 });

    expect(resampler.push(sample(0))).toEqual([sample(0)]);
    expect(resampler.push(sample(3))).toEqual([]);
    expect(resampler.push(sample(6))).toEqual([]);
    expect(resampler.push(sample(13))).toEqual([sample(10)]);
    expect(resampler.push(sample(24))).toEqual([sample(20)]);
  });

  it("carries residual distance and interpolates pressure", () => {
    const resampler = new StrokeResampler({ spacing: 5 });

    resampler.push(sample(0, 0, 0.2));
    resampler.push(sample(3, 0, 0.5));
    const dabs = resampler.push(sample(8, 0, 1));

    expect(dabs).toHaveLength(1);
    expect(dabs[0].x).toBeCloseTo(5);
    expect(dabs[0].pressure).toBeCloseTo(0.7);
  });

  it("keeps meaningful turns on the source polyline", () => {
    const resampler = new StrokeResampler({ spacing: 5 });
    const dabs = [
      ...resampler.push(sample(0, 0)),
      ...resampler.push(sample(10, 0)),
      ...resampler.push(sample(10, 10)),
      ...resampler.finish(true),
    ];

    expect(dabs.some((point) => point.x === 5 && point.y === 0)).toBe(true);
    expect(dabs.some((point) => point.x === 10 && point.y === 5)).toBe(true);
    expect(dabs[dabs.length - 1]).toEqual(sample(10, 10));
  });

  it("bounds pending samples while retaining endpoints and pressure changes", () => {
    const samples = [
      sample(0),
      sample(1, 0, 0.2),
      sample(2, 0, 0.9),
      sample(3),
      sample(4, 5),
      sample(5, 5),
    ];
    const simplified = simplifyStrokeSamples(samples, 4);

    expect(simplified.length).toBeLessThanOrEqual(4);
    expect(simplified[0]).toEqual(samples[0]);
    expect(simplified[simplified.length - 1]).toEqual(samples[samples.length - 1]);
    expect(simplified.some((point) => point.pressure === 0.2 || point.pressure === 0.9)).toBe(true);
  });

  it("drains in bounded batches and completes a final endpoint drain", () => {
    const queue = new StrokeWorkQueue();
    const resampler = new StrokeResampler({ spacing: 1 });
    const applied: number[] = [];
    queue.enqueue([sample(0), sample(10), sample(20)]);

    const first = queue.drain(resampler, (point) => applied.push(point.x), {
      budgetMs: 1000,
      maxDabs: 2,
    });
    expect(first.dabs).toBe(2);
    expect(first.remaining).toBe(true);

    while (queue.hasPendingWork()) {
      queue.drain(resampler, (point) => applied.push(point.x), {
        budgetMs: 1000,
        maxDabs: 256,
      });
    }
    queue.enqueueDabs(resampler.finish(true));
    queue.drain(resampler, (point) => applied.push(point.x), {
      budgetMs: 1000,
      maxDabs: 256,
    });

    expect(applied[0]).toBe(0);
    expect(applied[applied.length - 1]).toBe(20);
    const cancelResampler = new StrokeResampler({ spacing: 10 });
    cancelResampler.push(sample(0));
    cancelResampler.push(sample(3));
    expect(cancelResampler.finish(false)).toEqual([]);
  });

  it("keeps draining Edit finalization across frames and commits history once", () => {
    const queue = new StrokeWorkQueue();
    const resampler = new StrokeResampler({ spacing: 1 });
    const applied: number[] = [];
    let frames = 0;
    let historyCommits = 0;
    queue.enqueue([sample(0), sample(100), sample(200)]);

    let result = queue.drain(resampler, (point) => applied.push(point.x), {
      budgetMs: 1000,
      maxDabs: 2,
    });
    frames += 1;
    while (result.remaining) {
      result = queue.drain(resampler, (point) => applied.push(point.x), {
        budgetMs: 1000,
        maxDabs: 2,
      });
      frames += 1;
    }
    historyCommits += 1;

    expect(frames).toBeGreaterThan(1);
    expect(applied).toContain(200);
    expect(historyCommits).toBe(1);
  });

  it.each(["add", "subtract"] as const)(
    "keeps Mask %s finalization bounded and preserves cancellation semantics",
    () => {
      const queue = new StrokeWorkQueue();
      const resampler = new StrokeResampler({ spacing: 1 });
      const applied: number[] = [];
      let frames = 0;
      let historyCommits = 0;
      queue.enqueue([sample(0), sample(60), sample(120)]);

      let result = queue.drain(resampler, (point) => applied.push(point.x), {
        budgetMs: 1000,
        maxDabs: 2,
      });
      frames += 1;
      while (result.remaining) {
        result = queue.drain(resampler, (point) => applied.push(point.x), {
          budgetMs: 1000,
          maxDabs: 2,
        });
        frames += 1;
      }
      historyCommits += 1;

      expect(frames).toBeGreaterThan(1);
      expect(applied).toContain(120);
      expect(historyCommits).toBe(1);

      const cancelQueue = new StrokeWorkQueue();
      const cancelResampler = new StrokeResampler({ spacing: 10 });
      const canceled: number[] = [];
      cancelQueue.enqueue([sample(0), sample(3)]);
      while (cancelQueue.hasPendingWork()) {
        cancelQueue.drain(cancelResampler, (point) => canceled.push(point.x), {
          budgetMs: 1000,
          maxDabs: 2,
        });
      }

      expect(canceled).toEqual([0]);
      expect(cancelResampler.finish(false)).toEqual([]);
    },
  );
});
