import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, MouseEvent as ReactMouseEvent } from "react";

import type { FolderImage } from "@/lib/api";
import {
  getStudioSessionProjectGallerySelection,
  useStudioSessionHydration,
  useStudioSessionStore,
} from "@/lib/stores/studioSessionStore";

export type ProjectGallerySelectionContext = {
  projectId: string | null;
  folder: string | null;
};

type ProjectGalleryExternalSelection = {
  projectId?: string | null;
  folder?: string | null;
  collapsed?: boolean;
};

type UseProjectGallerySelectionRuntimeArgs = {
  onSelectImage?: (
    imagePath: string,
    images: FolderImage[],
    selectionContext?: ProjectGallerySelectionContext,
  ) => void;
  externalSelection?: ProjectGalleryExternalSelection;
  externalSelectionKey?: number;
  controlledCollapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  displayImagesRef: MutableRefObject<FolderImage[]>;
};

const readStoredCollapsedState = (defaultCollapsed?: boolean) => {
  if (defaultCollapsed !== undefined) return defaultCollapsed;
  return getStudioSessionProjectGallerySelection().collapsed;
};

export function useProjectGallerySelectionRuntime({
  onSelectImage,
  externalSelection,
  externalSelectionKey,
  controlledCollapsed,
  defaultCollapsed,
  onCollapsedChange,
  displayImagesRef,
}: UseProjectGallerySelectionRuntimeArgs) {
  useStudioSessionHydration();
  const setSelectedProjectId = useStudioSessionStore(
    useCallback((state) => state.setProjectGalleryProjectId, []),
  );
  const setSelectedFolder = useStudioSessionStore(
    useCallback((state) => state.setProjectGalleryFolder, []),
  );
  const setProjectGalleryCollapsed = useStudioSessionStore(
    useCallback((state) => state.setProjectGalleryCollapsed, []),
  );

  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(() =>
    readStoredCollapsedState(defaultCollapsed),
  );
  const isCollapsed =
    controlledCollapsed !== undefined
      ? controlledCollapsed
      : uncontrolledCollapsed;
  const selectedProjectId = useStudioSessionStore((state) => state.projectGalleryProjectId);
  const selectedFolder = useStudioSessionStore((state) => state.projectGalleryFolder);
  const setProjectGallerySelection = useStudioSessionStore((state) => state.setProjectGallerySelection);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const lastSelectedPathRef = useRef<string | null>(null);
  const appliedExternalSelectionRef = useRef<(ProjectGalleryExternalSelection & { key?: number }) | null>(null);

  const setCollapsed = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const nextValue = typeof value === "function" ? value(isCollapsed) : value;
      if (controlledCollapsed === undefined) {
        setUncontrolledCollapsed(nextValue);
      }
      onCollapsedChange?.(nextValue);
    },
    [controlledCollapsed, isCollapsed, onCollapsedChange],
  );

  const selectionContext = useMemo<ProjectGallerySelectionContext>(
    () => ({
      projectId: selectedProjectId || null,
      folder: selectedFolder || null,
    }),
    [selectedFolder, selectedProjectId],
  );

  const clearSelectionForViewChange = useCallback(() => {
    setSelectedPaths(new Set<string>());
    lastSelectedPathRef.current = null;
  }, []);

  useEffect(() => {
    if (controlledCollapsed === undefined) {
      setProjectGalleryCollapsed(Boolean(uncontrolledCollapsed));
    }
  }, [controlledCollapsed, setProjectGalleryCollapsed, uncontrolledCollapsed]);

  useEffect(() => {
    if (!externalSelection) {
      appliedExternalSelectionRef.current = null;
      return;
    }
    const previous = appliedExternalSelectionRef.current;
    if (previous && previous.projectId === externalSelection.projectId &&
        previous.folder === externalSelection.folder &&
        previous.collapsed === externalSelection.collapsed &&
        previous.key === externalSelectionKey) return;
    // This is a selection command, not a controlled value. Changing collapse
    // callbacks must not replay it over a newer manual project/folder choice.
    appliedExternalSelectionRef.current = { ...externalSelection, key: externalSelectionKey };
    setProjectGallerySelection({
      projectGalleryProjectId: externalSelection.projectId === undefined ? undefined : externalSelection.projectId || "",
      projectGalleryFolder: externalSelection.folder === undefined ? undefined : externalSelection.folder || "",
    });
    if (externalSelection.collapsed !== undefined) {
      setCollapsed(Boolean(externalSelection.collapsed));
    }
    clearSelectionForViewChange();
  }, [clearSelectionForViewChange, externalSelection, externalSelectionKey, setCollapsed, setProjectGallerySelection]);

  const handleImageClick = useCallback(
    (image: FolderImage, event: ReactMouseEvent) => {
      const currentImages = displayImagesRef.current;

      if (event.ctrlKey || event.metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(image.path)) next.delete(image.path);
          else next.add(image.path);
          return next;
        });
        lastSelectedPathRef.current = image.path;
        return;
      }

      if (event.shiftKey && lastSelectedPathRef.current) {
        const startIdx = currentImages.findIndex(
          (currentImage) => currentImage.path === lastSelectedPathRef.current,
        );
        const endIdx = currentImages.findIndex(
          (currentImage) => currentImage.path === image.path,
        );
        if (startIdx !== -1 && endIdx !== -1) {
          const low = Math.min(startIdx, endIdx);
          const high = Math.max(startIdx, endIdx);
          setSelectedPaths((prev) => {
            const next = new Set(prev);
            currentImages.slice(low, high + 1).forEach((currentImage) => {
              next.add(currentImage.path);
            });
            return next;
          });
        }
        return;
      }

      onSelectImage?.(image.path, currentImages, selectionContext);
    },
    [displayImagesRef, onSelectImage, selectionContext],
  );

  return {
    clearSelectionForViewChange,
    handleImageClick,
    isCollapsed,
    selectedFolder,
    selectedPaths,
    selectedProjectId,
    selectionContext,
    setCollapsed,
    setSelectedFolder,
    setSelectedPaths,
    setSelectedProjectId,
  };
}
