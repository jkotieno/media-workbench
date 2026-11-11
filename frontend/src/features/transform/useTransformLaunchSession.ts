import React from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import {
  ensureTransformDocument,
  normalizeTransformMode,
} from "@/features/transform/document";
import type {
  Project,
  TransformDocument,
  TransformEditTool,
  TransformMode,
  TransformProjectContext,
  TransformWorkspaceLaunchPayload,
} from "@/shared/types";

type TransformLaunchRequest = Pick<
  TransformWorkspaceLaunchPayload,
  "imagePath" | "initialMode" | "workspaceProjectSlug" | "workspaceFolder"
>;

export function resolveTransformLaunchTargets(
  payload: Pick<TransformLaunchRequest, "workspaceProjectSlug" | "workspaceFolder">,
  project: Pick<TransformProjectContext, "slug" | "folder">,
  preferredMode: TransformMode,
): {
  projectSlug: string;
  exportFolder: string;
  maskFolder: string;
} {
  const projectSlug = (payload.workspaceProjectSlug ?? project.slug) || "";
  const launchFolder = (payload.workspaceFolder ?? project.folder) || "";
  return {
    projectSlug,
    exportFolder: launchFolder,
    maskFolder:
      launchFolder ||
      (preferredMode === "mask" && projectSlug ? "masks" : ""),
  };
}

type UseTransformLaunchSessionArgs = {
  open: boolean;
  launchPayload: TransformWorkspaceLaunchPayload | null;
  documentRef: React.MutableRefObject<TransformDocument | null>;
  launchImagePathRef: React.MutableRefObject<string | null>;
  lastSavedDocumentRef: React.MutableRefObject<TransformDocument | null>;
  setDocumentState: React.Dispatch<React.SetStateAction<TransformDocument | null>>;
  resetHistory: (nextDocument: TransformDocument) => void;
  setSaveState: React.Dispatch<React.SetStateAction<"saved" | "saving" | "dirty" | "error">>;
  setTargetProjectSlug: React.Dispatch<React.SetStateAction<string>>;
  setExportTargetFolder: React.Dispatch<React.SetStateAction<string>>;
  setMaskTargetFolder: React.Dispatch<React.SetStateAction<string>>;
  setMode: React.Dispatch<React.SetStateAction<TransformMode>>;
  setSelectedLayerId: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedObjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setEditingObjectId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveTool: React.Dispatch<React.SetStateAction<TransformEditTool>>;
  setProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  setSourceElement: React.Dispatch<React.SetStateAction<HTMLImageElement | null>>;
  setSourceLoadRevision: React.Dispatch<React.SetStateAction<number>>;
  setFitReady: React.Dispatch<React.SetStateAction<boolean>>;
  setFitRevision: React.Dispatch<React.SetStateAction<number>>;
  resetViewportState: () => void;
};

