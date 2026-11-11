import React from "react";

import { useTransformOperationScope } from "./useTransformOperationScope";
import { api } from "@/lib/api";
import type { TransformDocument } from "@/shared/types";

type TransformSaveState = "saved" | "saving" | "dirty" | "error";

type UseTransformAutosaveArgs = {
  active: boolean;
  sessionKey: string;
  maskDraftSaveRef: React.MutableRefObject<Promise<void> | null>;
  documentState: TransformDocument | null;
  documentRef: React.MutableRefObject<TransformDocument | null>;
  pendingPaintLayerFilesRef: React.MutableRefObject<Map<string, Blob | File>>;
  lastSavedDocumentRef: React.MutableRefObject<TransformDocument | null>;
  saveSequenceRef: React.MutableRefObject<number>;
  setDocumentState: React.Dispatch<React.SetStateAction<TransformDocument | null>>;
  setSaveState: React.Dispatch<React.SetStateAction<TransformSaveState>>;
  preparePaintLayerFiles?: () => Promise<void>;
  isInteractionActive?: () => boolean;
  silentDocumentRef?: React.MutableRefObject<TransformDocument | null>;
};

export function useTransformAutosave({
  active,
  sessionKey,
  maskDraftSaveRef,
  documentState,
  documentRef,
  pendingPaintLayerFilesRef,
  lastSavedDocumentRef,
  saveSequenceRef,
  setDocumentState,
  setSaveState,
  preparePaintLayerFiles,
  isInteractionActive,
  silentDocumentRef,
}: UseTransformAutosaveArgs) {
  const captureScope = useTransformOperationScope(sessionKey, active);
  const autosaveTimerRef = React.useRef<number | null>(null);
  const documentRevisionRef = React.useRef(0);
  const observedDocumentRef = React.useRef<TransformDocument | null>(null);

  const scheduleAutosave = React.useCallback((options?: {
    publishResponse?: boolean;
    updateStatus?: boolean;
  }) => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const revision = documentRevisionRef.current + 1;
    documentRevisionRef.current = revision;
    const publishResponse = options?.publishResponse !== false;
    const updateStatus = options?.updateStatus !== false;
    const saveSequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = saveSequence;
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    if (updateStatus) {
      setSaveState("dirty");
    }

    const saveWhenIdle = () => {
      if (!isCurrent()) return;
      if (isInteractionActive?.()) {
        autosaveTimerRef.current = window.setTimeout(saveWhenIdle, 600);
        return;
      }
      autosaveTimerRef.current = null;
      void (async () => {
        try {
          if (updateStatus) {
            setSaveState("saving");
          }
          await preparePaintLayerFiles?.();
          while (isCurrent() && maskDraftSaveRef.current) await maskDraftSaveRef.current;
          if (!isCurrent()) return;
          const documentToSave = documentRef.current;
          if (!documentToSave) {
            return;
          }
          const paintLayerFiles = [...pendingPaintLayerFilesRef.current.entries()].map(([layerId, file]) => ({
            layerId,
            file,
          }));
          const response = await api.saveTransformDocument(documentToSave, { paintLayerFiles });
          if (
            !isCurrent() || documentRef.current !== documentToSave ||
            saveSequenceRef.current !== saveSequence ||
            documentRevisionRef.current !== revision
          ) {
            return;
          }
          for (const { layerId, file } of paintLayerFiles) {
            if (pendingPaintLayerFilesRef.current.get(layerId) === file) {
              pendingPaintLayerFilesRef.current.delete(layerId);
            }
          }
          const nextDocument = response.document;
          documentRef.current = nextDocument;
          lastSavedDocumentRef.current = nextDocument;
          if (publishResponse) {
            observedDocumentRef.current = nextDocument;
            setDocumentState(nextDocument);
          }
          if (updateStatus) {
            setSaveState("saved");
          }
        } catch (error) {
          if (!isCurrent() || saveSequenceRef.current !== saveSequence) return;
          console.error("Failed to save transform document", error);
          setSaveState("error");
        }
      })();
    };

    autosaveTimerRef.current = window.setTimeout(saveWhenIdle, 600);
  }, [
    captureScope,
    documentRef,
    isInteractionActive,
    lastSavedDocumentRef,
    maskDraftSaveRef,
    pendingPaintLayerFilesRef,
    preparePaintLayerFiles,
    saveSequenceRef,
    setDocumentState,
    setSaveState,
  ]);

  React.useEffect(() => {
    if (!documentState || observedDocumentRef.current === documentState) {
      return;
    }
    observedDocumentRef.current = documentState;
    if (documentState === lastSavedDocumentRef.current) {
      return;
    }
    if (silentDocumentRef?.current === documentState) {
      silentDocumentRef.current = null;
      scheduleAutosave({
        publishResponse: false,
        updateStatus: false,
      });
      return;
    }
    scheduleAutosave();
  }, [
    documentState,
    lastSavedDocumentRef,
    scheduleAutosave,
    silentDocumentRef,
  ]);

  React.useEffect(() => () => {
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, [sessionKey, active]);

  return { scheduleAutosave };
}
