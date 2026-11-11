import React from "react";

export type MediaTransferAction = "regenerate" | "use-in-pipe" | "transform";
export type MediaTransferSurface =
  | "image-viewer-context-menu"
  | "image-viewer-details"
  | "main-gallery"
  | "project-gallery"
  | "prompt-studio"
  | "ancestry";

export type MediaTransferCommand = {
  action: MediaTransferAction;
  commandKey: string;
  failureMessage: string;
  pendingMessage: string;
  sourcePath: string;
  surface: MediaTransferSurface;
};

export type MediaTransferState =
  | { phase: "idle" }
  | {
      action: MediaTransferAction;
      commandKey: string;
      correlationId: string;
      message: string;
      phase: "pending";
      sourcePath: string;
      surface: MediaTransferSurface;
    }
  | {
      action: MediaTransferAction;
      commandKey: string;
      correlationId: string;
      diagnostic: string | null;
      message: string;
      phase: "error";
      sourcePath: string;
      surface: MediaTransferSurface;
    };

type RunMediaTransferArgs<T> = {
  command: MediaTransferCommand;
  commit: (value: T) => void;
  resolve: (request: { correlationId: string; signal: AbortSignal }) => Promise<T>;
};

export const IDLE_MEDIA_TRANSFER_STATE: MediaTransferState = { phase: "idle" };

let nextMediaTransferCorrelationId = 0;
let nextMediaTransferOwnerId = 0;
let globalMediaTransferSequence = 0;
let globalMediaTransferState: MediaTransferState = IDLE_MEDIA_TRANSFER_STATE;
let globalMediaTransferStateOwner: number | null = null;
let globalActiveTransfer: {
  controller: AbortController;
  ownerId: number;
  sequence: number;
} | null = null;
const globalMediaTransferListeners = new Set<() => void>();

const publishGlobalMediaTransferState = (
  state: MediaTransferState,
  ownerId: number | null,
) => {
  globalMediaTransferState = state;
  globalMediaTransferStateOwner = ownerId;
  globalMediaTransferListeners.forEach((listener) => listener());
};

const subscribeGlobalMediaTransferState = (listener: () => void) => {
  globalMediaTransferListeners.add(listener);
  return () => globalMediaTransferListeners.delete(listener);
};

const getGlobalMediaTransferState = () => globalMediaTransferState;

const createCorrelationId = () => {
  nextMediaTransferCorrelationId += 1;
  return `media-transfer-${Date.now().toString(36)}-${nextMediaTransferCorrelationId}`;
};

const describeDiagnostic = (error: unknown): string | null => {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return typeof error === "string" && error.trim() ? error.trim() : null;
};

export const isMediaTransferAbort = (error: unknown, signal?: AbortSignal) => {
  if (signal?.aborted) return true;
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  );
};

export const buildMediaTransferCommandKey = (
  action: MediaTransferAction,
  sourcePath: string,
  option: string,
) => `${action}:${encodeURIComponent(sourcePath)}:${encodeURIComponent(option)}`;

export const isMediaTransferCommandPending = (
  state: MediaTransferState | undefined,
  commandKey: string,
) => state?.phase === "pending" && state.commandKey === commandKey;

export function useMediaTransferController() {
  const ownerIdRef = React.useRef(0);
  if (ownerIdRef.current === 0) {
    nextMediaTransferOwnerId += 1;
    ownerIdRef.current = nextMediaTransferOwnerId;
  }
  const state = React.useSyncExternalStore(
    subscribeGlobalMediaTransferState,
    getGlobalMediaTransferState,
    getGlobalMediaTransferState,
  );

  const cancel = React.useCallback(() => {
    globalMediaTransferSequence += 1;
    globalActiveTransfer?.controller.abort();
    globalActiveTransfer = null;
    publishGlobalMediaTransferState(IDLE_MEDIA_TRANSFER_STATE, null);
  }, []);

  const cancelOwned = React.useCallback(() => {
    const ownerId = ownerIdRef.current;
    if (globalActiveTransfer?.ownerId === ownerId || globalMediaTransferStateOwner === ownerId) cancel();
  }, [cancel]);

  React.useEffect(() => {
    const ownerId = ownerIdRef.current;
    return () => {
      if (globalActiveTransfer?.ownerId === ownerId) {
        globalMediaTransferSequence += 1;
        globalActiveTransfer.controller.abort();
        globalActiveTransfer = null;
      }
      if (globalMediaTransferStateOwner === ownerId) {
        publishGlobalMediaTransferState(IDLE_MEDIA_TRANSFER_STATE, null);
      }
    };
  }, []);

  const run = React.useCallback(async <T,>({
    command,
    commit,
    resolve,
  }: RunMediaTransferArgs<T>): Promise<boolean> => {
    const ownerId = ownerIdRef.current;
    const sequence = globalMediaTransferSequence + 1;
    globalMediaTransferSequence = sequence;
    globalActiveTransfer?.controller.abort();

    const controller = new AbortController();
    globalActiveTransfer = { controller, ownerId, sequence };
    const correlationId = createCorrelationId();
    publishGlobalMediaTransferState({
      action: command.action,
      commandKey: command.commandKey,
      correlationId,
      message: command.pendingMessage,
      phase: "pending",
      sourcePath: command.sourcePath,
      surface: command.surface,
    }, ownerId);

    try {
      const value = await resolve({ correlationId, signal: controller.signal });
      if (controller.signal.aborted || globalMediaTransferSequence !== sequence) return false;

      // Resolution is cancellable; the final state mutation must be one synchronous commit.
      commit(value);
      if (globalMediaTransferSequence !== sequence) return false;
      publishGlobalMediaTransferState(IDLE_MEDIA_TRANSFER_STATE, null);
      return true;
    } catch (error) {
      if (
        isMediaTransferAbort(error, controller.signal) ||
        globalMediaTransferSequence !== sequence
      ) {
        return false;
      }
      publishGlobalMediaTransferState({
        action: command.action,
        commandKey: command.commandKey,
        correlationId,
        diagnostic: describeDiagnostic(error),
        message: command.failureMessage,
        phase: "error",
        sourcePath: command.sourcePath,
        surface: command.surface,
      }, ownerId);
      return false;
    } finally {
      if (globalActiveTransfer?.sequence === sequence) {
        globalActiveTransfer = null;
      }
    }
  }, []);

  return {
    cancel,
    cancelOwned,
    run,
    state,
  };
}
