import { describe, expect, it } from "vitest";

import {
  isPromptGenerationCriticalSocketEvent,
  shouldAttemptPromptGenerationSocketApiFallback,
  shouldDropPromptGenerationPreviewFrame,
  shouldSkipHiddenPromptGenerationStatusUpdate,
  shouldSkipPromptGenerationPreviewUpdate,
  shouldSkipPromptGenerationProgressUpdate,
  shouldSkipPromptGenerationSocketPayloadParse,
  shouldTriggerPromptGenerationSocketReconcile,
} from "./promptGenerationTransport";

describe("promptGenerationTransport", () => {
  it("drops preview frames only when the feed cannot render them", () => {
    expect(
      shouldDropPromptGenerationPreviewFrame({
        feedOpen: false,
        isTabHidden: false,
      }),
    ).toBe(true);
    expect(
      shouldDropPromptGenerationPreviewFrame({
        feedOpen: true,
        isTabHidden: true,
      }),
    ).toBe(true);
    expect(
      shouldDropPromptGenerationPreviewFrame({
        feedOpen: true,
        isTabHidden: false,
      }),
    ).toBe(false);

    expect(
      shouldSkipPromptGenerationSocketPayloadParse({
        eventData: '{"type":"preview","data":{"blob":"..."}}',
        shouldDropPreviewFrame: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipPromptGenerationSocketPayloadParse({
        eventData: '{"type":"progress","data":{"value":1}}',
        shouldDropPreviewFrame: true,
      }),
    ).toBe(false);
  });

  it("classifies critical socket events and hidden-status skips", () => {
    expect(
      isPromptGenerationCriticalSocketEvent({
        type: "completed",
        status: null,
        executingNode: undefined,
      }),
    ).toBe(true);
    expect(
      isPromptGenerationCriticalSocketEvent({
        type: "status",
        status: "processing",
        executingNode: undefined,
      }),
    ).toBe(false);
    expect(
      isPromptGenerationCriticalSocketEvent({
        type: "status",
        status: "failed",
        executingNode: undefined,
      }),
    ).toBe(true);
    expect(
      isPromptGenerationCriticalSocketEvent({
        type: "executing",
        status: null,
        executingNode: null,
      }),
    ).toBe(true);

    expect(
      shouldSkipHiddenPromptGenerationStatusUpdate({
        isTabHidden: true,
        isCriticalEvent: false,
      }),
    ).toBe(true);
    expect(
      shouldSkipHiddenPromptGenerationStatusUpdate({
        isTabHidden: true,
        isCriticalEvent: true,
      }),
    ).toBe(false);
  });

  it("throttles progress and preview updates when timing or terminal-state guards apply", () => {
    expect(
      shouldSkipPromptGenerationProgressUpdate({
        isTabHidden: false,
        generationState: "running",
        now: 120,
        lastProgressUpdateAt: 50,
      }),
    ).toBe(true);
    expect(
      shouldSkipPromptGenerationProgressUpdate({
        isTabHidden: false,
        generationState: "running",
        now: 250,
        lastProgressUpdateAt: 50,
      }),
    ).toBe(false);
    expect(
      shouldSkipPromptGenerationProgressUpdate({
        isTabHidden: true,
        generationState: "running",
        now: 250,
        lastProgressUpdateAt: 50,
      }),
    ).toBe(false);
    expect(
      shouldSkipPromptGenerationProgressUpdate({
        isTabHidden: false,
        generationState: "completed",
        now: 250,
        lastProgressUpdateAt: 50,
      }),
    ).toBe(true);

    expect(
      shouldSkipPromptGenerationPreviewUpdate({
        shouldDropPreviewFrame: false,
        now: 200,
        lastPreviewUpdateAt: 100,
      }),
    ).toBe(true);
    expect(
      shouldSkipPromptGenerationPreviewUpdate({
        shouldDropPreviewFrame: false,
        now: 260,
        lastPreviewUpdateAt: 100,
      }),
    ).toBe(false);
  });

  it("gates stalled-socket reconcile and socket close/error fallback on non-terminal active state", () => {
    expect(
      shouldTriggerPromptGenerationSocketReconcile({
        effectDisposed: false,
        generationState: "running",
        now: 5000,
        lastSocketActivityAt: 1000,
      }),
    ).toBe(true);
    expect(
      shouldTriggerPromptGenerationSocketReconcile({
        effectDisposed: false,
        generationState: "completed",
        now: 5000,
        lastSocketActivityAt: 1000,
      }),
    ).toBe(false);

    expect(
      shouldAttemptPromptGenerationSocketApiFallback({
        effectDisposed: false,
        generationState: "queued",
      }),
    ).toBe(true);
    expect(
      shouldAttemptPromptGenerationSocketApiFallback({
        effectDisposed: true,
        generationState: "queued",
      }),
    ).toBe(false);
    expect(
      shouldAttemptPromptGenerationSocketApiFallback({
        effectDisposed: false,
        generationState: "failed",
      }),
    ).toBe(false);
  });
});
