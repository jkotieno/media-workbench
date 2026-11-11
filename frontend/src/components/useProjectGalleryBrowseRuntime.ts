import {readFolderImageStream} from "@/lib/folderImageStream";
import {mediaSelection,parseMediaSelection} from "@/shared/api/media-sources.api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, SetStateAction } from "react";

import { type FolderImage, IMAGE_API_BASE, type Project } from "@/lib/api";
import { profileStorage } from "@/lib/profileStorage";
import {resolveFolderSelection, type FolderSelection, type ProjectFolder} from "@/lib/projectFolderSelection";
import { reconcileFolderImagesUsingRefreshedOrder } from "@/lib/folderImages";
import { getScrollSnapshot, saveScrollSnapshot, type GalleryScrollPosition } from "@/lib/galleryState";
import {
  mergeProjectGalleryImagesWithProvisional,
  type ProjectGalleryProvisionalImage,
} from "@/lib/provisionalMedia";

import type { ProjectGallerySelectionContext } from "./useProjectGallerySelectionRuntime";

const PROJECT_GALLERY_POLL_INTERVAL_MS = 5000;
const PROJECT_GALLERY_RECENT_SYNC_WINDOW_MS = 10_000;
const PROJECT_GALLERY_VIEW_CACHE_LIMIT = 12;
const projectGalleryViewCache = new Map<string, FolderImage[]>();

const buildProjectGalleryViewKey = (
  projectId: string | null | undefined,
  folder: string | null | undefined,
) => `${projectId || ""}:${folder || ""}`;

const readProjectGalleryViewCache = (viewKey: string) => {
  const cached = projectGalleryViewCache.get(viewKey);
  return cached ? [...cached] : null;
};

const writeProjectGalleryViewCache = (
  projectId: string | null | undefined,
  folder: string | null | undefined,
  images: FolderImage[],
) => {
  if (!projectId || !folder) return;
  const viewKey = buildProjectGalleryViewKey(projectId, folder);
  if (projectGalleryViewCache.has(viewKey)) {
    projectGalleryViewCache.delete(viewKey);
  }
  projectGalleryViewCache.set(
    viewKey,
    [...images],
  );
  while (projectGalleryViewCache.size > PROJECT_GALLERY_VIEW_CACHE_LIMIT) {
    const oldestKey = projectGalleryViewCache.keys().next().value;
    if (!oldestKey) break;
    projectGalleryViewCache.delete(oldestKey);
  }
};

export const clearProjectGalleryBrowseRuntimeCache = () => {
  projectGalleryViewCache.clear();
};

export const __resetProjectGalleryBrowseRuntimeCacheForTests =
  clearProjectGalleryBrowseRuntimeCache;

const buildFolderImagesUrl = (projectId: string, folder: string) => {
  const media=parseMediaSelection(folder);
  if(media)return `${IMAGE_API_BASE}/projects/${encodeURIComponent(projectId)}/media-roots/${media.attachment_id}/media?`+new URLSearchParams(media.folder_id?{folder_id:media.folder_id}:{});
  const params = new URLSearchParams({
    include_dimensions: "false",
    folder_name: folder,
    progressive: "true",
  });
  return `${IMAGE_API_BASE}/projects/${encodeURIComponent(projectId)}/folder-images?${params.toString()}`;
};

export type ProjectGalleryExternalViewImages = {
  projectId?: string | null;
  folder?: string | null;
  images: FolderImage[];
  syncKey?: number;
};

const areFolderImagesEquivalent = (
  currentImages: FolderImage[],
  nextImages: FolderImage[],
  normalizePath: (pathStr?: string | null) => string,
) => {
  if (currentImages.length !== nextImages.length) return false;

  return currentImages.every((image, index) => {
    const nextImage = nextImages[index];
    if (!nextImage) return false;
    return (
      normalizePath(image.path) === normalizePath(nextImage.path) &&
      String(image.filename || "") === String(nextImage.filename || "") &&
      String(image.mtime || "") === String(nextImage.mtime || "")
    );
  });
};

