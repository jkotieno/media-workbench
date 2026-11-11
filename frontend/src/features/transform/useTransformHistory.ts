import React from "react";

import { cloneTransformDocument } from "@/features/transform/document";
import type { RasterTileDiff } from "@/features/transform/rasterEngine";
import type { TransformDocument } from "@/shared/types";

export type TransformHistorySelection = {
  selectedObjectId: string | null;
  selectedLayerId: string | null;
  editingObjectId: string | null;
};

export type TransformHistoryPaintDiff = RasterTileDiff;

export type TransformHistoryEntry = {
  label: string;
  timestamp: string;
  affectedLayerIds: string[];
  beforeDocument: TransformDocument;
  afterDocument: TransformDocument;
  beforeSelection: TransformHistorySelection;
  afterSelection: TransformHistorySelection;
  paintDiffs?: TransformHistoryPaintDiff[];
};

type HistoryState = {
  entries: TransformHistoryEntry[];
  index: number;
  bytes: number;
};

export type DragHistorySnapshot = {
  beforeDocument: TransformDocument;
  beforeSelection: TransformHistorySelection;
};

type RestoreHistorySnapshot = (
  documentSnapshot: TransformDocument,
  selection: TransformHistorySelection,
  paintDiffs: TransformHistoryPaintDiff[] | undefined,
  side: "before" | "after",
) => Promise<void>;

type UseTransformHistoryArgs = {
  getCurrentHistorySelection: () => TransformHistorySelection;
  restoreHistorySnapshotRef: React.MutableRefObject<RestoreHistorySnapshot>;
  observeHistoryState?: boolean;
};

export const TRANSFORM_HISTORY_ENTRY_LIMIT = 200;
export const TRANSFORM_HISTORY_BYTE_LIMIT = 96 * 1024 * 1024;

function estimateEntryBytes(entry: TransformHistoryEntry): number {
  const documentBytes =
    JSON.stringify(entry.beforeDocument).length +
    JSON.stringify(entry.afterDocument).length;
  const rasterBytes = (entry.paintDiffs || []).reduce(
    (total, diff) => total + diff.byteLength,
    0,
  );
  return documentBytes * 2 + rasterBytes;
}

export function capTransformHistoryEntriesByMemory(entries: TransformHistoryEntry[]): {
  entries: TransformHistoryEntry[];
  bytes: number;
} {
  const nextEntries = entries.slice(-TRANSFORM_HISTORY_ENTRY_LIMIT);
  const sizes = nextEntries.map(estimateEntryBytes);
  let bytes = sizes.reduce((total, size) => total + size, 0);
  while (nextEntries.length > 1 && bytes > TRANSFORM_HISTORY_BYTE_LIMIT) {
    nextEntries.shift();
    bytes -= sizes.shift() ?? 0;
  }
  return { entries: nextEntries, bytes };
}

