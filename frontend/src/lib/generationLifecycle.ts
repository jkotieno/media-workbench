import type { GenerationFeedItem } from "@/components/GenerationFeed";
import {
  mapStatusToGenerationState,
  type GenerationState,
} from "@/lib/generationState";

export const ACTIVE_GENERATION_JOB_STATUSES = [
  "queued",
  "processing",
  "running",
  "saving",
  "initiating",
  "submitted_to_comfy",
  "sampling",
] as const;

export const TERMINAL_GENERATION_JOB_STATUSES = [
  "completed",
  "completed_with_save_errors",
  "failed",
  "cancelled",
] as const;

export const TERMINAL_GENERATION_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type GenerationJobStatusPhase =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type GenerationJobStatusDescriptor = {
  normalizedStatus: string | null;
  phase: GenerationJobStatusPhase;
  uiState: GenerationState;
  statusLabel: string;
  isActive: boolean;
  isTerminal: boolean;
};

const GENERATION_JOB_STATUS_ALIASES: Record<string, string> = {
  canceled: "cancelled",
  error: "failed",
  executing: "running",
  submitted_to_comfy: "processing",
  success: "completed",
};

const ACTIVE_GENERATION_JOB_STATUS_SET = new Set<string>(ACTIVE_GENERATION_JOB_STATUSES);
const TERMINAL_GENERATION_JOB_STATUS_SET = new Set<string>(TERMINAL_GENERATION_JOB_STATUSES);
const TERMINAL_GENERATION_STATE_SET = new Set<string>(TERMINAL_GENERATION_STATES);

export const normalizeGenerationJobStatus = (
  status: string | null | undefined
): string | null => {
  if (typeof status !== "string") return null;
  const normalized = status.trim().toLowerCase();
  if (!normalized) return null;
  return GENERATION_JOB_STATUS_ALIASES[normalized] ?? normalized;
};

export const isActiveGenerationJobStatus = (
  status: string | null | undefined
): boolean => {
  const normalizedStatus = normalizeGenerationJobStatus(status);
  return Boolean(normalizedStatus && ACTIVE_GENERATION_JOB_STATUS_SET.has(normalizedStatus));
};

export const isTerminalGenerationJobStatus = (
  status: string | null | undefined
): boolean => {
  const normalizedStatus = normalizeGenerationJobStatus(status);
  return Boolean(normalizedStatus && TERMINAL_GENERATION_JOB_STATUS_SET.has(normalizedStatus));
};

export const isTerminalGenerationState = (
  state: GenerationState | null | undefined
): boolean => Boolean(state && TERMINAL_GENERATION_STATE_SET.has(state));

export const getGenerationStatusLabel = (
  status: string | null | undefined
): string => {
  const normalizedStatus = normalizeGenerationJobStatus(status);
  if (!normalizedStatus || normalizedStatus === "completed") return "";
  if (normalizedStatus === "completed_with_save_errors") return "save errors";
  if (normalizedStatus === "running" || normalizedStatus === "processing") {
    return "processing";
  }
  return normalizedStatus;
};

export const getGenerationStateFromJobStatus = (
  status: string | null | undefined
): GenerationState => {
  const normalizedStatus = normalizeGenerationJobStatus(status);
  return mapStatusToGenerationState(normalizedStatus || undefined);
};

export const describeGenerationJobStatus = (
  status: string | null | undefined
): GenerationJobStatusDescriptor => {
  const normalizedStatus = normalizeGenerationJobStatus(status);

  if (normalizedStatus === "completed" || normalizedStatus === "completed_with_save_errors") {
    return {
      normalizedStatus,
      phase: "completed",
      uiState: "completed",
      statusLabel: normalizedStatus === "completed_with_save_errors" ? "save errors" : "",
      isActive: false,
      isTerminal: true,
    };
  }

  if (normalizedStatus === "failed") {
    return {
      normalizedStatus,
      phase: "failed",
      uiState: "failed",
      statusLabel: "failed",
      isActive: false,
      isTerminal: true,
    };
  }

  if (normalizedStatus === "cancelled") {
    return {
      normalizedStatus,
      phase: "cancelled",
      uiState: "cancelled",
      statusLabel: "cancelled",
      isActive: false,
      isTerminal: true,
    };
  }

  if (normalizedStatus === "queued" || normalizedStatus === "initiating") {
    return {
      normalizedStatus,
      phase: "queued",
      uiState: "queued",
      statusLabel: normalizedStatus,
      isActive: true,
      isTerminal: false,
    };
  }

  if (
    normalizedStatus === "processing" ||
    normalizedStatus === "running" ||
    normalizedStatus === "saving" ||
    normalizedStatus === "sampling"
  ) {
    return {
      normalizedStatus,
      phase: "running",
      uiState: "running",
      statusLabel: normalizedStatus === "sampling"
          ? "sampling"
          : normalizedStatus === "saving"
            ? "saving"
            : "processing",
      isActive: true,
      isTerminal: false,
    };
  }

  return {
    normalizedStatus,
    phase: "unknown",
    uiState: "idle",
    statusLabel: normalizedStatus || "",
    isActive: false,
    isTerminal: false,
  };
};

export const shouldIgnoreGenerationStatusWhileTerminal = (
  currentState: GenerationState | null | undefined,
  incomingStatus: string | null | undefined
): boolean => {
  if (!isTerminalGenerationState(currentState)) return false;
  const descriptor = describeGenerationJobStatus(incomingStatus);
  return descriptor.phase === "queued" || descriptor.phase === "running";
};

export const findActiveGenerationFeedItem = <T extends Pick<GenerationFeedItem, "status">>(
  feed: T[] | null | undefined
): T | null => {
  if (!Array.isArray(feed)) return null;
  return feed.find((item) => isActiveGenerationJobStatus(item.status)) ?? null;
};