export function useTransformLaunchSession({
  open,
  launchPayload,
  documentRef,
  launchImagePathRef,
  lastSavedDocumentRef,
  setDocumentState,
  resetHistory,
  setSaveState,
  setTargetProjectSlug,
  setExportTargetFolder,
  setMaskTargetFolder,
  setMode,
  setSelectedLayerId,
  setSelectedObjectId,
  setEditingObjectId,
  setActiveTool,
  setProjects,
  setSourceElement,
  setSourceLoadRevision,
  setFitReady,
  setFitRevision,
  resetViewportState,
}: UseTransformLaunchSessionArgs) {
  const { t } = useTranslation("transform");
  const [launchLoading, setLaunchLoading] = React.useState(false);
  const [launchError, setLaunchError] = React.useState<string | null>(null);
  const latestLaunchRequestIdRef = React.useRef(0);

  const launchImagePath = launchPayload?.imagePath;
  const launchInitialMode = launchPayload?.initialMode;
  const launchWorkspaceProjectSlug = launchPayload?.workspaceProjectSlug;
  const launchWorkspaceFolder = launchPayload?.workspaceFolder;

  const launchRequest = React.useMemo<TransformLaunchRequest | null>(() => {
    if (!launchImagePath) {
      return null;
    }
    return {
      imagePath: launchImagePath,
      initialMode: launchInitialMode ?? "edit",
      workspaceProjectSlug: launchWorkspaceProjectSlug,
      workspaceFolder: launchWorkspaceFolder,
    };
  }, [
    launchImagePath,
    launchInitialMode,
    launchWorkspaceFolder,
    launchWorkspaceProjectSlug,
  ]);

  const loadLaunch = React.useCallback(
    async (payload: TransformLaunchRequest) => {
      const requestId = latestLaunchRequestIdRef.current + 1;
      latestLaunchRequestIdRef.current = requestId;
      const preferredMode = normalizeTransformMode(payload.initialMode);
      setLaunchLoading(true);
      setLaunchError(null);
      setFitReady(false);
      setFitRevision((revision) => revision + 1);
      setSourceElement(null);
      documentRef.current = null;
      setDocumentState(null);
      launchImagePathRef.current = null;
      lastSavedDocumentRef.current = null;
      try {
        const [launchInfo, fetchedProjects] = await Promise.all([
          api.getTransformLaunch(payload.imagePath),
          api.getProjects().catch(() => []),
        ]);
        const normalized = ensureTransformDocument(launchInfo.document ?? null, {
          sourceImage: launchInfo.source_image,
          project: launchInfo.project,
          initialMode: preferredMode,
        });
        if (latestLaunchRequestIdRef.current !== requestId) {
          return;
        }
        if (!launchInfo.document) {
          normalized.lastUsedMode = preferredMode;
        }
        const launchImagePath =
          launchInfo.launch_image_path || launchInfo.resolved_source_path || normalized.sourceImage.path;
        normalized.edit.lastUsedTool = "select";
        launchImagePathRef.current = launchImagePath;
        documentRef.current = normalized;
        setDocumentState(normalized);
        setSourceLoadRevision((revision) => revision + 1);
        resetHistory(normalized);
        lastSavedDocumentRef.current = normalized;
        setSaveState("saved");
        const targets = resolveTransformLaunchTargets(
          payload,
          launchInfo.project,
          preferredMode,
        );
        setTargetProjectSlug(targets.projectSlug);
        setExportTargetFolder(targets.exportFolder);
        setMaskTargetFolder(targets.maskFolder);
        setMode(launchInfo.document ? normalized.lastUsedMode : preferredMode);
        const firstLayer = normalized.edit.layers[0] || null;
        setSelectedLayerId(firstLayer?.id || null);
        setSelectedObjectId(
          firstLayer?.kind === "text_object" || firstLayer?.kind === "image_layer"
            ? firstLayer.refId
            : null,
        );
        setEditingObjectId(null);
        setActiveTool("select");
        resetViewportState();
        setProjects(fetchedProjects);
      } catch (error) {
        if (latestLaunchRequestIdRef.current !== requestId) {
          return;
        }
        console.error("Failed to load transform", error);
        setLaunchError(t("workspace.loadFailed"));
      } finally {
        if (latestLaunchRequestIdRef.current === requestId) {
          setLaunchLoading(false);
        }
      }
    },
    [
      documentRef,
      lastSavedDocumentRef,
      launchImagePathRef,
      resetHistory,
      setActiveTool,
      setDocumentState,
      setEditingObjectId,
      setFitReady,
      setFitRevision,
      setMode,
      setProjects,
      resetViewportState,
      setSaveState,
      setSelectedLayerId,
      setSelectedObjectId,
      setSourceElement,
      setSourceLoadRevision,
      setExportTargetFolder,
      setMaskTargetFolder,
      setTargetProjectSlug,
      t,
    ],
  );

  React.useEffect(() => {
    if (!open || !launchRequest) {
      latestLaunchRequestIdRef.current += 1;
      setLaunchLoading(false);
      return;
    }
    void loadLaunch(launchRequest);
    return () => { latestLaunchRequestIdRef.current += 1; };
  }, [launchRequest, loadLaunch, open]);

  return {
    launchLoading,
    launchError,
    loadLaunch,
  };
}
