import React from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { cloneTransformDocument } from "@/features/transform/document";
import { getTransformCanvasGeometry } from "@/features/transform/render";
import { useTransformOperationScope } from "./useTransformOperationScope";
import { expansionFrame } from "./expansion";
import { toBlob } from "@/features/transform/transformCanvasUtils";
import type { TransformDocument, TransformExportResponse, TransformSaveMode } from "@/shared/types";

function buildDisplayName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

type UseTransformDeliveryArgs = {
  active: boolean;
  sessionKey: string;
  maskDraftSaveRef: React.MutableRefObject<Promise<void> | null>;
  documentState: TransformDocument | null;
  documentRef: React.MutableRefObject<TransformDocument | null>;
  sourceElement: HTMLImageElement | null;
  launchImagePathRef: React.MutableRefObject<string | null>;
  lastSavedDocumentRef: React.MutableRefObject<TransformDocument | null>;
  targetProjectSlug: string;
  exportTargetFolder: string;
  maskTargetFolder: string;
  buildCompositeCanvas: (documentToRender: TransformDocument) => Promise<HTMLCanvasElement | null>;
  flushDirtyPaintLayers: () => Promise<void>;
  setSaveState: React.Dispatch<React.SetStateAction<"saved" | "saving" | "dirty" | "error">>;
  onExported?: (response?: TransformExportResponse) => void | Promise<void>;
  reloadAfterOverwrite?: (imagePath: string) => Promise<void>;
};

