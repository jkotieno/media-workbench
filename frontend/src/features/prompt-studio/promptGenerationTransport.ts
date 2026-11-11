import {
  describeGenerationJobStatus,
  isTerminalGenerationState,
} from "@/lib/generationLifecycle";
import type { GenerationState } from "@/lib/generationState";

export const PROMPT_GENERATION_WS_PREVIEW_MESSAGE_PATTERN =
  /"type"\s*:\s*"preview"/;
export const PROMPT_GENERATION_PROGRESS_THROTTLE_MS = 100;
export const PROMPT_GENERATION_PREVIEW_THROTTLE_MS = 150;
export const PROMPT_GENERATION_STALLED_SOCKET_RECONCILE_MS = 4000;
export const PROMPT_GENERATION_RECONCILE_INTERVAL_MS = 2000;

export const shouldDropPromptGenerationPreviewFrame = ({
  feedOpen,
  isTabHidden,
}: {
  feedOpen: boolean;
  isTabHidden: boolean;
}) => !feedOpen || isTabHidden;

export const shouldSkipPromptGenerationSocketPayloadParse = ({
  eventData,
  shouldDropPreviewFrame,
}: {
  eventData: unknown;
  shouldDropPreviewFrame: boolean;
}) =>
  shouldDropPreviewFrame &&
  typeof eventData === "string" &&
  PROMPT_GENERATION_WS_PREVIEW_MESSAGE_PATTERN.test(eventData);

export const isPromptGenerationCriticalSocketEvent = ({
  type,
  status,
  executingNode,
}: {
  type: string | null | undefined;
  status: string | null | undefined;
  executingNode: unknown;
}) => {
  const wsStatus = describeGenerationJobStatus(status);
  return (
    [
      "completed",
      "error",
      "execution_complete",
      "generation_done",
      "save_failed",
    ].includes(type || "") ||
    (type === "status" &&
      (wsStatus.phase === "completed" ||
        wsStatus.phase === "failed" ||
        wsStatus.phase === "cancelled")) ||
    (type === "executing" && executingNode === null)
  );
};

export const shouldSkipHiddenPromptGenerationStatusUpdate = ({
  isTabHidden,
  isCriticalEvent,
}: {
  isTabHidden: boolean;
  isCriticalEvent: boolean;
}) => isTabHidden && !isCriticalEvent;

export const shouldSkipPromptGenerationProgressUpdate = ({
  generationState,
  now,
  lastProgressUpdateAt,
  throttleMs = PROMPT_GENERATION_PROGRESS_THROTTLE_MS,
}: {
  isTabHidden: boolean;
  generationState: GenerationState;
  now: number;
  lastProgressUpdateAt: number;
  throttleMs?: number;
}) =>
  isTerminalGenerationState(generationState) ||
  now - lastProgressUpdateAt < throttleMs;

export const shouldSkipPromptGenerationPreviewUpdate = ({
  shouldDropPreviewFrame,
  now,
  lastPreviewUpdateAt,
  throttleMs = PROMPT_GENERATION_PREVIEW_THROTTLE_MS,
}: {
  shouldDropPreviewFrame: boolean;
  now: number;
  lastPreviewUpdateAt: number;
  throttleMs?: number;
}) => shouldDropPreviewFrame || now - lastPreviewUpdateAt < throttleMs;

export const shouldTriggerPromptGenerationSocketReconcile = ({
  effectDisposed,
  generationState,
  now,
  lastSocketActivityAt,
  stalledMs = PROMPT_GENERATION_STALLED_SOCKET_RECONCILE_MS,
}: {
  effectDisposed: boolean;
  generationState: GenerationState;
  now: number;
  lastSocketActivityAt: number;
  stalledMs?: number;
}) =>
  !effectDisposed &&
  !isTerminalGenerationState(generationState) &&
  now - lastSocketActivityAt >= stalledMs;

export const shouldAttemptPromptGenerationSocketApiFallback = ({
  effectDisposed,
  generationState,
}: {
  effectDisposed: boolean;
  generationState: GenerationState;
}) => !effectDisposed && !isTerminalGenerationState(generationState);