export function useTransformHistory({
  getCurrentHistorySelection,
  restoreHistorySnapshotRef,
  observeHistoryState = true,
}: UseTransformHistoryArgs) {
  const initialHistoryState: HistoryState = {
    entries: [],
    index: 0,
    bytes: 0,
  };
  const historyStateRef = React.useRef<HistoryState>(initialHistoryState);
  const observeHistoryStateRef = React.useRef(observeHistoryState);
  observeHistoryStateRef.current = observeHistoryState;
  const [historyState, setHistoryState] = React.useState<HistoryState>(initialHistoryState);
  const [historyRestoring, setHistoryRestoring] = React.useState(false);
  const historyBaseDocumentRef = React.useRef<TransformDocument | null>(null);
  const historyRestoringRef = React.useRef(false);
  const applyHistoryStepRef = React.useRef<(direction: "undo" | "redo") => void>(() => {});

  const updateHistoryState = React.useCallback((
    update: (current: HistoryState) => HistoryState,
  ) => {
    const current = historyStateRef.current;
    const next = update(current);
    if (next === current) {
      return;
    }
    historyStateRef.current = next;
    const currentCanUndo = current.index > 0;
    const nextCanUndo = next.index > 0;
    const currentCanRedo = current.index < current.entries.length;
    const nextCanRedo = next.index < next.entries.length;
    if (
      observeHistoryStateRef.current ||
      currentCanUndo !== nextCanUndo ||
      currentCanRedo !== nextCanRedo
    ) {
      setHistoryState(next);
    }
  }, []);

  React.useEffect(() => {
    if (observeHistoryState) {
      setHistoryState(historyStateRef.current);
    }
  }, [observeHistoryState]);

  const pushHistoryEntry = React.useCallback((entry: TransformHistoryEntry) => {
    const hasPaintDiffs = Boolean(entry.paintDiffs?.length);
    if (!hasPaintDiffs && JSON.stringify(entry.beforeDocument) === JSON.stringify(entry.afterDocument)) {
      return;
    }
    const nextEntry: TransformHistoryEntry = {
      beforeDocument: cloneTransformDocument(entry.beforeDocument),
      afterDocument: cloneTransformDocument(entry.afterDocument),
      label: entry.label || "Edit document",
      timestamp: entry.timestamp || new Date().toISOString(),
      affectedLayerIds: [...new Set(entry.affectedLayerIds || [])],
      beforeSelection: { ...entry.beforeSelection },
      afterSelection: { ...entry.afterSelection },
      paintDiffs: entry.paintDiffs,
    };
    updateHistoryState((prev) => {
      const base = prev.entries.slice(0, prev.index);
      base.push(nextEntry);
      const capped = capTransformHistoryEntriesByMemory(base);
      return {
        entries: capped.entries,
        index: capped.entries.length,
        bytes: capped.bytes,
      };
    });
  }, [updateHistoryState]);

  const pushHistory = React.useCallback((
    afterDocument: TransformDocument,
    options?: {
      beforeDocument?: TransformDocument | null;
      beforeSelection?: TransformHistorySelection;
      afterSelection?: TransformHistorySelection;
      paintDiffs?: TransformHistoryPaintDiff[];
      label?: string;
      affectedLayerIds?: string[];
    },
  ) => {
    updateHistoryState((prev) => {
      const beforeDocument =
        options?.beforeDocument ??
        (prev.index > 0
          ? prev.entries[prev.index - 1]?.afterDocument
          : historyBaseDocumentRef.current);
      if (!beforeDocument) {
        return prev;
      }
      const hasPaintDiffs = Boolean(options?.paintDiffs?.length);
      if (!hasPaintDiffs && JSON.stringify(beforeDocument) === JSON.stringify(afterDocument)) {
        return prev;
      }
      const nextEntry: TransformHistoryEntry = {
        label: options?.label || "Edit document",
        timestamp: new Date().toISOString(),
        affectedLayerIds: options?.affectedLayerIds || [],
        beforeDocument: cloneTransformDocument(beforeDocument),
        afterDocument: cloneTransformDocument(afterDocument),
        beforeSelection: options?.beforeSelection ?? getCurrentHistorySelection(),
        afterSelection: options?.afterSelection ?? getCurrentHistorySelection(),
        paintDiffs: options?.paintDiffs,
      };
      const base = prev.entries.slice(0, prev.index);
      base.push(nextEntry);
      const capped = capTransformHistoryEntriesByMemory(base);
      return {
        entries: capped.entries,
        index: capped.entries.length,
        bytes: capped.bytes,
      };
    });
  }, [getCurrentHistorySelection, updateHistoryState]);

  const resetHistory = React.useCallback((nextDocument: TransformDocument) => {
    const snapshot = cloneTransformDocument(nextDocument);
    historyBaseDocumentRef.current = snapshot;
    updateHistoryState(() => ({ entries: [], index: 0, bytes: 0 }));
  }, [updateHistoryState]);

  const applyHistoryStep = React.useCallback(async (direction: "undo" | "redo") => {
    if (historyRestoringRef.current) {
      return;
    }
    const currentHistoryState = historyStateRef.current;
    const entry =
      direction === "undo"
        ? currentHistoryState.entries[currentHistoryState.index - 1]
        : currentHistoryState.entries[currentHistoryState.index];
    if (!entry) {
      return;
    }
    const nextIndex =
      direction === "undo"
        ? currentHistoryState.index - 1
        : currentHistoryState.index + 1;
    historyRestoringRef.current = true;
    setHistoryRestoring(true);
    try {
      await restoreHistorySnapshotRef.current(
        direction === "undo" ? entry.beforeDocument : entry.afterDocument,
        direction === "undo" ? entry.beforeSelection : entry.afterSelection,
        entry.paintDiffs,
        direction === "undo" ? "before" : "after",
      );
      updateHistoryState((prev) => ({ ...prev, index: nextIndex }));
    } finally {
      historyRestoringRef.current = false;
      setHistoryRestoring(false);
    }
  }, [restoreHistorySnapshotRef, updateHistoryState]);

  React.useEffect(() => {
    applyHistoryStepRef.current = (direction: "undo" | "redo") => {
      void applyHistoryStep(direction);
    };
  }, [applyHistoryStep]);

  return {
    historyState,
    historyRestoring,
    canUndo: !historyRestoring && historyState.index > 0,
    canRedo: !historyRestoring && historyState.index < historyState.entries.length,
    pushHistoryEntry,
    pushHistory,
    resetHistory,
    applyHistoryStep,
    applyHistoryStepRef,
  };
}