export function useTransformDelivery({
  active,
  sessionKey,
  maskDraftSaveRef,
  documentState,
  documentRef,
  sourceElement,
  launchImagePathRef,
  lastSavedDocumentRef,
  targetProjectSlug,
  exportTargetFolder,
  maskTargetFolder,
  buildCompositeCanvas,
  flushDirtyPaintLayers,
  setSaveState,
  onExported,
  reloadAfterOverwrite,
}: UseTransformDeliveryArgs) {
  const { t } = useTranslation("transform");
  const [exportState, setExportState] = React.useState<"idle" | "exporting" | "error" | "done">("idle");
  const [exportMessage, setExportMessage] = React.useState<string | null>(null);
  const [activeSaveMode, setActiveSaveMode] = React.useState<TransformSaveMode>("new_copy");
  const [lastExportResponse, setLastExportResponse] = React.useState<TransformExportResponse | null>(null);

  const scopeKey = JSON.stringify([sessionKey, targetProjectSlug, exportTargetFolder, maskTargetFolder]);
  const captureScope = useTransformOperationScope(scopeKey, active);
  const draftSequence = React.useRef(0);
  React.useEffect(() => {
    setExportState("idle"); setExportMessage(null); setLastExportResponse(null);
  }, [scopeKey, active]);

  const handleExport = React.useCallback(async (
    saveMode: TransformSaveMode = "new_copy",
    options?: { filename?: string | null },
  ): Promise<TransformExportResponse | null> => {
    if (!documentState || !sourceElement) {
      return null;
    }
    const isCurrent = captureScope();
    if (!isCurrent()) return null;
    const launchImagePath = launchImagePathRef.current;
    try {
      setActiveSaveMode(saveMode);
      setExportState("exporting");
      setExportMessage(null);
      await document.fonts.ready;
      if (!isCurrent()) return null;
      await flushDirtyPaintLayers();
      if (!isCurrent()) return null;
      const currentDocument = cloneTransformDocument(documentRef.current || documentState);
      const exportCanvas = await buildCompositeCanvas(currentDocument);
      if (!isCurrent()) return null;
      if (!exportCanvas) {
        throw new Error("transform_export_canvas_unavailable");
      }
      const hasVisibleSourceErasure = currentDocument.edit.layers.some((layer) => {
        if (layer.kind !== "paint_layer" || !layer.visible) {
          return false;
        }
        return currentDocument.edit.paintLayers.some(
          (paintLayer) => paintLayer.id === layer.refId && paintLayer.role === "source_eraser",
        );
      });
      const sourceFormat = currentDocument.sourceImage.format;
      const outputFormat = hasVisibleSourceErasure ? "png" : sourceFormat;
      const mimeType =
        outputFormat === "jpg" || outputFormat === "jpeg"
          ? "image/jpeg"
          : outputFormat === "webp"
            ? "image/webp"
            : "image/png";
      const blob = await toBlob(exportCanvas, mimeType);
      if (!isCurrent()) return null;
      const renderGeometry = getTransformCanvasGeometry(currentDocument);
      const requestedFilename =
        options?.filename?.trim() ||
        `${buildDisplayName(currentDocument.sourceImage.path).replace(/\.[^.]+$/, "")}_transform.${outputFormat}`;
      const response = await api.exportTransformDocument({
        file: blob,
        filename: requestedFilename,
        document: currentDocument,
        sourcePath: currentDocument.sourceImage.path,
        renderGeometry: {
          width: renderGeometry.width,
          height: renderGeometry.height,
          offsetX: renderGeometry.offsetX,
          offsetY: renderGeometry.offsetY,
        },
        saveMode,
        launchImagePath,
        targetProjectSlug: targetProjectSlug || null,
        targetFolder: exportTargetFolder || null,
        requestedFilename: saveMode === "new_copy" ? requestedFilename : null,
      });
      if (!isCurrent()) return null;
      setLastExportResponse(response);
      await onExported?.(response);
      if (!isCurrent()) return null;
      if (saveMode === "overwrite_current") {
        if (!response.path) {
          throw new Error("transform_overwrite_path_missing");
        }
        await reloadAfterOverwrite?.(response.path);
        if (!isCurrent()) return null;
        setExportMessage(t("delivery.overwrote", { filename: response.filename }));
      } else {
        setExportMessage(t("delivery.exported", { filename: response.filename }));
      }
      setExportState("done");
      return response;
    } catch (error) {
      if (!isCurrent()) return null;
      console.error("Failed to export transform document", error);
      setExportState("error");
      setExportMessage(t("delivery.exportFailed"));
      return null;
    }
  }, [captureScope, buildCompositeCanvas, documentRef, documentState, exportTargetFolder, flushDirtyPaintLayers, launchImagePathRef, onExported, reloadAfterOverwrite, sourceElement, t, targetProjectSlug]);

  const handleMaskSave = React.useCallback(async (maskFile: File) => {
    if (!documentState) {
      return;
    }
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    try {
      const maskProjectSlug = targetProjectSlug || documentState.project.slug || null;
      const result = await api.saveMask(maskFile, documentState.sourceImage.path, {
        projectSlug: maskProjectSlug,
        subfolder: maskTargetFolder || null,
      });
      if (!isCurrent()) return;
      const location = result.saved_to === "same_folder"
        ? t("delivery.sameFolder")
        : result.folder
          ? t("delivery.namedFolder", { folder: result.folder })
          : t("delivery.projectFolder");
      setExportState("done");
      setExportMessage(t("delivery.maskSavedAt", {
        filename: result.filename,
        location,
      }));
      await onExported?.({
        path: result.path,
        filename: result.filename,
        project_slug: result.project_slug ?? null,
        folder: result.folder ?? null,
        saved_at: result.saved_at,
        mtime: result.mtime ?? null,
      });
    } catch (error) {
      if (!isCurrent()) return;
      console.error("Failed to save mask", error);
      setExportState("error");
      setExportMessage(t("delivery.maskSaveFailed"));
      throw error;
    }
  }, [captureScope, documentState, maskTargetFolder, onExported, t, targetProjectSlug]);

  const handleMaskDraftChange = React.useCallback(async (draftFile: File | null, baseFile?: File | null) => {
    const isCurrent = captureScope();
    const current = documentRef.current;
    if (!current || !isCurrent()) {
      return;
    }
    const sequence = ++draftSequence.current;
    const nextDocument = cloneTransformDocument(current);
    nextDocument.lastUsedMode = "mask";
    nextDocument.mask.coverageFrame = nextDocument.edit.expansion ? expansionFrame(nextDocument.edit.expansion)
      : { x: 0, y: 0, width: nextDocument.sourceImage.width, height: nextDocument.sourceImage.height };
    nextDocument.mask = {
      ...nextDocument.mask,
      hasDraft: Boolean(draftFile),
      coverageAssetPath: draftFile
        ? nextDocument.mask.coverageAssetPath ?? nextDocument.mask.draftPath ?? null
        : null,
      draftPath: draftFile ? nextDocument.mask.draftPath ?? null : null,
    };
    nextDocument.updatedAt = new Date().toISOString();
    const pending = (async () => {
      try {
        const response = await api.saveTransformDocument(nextDocument, {
          maskDraftFile: draftFile,
          maskBaseFile: baseFile,
          clearMaskDraft: draftFile === null,
        });
        if (!isCurrent() || sequence !== draftSequence.current) return;
        // Keep newer paint/settings edits and attach only the saved coverage identity.
        const latest = documentRef.current;
        if (!latest || latest.id !== current.id) return;
        const savedMask = response.document.mask;
        documentRef.current = latest === current ? response.document : {
          ...latest, mask: { ...latest.mask,
            hasDraft: savedMask.hasDraft,
            coverageAssetPath: savedMask.coverageAssetPath,
            draftPath: savedMask.draftPath,
            baseCoverageAssetPath: savedMask.baseCoverageAssetPath,
            coverageFrame: savedMask.coverageFrame,
          },
        };
        lastSavedDocumentRef.current = response.document;
      } catch (error) {
        if (!isCurrent() || sequence !== draftSequence.current) return;
        console.error("Failed to save mask draft", error);
        setSaveState("error");
        throw error;
      }
    })();
    maskDraftSaveRef.current = pending;
    try { await pending; }
    finally { if (maskDraftSaveRef.current === pending) maskDraftSaveRef.current = null; }
  }, [captureScope, documentRef, lastSavedDocumentRef, maskDraftSaveRef, setSaveState]);

  return {
    activeSaveMode,
    exportState,
    exportMessage,
    lastExportResponse,
    handleExport,
    handleMaskSave,
    handleMaskDraftChange,
  };
}