type UseProjectGalleryBrowseRuntimeArgs = {
  projects: Project[];
  selectedProjectId: string;
  selectedFolder: string;
  setSelectedFolder: (value: SetStateAction<string>) => void;
  isCollapsed: boolean;
  provisionalImages?: ProjectGalleryProvisionalImage[];
  viewerImagePath?: string | null;
  externalViewImages?: ProjectGalleryExternalViewImages;
  refreshKey?: number;
  onImagesUpdate?: (payload: {
    projectId: string | null;
    folder: string | null;
    images: FolderImage[];
  }) => void;
  clearSelectionForViewChange: () => void;
  normalizePath: (pathStr?: string | null) => string;
  displayImagesRef: MutableRefObject<FolderImage[]>;
};

export function useProjectGalleryBrowseRuntime({
  projects,
  selectedProjectId,
  selectedFolder,
  setSelectedFolder,
  isCollapsed,
  provisionalImages = [],
  viewerImagePath,
  externalViewImages,
  refreshKey,
  onImagesUpdate,
  clearSelectionForViewChange,
  normalizePath,
  displayImagesRef,
}: UseProjectGalleryBrowseRuntimeArgs) {
  const currentViewKey = buildProjectGalleryViewKey(
    selectedProjectId,
    selectedFolder,
  );
  const [imageView, setImageView] = useState(() => {
    const cached = readProjectGalleryViewCache(currentViewKey);
    return { key: currentViewKey, images: cached ?? [], ready: cached !== null };
  });
  // A new folder must never render the previous folder's list, even for one
  // commit: its virtual grid would restore against the wrong scroll height.
  const images = useMemo(() => imageView.key === currentViewKey
    ? imageView.images : readProjectGalleryViewCache(currentViewKey) ?? [],
    [currentViewKey, imageView]);
  const scrollRestorationReady = imageView.key === currentViewKey
    ? imageView.ready : readProjectGalleryViewCache(currentViewKey) !== null;
  const [isLoading, setIsLoading] = useState(false);
  const [nextMediaCursor,setNextMediaCursor]=useState<string|null>(null);
  const [mediaPageError,setMediaPageError]=useState("");
  const [loadingMore,setLoadingMore]=useState(false);
  const loadedMediaPages = useRef({
    key: currentViewKey,
    count: getScrollSnapshot(currentViewKey).mediaPageCount ?? 1,
  });
  const imagesRef = useRef<FolderImage[]>([]);
  const externalSyncRef = useRef<{key: string; syncKey?: number} | null>(null);
  const currentRequestViewKeyRef = useRef<string>(currentViewKey);
  const onImagesUpdateRef = useRef(onImagesUpdate);
  const requestSequenceRef = useRef(0);
  const loadingRequestIdRef = useRef<number | null>(null);
  const activeRequestAbortRef = useRef<AbortController | null>(null);
  const previousScopedProvisionalCountRef = useRef(0);
  const lastRefreshKeyRef = useRef(refreshKey);
  const [recentSyncUntil, setRecentSyncUntil] = useState(0);

  imagesRef.current = images;

  useEffect(() => {
    onImagesUpdateRef.current = onImagesUpdate;
  }, [onImagesUpdate]);

  const sortedProjects = useMemo(() => {
    const result = [...projects];
    const draftsIndex = result.findIndex((project) => project.slug === "drafts");

    if (draftsIndex !== -1) {
      const [drafts] = result.splice(draftsIndex, 1);
      result.unshift({
        ...drafts,
        name: "drafts",
      });
    }

    return result;
  }, [projects]);

  const selectedProject = useMemo(
    () => sortedProjects.find((project) => String(project.id) === selectedProjectId),
    [selectedProjectId, sortedProjects],
  );

  const folders = useMemo(
    () => (selectedProject?.config_json as { folders?: string[] } | undefined)?.folders ?? [],
    [selectedProject],
  );

  useEffect(() => {
    if (!selectedProject) return; // A pending catalog cannot choose a different view.
    if (!selectedFolder) {
      const defaultRoot = selectedProject.config_json?.media_default_attachment_id;
      setSelectedFolder(typeof defaultRoot === "string" ? mediaSelection(defaultRoot, null) : folders[0] ?? "");
      return;
    }
    let previous: FolderSelection | null = null;
    const key = "ds_project_gallery_folder_identity";
    try { previous = JSON.parse(profileStorage.getItem(key) || "null"); } catch { /* Legacy preferences have no identity. */ }
    const selection = resolveFolderSelection(selectedProjectId, selectedFolder, folders,
      (selectedProject.config_json?.folder_tree ?? []) as ProjectFolder[], previous);
    if (selection.path !== selectedFolder) setSelectedFolder(selection.path);
    const value = JSON.stringify(selection);
    if (profileStorage.getItem(key) !== value) profileStorage.setItem(key, value);
  }, [folders, selectedFolder, selectedProjectId, selectedProject, setSelectedFolder]);

  const scopedProvisionalImages = useMemo(() => {
    const projectId = selectedProjectId || null;
    const folder = selectedFolder || null;
    return provisionalImages.filter(
      (image) => image.projectId === projectId && image.folder === folder,
    );
  }, [provisionalImages, selectedFolder, selectedProjectId]);

  const provisionalStatusByPath = useMemo(() => {
    const next = new Map<string, ProjectGalleryProvisionalImage["status"]>();
    scopedProvisionalImages.forEach((image) => {
      const normalizedPath = normalizePath(image.path);
      if (!normalizedPath) return;
      next.set(normalizedPath, image.status);
    });
    return next;
  }, [normalizePath, scopedProvisionalImages]);

  const mergedImages = useMemo(
    () =>
      mergeProjectGalleryImagesWithProvisional(
        images,
        scopedProvisionalImages,
        normalizePath,
      ),
    [images, normalizePath, scopedProvisionalImages],
  );
  displayImagesRef.current = mergedImages;

  const selectionContext = useMemo<ProjectGallerySelectionContext>(
    () => ({
      projectId: selectedProjectId || null,
      folder: selectedFolder || null,
    }),
    [selectedFolder, selectedProjectId],
  );

  const pollMode = useMemo(() => {
    if (!selectedProjectId || !selectedFolder) {
      return "idle" as const;
    }
    if (scopedProvisionalImages.length > 0) {
      return "active_generation" as const;
    }
    if (recentSyncUntil > Date.now()) {
      return "recent_sync" as const;
    }
    return "idle" as const;
  }, [recentSyncUntil, scopedProvisionalImages.length, selectedFolder, selectedProjectId]);

  const applyImages = useCallback(
    (
      nextImages: FolderImage[],
      context: ProjectGallerySelectionContext = selectionContext,
    ) => {
      setImageView({ key: buildProjectGalleryViewKey(context.projectId, context.folder), images: nextImages, ready: true });
      writeProjectGalleryViewCache(
        context.projectId,
        context.folder,
        nextImages,
      );
      onImagesUpdateRef.current?.({
        projectId: context.projectId,
        folder: context.folder,
        images: nextImages,
      });
    },
    [selectionContext],
  );

  // Confirmed mutations supersede folder requests that began before them.
  const commitImages = useCallback(
    (
      nextImages: FolderImage[],
      context: ProjectGallerySelectionContext = selectionContext,
    ) => {
      requestSequenceRef.current += 1;
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
      loadingRequestIdRef.current = null;
      setIsLoading(false);
      applyImages(nextImages, context);
    },
    [applyImages, selectionContext],
  );

  useEffect(() => {
    if (!externalViewImages) return;

    const nextImages = Array.isArray(externalViewImages.images)
      ? externalViewImages.images
      : [];
    const externalContext = {
      projectId: externalViewImages.projectId ?? null,
      folder: externalViewImages.folder ?? null,
    };
    const currentContext = {
      projectId: selectedProjectId || null,
      folder: selectedFolder || null,
    };

    if (
      externalContext.projectId !== currentContext.projectId ||
      externalContext.folder !== currentContext.folder
    ) {
      writeProjectGalleryViewCache(
        externalContext.projectId,
        externalContext.folder,
        nextImages,
      );
      return;
    }

    const externalKey = buildProjectGalleryViewKey(externalContext.projectId, externalContext.folder);
    const explicitSync = externalViewImages.syncKey !== undefined && (
      externalSyncRef.current?.key !== externalKey ||
      externalSyncRef.current?.syncKey !== externalViewImages.syncKey
    );
    externalSyncRef.current = {key: externalKey, syncKey: externalViewImages.syncKey};
    const imagesMatch = areFolderImagesEquivalent(
      imagesRef.current,
      nextImages,
      normalizePath,
    );

    // Selecting a streamed card echoes the same visible rows through the
    // parent. That echo is not a completed read and must not cancel its tail.
    if (imagesMatch && !explicitSync) {
      return;
    }

    // Ignore stale in-flight fetches once a newer authoritative parent sync arrives.
    requestSequenceRef.current += 1;
    activeRequestAbortRef.current?.abort();
    activeRequestAbortRef.current = null;
    loadingRequestIdRef.current = null;
    setIsLoading(false);
    if (!imagesMatch) {
      commitImages(nextImages, externalContext);
    }
  }, [
    commitImages,
    externalViewImages,
    isLoading,
    normalizePath,
    selectedFolder,
    selectedProjectId,
  ]);

  useEffect(() => {
    const requestViewKey = buildProjectGalleryViewKey(
      selectedProjectId,
      selectedFolder,
    );
    const didViewChange = currentRequestViewKeyRef.current !== requestViewKey;
    currentRequestViewKeyRef.current = requestViewKey;

    if (didViewChange) {
      setNextMediaCursor(null);
      setMediaPageError("");
      setLoadingMore(false);
      loadedMediaPages.current = {
        key: requestViewKey,
        count: getScrollSnapshot(requestViewKey).mediaPageCount ?? 1,
      };
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
      const cached = readProjectGalleryViewCache(requestViewKey);
      setImageView({ key: requestViewKey, images: cached ?? [], ready: cached !== null });
      clearSelectionForViewChange();
      setRecentSyncUntil(0);
    }
  }, [clearSelectionForViewChange, selectedFolder, selectedProjectId]);

  useEffect(() => {
    const hadActiveGeneration = previousScopedProvisionalCountRef.current > 0;
    const hasActiveGeneration = scopedProvisionalImages.length > 0;
    previousScopedProvisionalCountRef.current = scopedProvisionalImages.length;

    if (hadActiveGeneration && !hasActiveGeneration) {
      setRecentSyncUntil(Date.now() + PROJECT_GALLERY_RECENT_SYNC_WINDOW_MS);
    }
  }, [scopedProvisionalImages.length]);

  useEffect(() => {
    if (recentSyncUntil <= Date.now()) {
      return;
    }

    const clearRecentSyncTimer = window.setTimeout(() => {
      setRecentSyncUntil(0);
    }, Math.max(recentSyncUntil - Date.now(), 0));

    return () => {
      window.clearTimeout(clearRecentSyncTimer);
    };
  }, [recentSyncUntil]);

  const refreshImages = useCallback(
    async ({ showLoading = true, cursor = null }: { showLoading?: boolean; cursor?:string|null } = {}) => {
      const context = {
        projectId: selectedProjectId || null,
        folder: selectedFolder || null,
      };

      if (!selectedProjectId || !selectedFolder) {
        activeRequestAbortRef.current?.abort();
        activeRequestAbortRef.current = null;
        loadingRequestIdRef.current = null;
        setIsLoading(false);
        applyImages([], context);
        return;
      }

      setMediaPageError("");
      if(cursor)setLoadingMore(true);
      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      activeRequestAbortRef.current?.abort();
      const abortController = new AbortController();
      activeRequestAbortRef.current = abortController;

      if (showLoading) {
        loadingRequestIdRef.current = requestId;
        setIsLoading(true);
      } else if (loadingRequestIdRef.current !== null) {
        loadingRequestIdRef.current = null;
        setIsLoading(false);
      }

      let publishedProgressive = false;
      try {
        // Revalidate the pages the creator was browsing, not just page one.
        // A page bound matters: remote pages may contain no supported media.
        const paged = parseMediaSelection(selectedFolder) !== null;
        const viewKey = buildProjectGalleryViewKey(selectedProjectId, selectedFolder);
        const savedPosition = getScrollSnapshot(viewKey);
        const previousPages = loadedMediaPages.current.key === viewKey
          ? loadedMediaPages.current.count : savedPosition.mediaPageCount ?? 1;
        const fetchedImages: FolderImage[] = [];
        let nextCursor = cursor;
        let pages = 0;
        let lastNonemptyPage = 0;
        do {
          const url = buildFolderImagesUrl(selectedProjectId, selectedFolder)
            + (nextCursor ? "&cursor=" + encodeURIComponent(nextCursor) : "");
          const response = await fetch(url, { cache: "no-store", signal: abortController.signal });
          if (!response.ok) {
            const details = await response.json().catch(() => null);
            throw new Error(typeof details?.detail === "string" ? details.detail : "Failed to fetch folder images");
          }
          const coldProgressive = !cursor && showLoading && imagesRef.current.length === 0;
          const fetchedPage = response.headers.get("content-type")?.includes("application/x-ndjson")
            ? await readFolderImageStream(response, partial => {
                if (abortController.signal.aborted || requestSequenceRef.current !== requestId) return false;
                if (coldProgressive && partial.length) {
                  publishedProgressive = true;
                  setImageView({
                    key: viewKey,
                    images: reconcileFolderImagesUsingRefreshedOrder([], partial, normalizePath),
                    ready: !savedPosition.anchorKey || partial.some(image => image.path === savedPosition.anchorKey),
                  });
                }
                return true;
              })
            : await response.json();
          if (fetchedPage === null) return;
          if (abortController.signal.aborted || requestSequenceRef.current !== requestId) return;
          const pageImages: FolderImage[] = Array.isArray(fetchedPage) ? fetchedPage : fetchedPage.items;
          fetchedImages.push(...pageImages);
          nextCursor = paged ? fetchedPage.next_cursor || null : null;
          pages += 1;
          if (pageImages.length) lastNonemptyPage = pages;
          // Cold paged folders can show first cards while the restored extent
          // is still loading. Never publish incomplete reads to the shared
          // cache/parent; only the full read can authoritatively remove media.
          if (!cursor && paged && showLoading && imagesRef.current.length === 0
              && fetchedImages.length > 0 && nextCursor) {
            setImageView({
              key: viewKey,
              images: reconcileFolderImagesUsingRefreshedOrder([], fetchedImages, normalizePath),
              // Do not consume a saved deep anchor before its page arrives.
              ready: !savedPosition.anchorKey ||
                fetchedImages.some(image => image.path === savedPosition.anchorKey),
            });
          }
          // One extra page catches new arrivals pushing the anchor past the old
          // boundary. A deleted anchor must never trigger a whole-source scan.
        } while (!cursor && nextCursor && (pages < previousPages || (
          pages === previousPages && savedPosition.anchorKey !== undefined
          && !fetchedImages.some(image => image.path === savedPosition.anchorKey)
        )));
        if (paged) {
          setNextMediaCursor(nextCursor);
          loadedMediaPages.current = {
            key: viewKey,
            count: cursor ? previousPages + pages : lastNonemptyPage || Math.min(pages, previousPages),
          };
        }
        const nextImages = reconcileFolderImagesUsingRefreshedOrder(
          imagesRef.current,
          cursor?[...imagesRef.current,...fetchedImages]:fetchedImages,
          normalizePath,
        );
        applyImages(nextImages, context);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        console.error("Failed to load folder images", error);
        if(requestSequenceRef.current===requestId)setMediaPageError(error instanceof Error?error.message:"Failed to load folder images");
        if (
          requestSequenceRef.current === requestId &&
          showLoading && !publishedProgressive &&
          imagesRef.current.length === 0
        ) {
          applyImages([], context);
        }
      } finally {
        if(requestSequenceRef.current===requestId)setLoadingMore(false);
        if (activeRequestAbortRef.current === abortController) {
          activeRequestAbortRef.current = null;
        }
        if (showLoading && loadingRequestIdRef.current === requestId) {
          loadingRequestIdRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [applyImages, normalizePath, selectedFolder, selectedProjectId],
  );

  useEffect(() => {
    return () => {
      activeRequestAbortRef.current?.abort();
      activeRequestAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    void refreshImages({
      showLoading: readProjectGalleryViewCache(currentViewKey) === null,
    });
  }, [currentViewKey, refreshImages]);

  useEffect(() => {
    if (refreshKey === lastRefreshKeyRef.current) {
      return;
    }
    lastRefreshKeyRef.current = refreshKey;
    void refreshImages({ showLoading: false });
  }, [refreshImages, refreshKey]);

  useEffect(() => {
    if (pollMode === "idle") {
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;

      const isHidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      const activeEl =
        typeof document !== "undefined" ? document.activeElement : null;
      const tagName = activeEl?.tagName?.toLowerCase();
      const isTyping =
        tagName === "input" ||
        tagName === "textarea" ||
        activeEl?.hasAttribute("contenteditable");

      if (!isHidden && !isCollapsed && !isTyping && loadedMediaPages.current.count===1) {
        await refreshImages({ showLoading: false });
      }

      if (!cancelled) {
        timeoutId = setTimeout(poll, PROJECT_GALLERY_POLL_INTERVAL_MS);
      }
    };

    timeoutId = setTimeout(poll, PROJECT_GALLERY_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isCollapsed, pollMode, refreshImages]);

  const galleryItems = useMemo(
    () => (selectedProjectId && mergedImages.length > 0 ? mergedImages : []),
    [mergedImages, selectedProjectId],
  );

  const emptyStateKind = useMemo(() => {
    if (!selectedProjectId) return "unselected" as const;
    // A failed or unresolved read cannot establish that the folder is empty.
    if (mediaPageError) return null;
    if (isLoading || !scrollRestorationReady) return "loading" as const;
    if (mergedImages.length === 0) return "empty" as const;
    return null;
  }, [isLoading, mediaPageError, mergedImages.length, scrollRestorationReady, selectedProjectId]);

  const viewerRawPath = useMemo(
    () => normalizePath(viewerImagePath),
    [normalizePath, viewerImagePath],
  );

  // The grid can unmount while this hook stays mounted (collapse/expand).
  // Read the latest snapshot on that render, not the first visit to this folder.
  const initialScrollPosition = getScrollSnapshot(currentViewKey);

  const handleScrollPosition = useCallback(
    (position: GalleryScrollPosition) => {
      if (mergedImages.length > 0) {
        const mediaPageCount = parseMediaSelection(selectedFolder)
          ? loadedMediaPages.current.key === currentViewKey
            ? loadedMediaPages.current.count : getScrollSnapshot(currentViewKey).mediaPageCount ?? 1
          : undefined;
        saveScrollSnapshot(currentViewKey, { ...position, mediaPageCount });
      }
    },
    [currentViewKey, mergedImages.length, selectedFolder],
  );

  return {
    commitImages,
    nextMediaCursor,mediaPageError,loadingMore,
    loadMoreMedia:()=>refreshImages({showLoading:false,cursor:nextMediaCursor}),
    currentViewKey,
    emptyStateKind,
    folders,
    galleryItems,
    handleScrollPosition,
    images,
    initialScrollPosition,
    scrollRestorationReady,
    isLoading,
    mergedImages,
    pollMode,
    provisionalStatusByPath,
    refreshImages,
    selectedProject,
    sortedProjects,
    viewerRawPath,
  };
}
