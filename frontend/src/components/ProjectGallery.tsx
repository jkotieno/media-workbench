import { acquireProjectGalleryOriginal, resolveProjectGalleryOriginal } from "./projectGalleryOriginal";
import {ProjectFolderPicker} from "@/components/ProjectFolderPicker";
import { StudioPreview } from "@/components/StudioPreview";
import { buildGalleryThumbnailUrl } from "@/lib/galleryThumbnail";
import { useGalleryThumbnail } from "@/lib/useGalleryThumbnail";
import React, { useMemo, useCallback, useState } from "react";
import { api, Project, FolderImage, GalleryItem, IMAGE_API_BASE } from "@/lib/api";
import { reconcileFolderImagesUsingRefreshedOrder } from "@/lib/folderImages";
import { isAudioFile, isTransformableImageFile, isVideoFile } from "@/lib/media";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ImageIcon, Loader2, Music, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { VirtualGrid } from "@/components/VirtualGrid";
import { useMediaTrayStore } from "@/lib/stores/mediaTrayStore";
import { useAgentAccessStore } from "@/lib/stores/agentAccessStore";
import { agentMediaMutationMatchesView } from "@/lib/agentMediaMutations";
import { useGenerationCatalog } from "@/lib/GenerationContext";
import { workflowSupportsMediaInput } from "@/lib/workflowGraph";
import {
    hasResolvedTransferSourcePayload,
    resolveMediaActionGalleryItem,
    resolveMediaRegenerationGalleryItem,
} from "@/lib/mediaActionPayloads";
import {
    buildMediaTransferCommandKey,
    useMediaTransferController,
} from "@/lib/useMediaTransferController";
import { type ProjectGalleryProvisionalImage } from "@/lib/provisionalMedia";

import { ProjectGalleryActionShell } from "./ProjectGalleryActionShell";
import { DeferredAncestryOverlay as AncestryOverlay, type AncestryTarget } from "@/features/ancestry/DeferredAncestryOverlay";
import { MoveImagesDialog } from "./MoveImagesDialog";
import { RenameMediaDialog } from "./RenameMediaDialog";
import {
    deleteProjectGalleryFolderPaths,
    resolveProjectGalleryRemainingImages,
} from "./projectGalleryDelete";
import { useTransformActionLabel } from "@/features/transform/useTransformActionLabel";
import {
    normalizeProjectGalleryPath,
    type ProjectGallerySelectionContext,
    useProjectGalleryController,
} from "./useProjectGalleryController";
import { useProjectGalleryGenerationRefresh } from "./useProjectGalleryGenerationRefresh";
import type { TransformExportResponse, TransformWorkspaceLaunchPayload } from "@/shared/types";
import type { MoveImagesResult, RenameImageResult } from "@/shared/api/media.api";
import {
    mergeTransformExportedFolderImage,
} from "@/features/transform/transformExportGallery";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "@/i18n/format";

export { buildGalleryItemJobParamsFromMetadata } from "@/lib/mediaActionPayloads";

interface ProjectGalleryProps {
    projects: Project[];
    layout?: {
        className?: string;
        collapsed?: boolean;
        defaultCollapsed?: boolean;
        onCollapsedChange?: (collapsed: boolean) => void;
    };
    mediaActions?: {
        onSelectImage?: (
            imagePath: string,
            images: FolderImage[],
            selectionContext?: { projectId: string | null; folder: string | null }
        ) => void;
        onImagesUpdate?: (payload: { projectId: string | null; folder: string | null; images: FolderImage[] }) => void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workflows?: any[];
        onRegenerate?: (item: any, seedOption: 'same' | 'random') => void;
        onUseInPipe?: (payload: { workflowId: string; imagePath: string; galleryItem: GalleryItem }) => void;
        onDeleteStateChange?: (inFlight: boolean) => void;
        onBulkDelete?: (
            deletedPaths: string[],
            remainingImages: FolderImage[],
            deletedImageIds?: number[],
            trashPaths?: string[],
            selectionContext?: ProjectGallerySelectionContext,
        ) => void;
    };
    selection?: {
        externalSelection?: {
            projectId?: string | null;
            folder?: string | null;
            collapsed?: boolean;
        };
        externalSelectionKey?: number;
        refreshKey?: number;
        externalViewImages?: {
            projectId?: string | null;
            folder?: string | null;
            images: FolderImage[];
            syncKey?: number;
        };
        provisionalImages?: ProjectGalleryActionableProvisionalImage[];
        viewerImagePath?: string | null;
    };
    // Legacy compatibility aliases. Prefer grouped contracts above for new callers.
    className?: string;
    onSelectImage?: (
        imagePath: string,
        images: FolderImage[],
        selectionContext?: { projectId: string | null; folder: string | null }
    ) => void;
    onImagesUpdate?: (payload: { projectId: string | null; folder: string | null; images: FolderImage[] }) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflows?: any[];
    onRegenerate?: (item: any, seedOption: 'same' | 'random') => void;
    onUseInPipe?: (payload: { workflowId: string; imagePath: string; galleryItem: GalleryItem }) => void;
    onDeleteStateChange?: (inFlight: boolean) => void;
    onBulkDelete?: (
        deletedPaths: string[],
        remainingImages: FolderImage[],
        deletedImageIds?: number[],
        trashPaths?: string[],
        selectionContext?: ProjectGallerySelectionContext,
    ) => void;
    externalSelection?: {
        projectId?: string | null;
        folder?: string | null;
        collapsed?: boolean;
    };
    externalSelectionKey?: number;
    provisionalImages?: ProjectGalleryActionableProvisionalImage[];
    /** Path of image currently displayed in the viewer - used to highlight the active thumbnail */
    viewerImagePath?: string | null;
    collapsed?: boolean;
    defaultCollapsed?: boolean;
    onCollapsedChange?: (collapsed: boolean) => void;
}

const folderImageMediaId = (image: FolderImage): number | null => {
    const candidate = image as FolderImage & { id?: unknown; image_id?: unknown };
    const value = candidate.image_id ?? candidate.id;
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : null;
};

const buildMediaUrl = (path: string, mtime?: string) => {
    const params = new URLSearchParams({ path });
    if (mtime) params.append("v", mtime);
    return `${IMAGE_API_BASE}/gallery/image/path?${params.toString()}`;
};

type ProjectGalleryActionableProvisionalImage = ProjectGalleryProvisionalImage & {
    galleryItem?: GalleryItem | null;
};

// Memoized gallery item - only re-renders when its specific props change
interface GalleryItemCellProps {
    image: FolderImage;
    isSelected: boolean;
    /** True if this image is currently displayed in the viewer */
    isViewing: boolean;
    provisionalStatus?: ProjectGalleryProvisionalImage["status"] | null;
    onDragStart: (e: React.DragEvent, image: FolderImage) => void;
    onClick: (image: FolderImage, e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent, image: FolderImage) => void;
}

const GalleryItemCell = React.memo(function GalleryItemCell({
    image,
    isSelected,
    isViewing,
    provisionalStatus,
    onDragStart,
    onClick,
    onContextMenu,
}: GalleryItemCellProps) {
    const { t } = useTranslation("gallery");
    const [isHovering, setIsHovering] = React.useState(false);
    const isVideo = isVideoFile(image.path, image.filename);
    const isAudio = isAudioFile(image.path, image.filename);
    const mediaId = folderImageMediaId(image);
    const mediaUrl = useMemo(() => buildMediaUrl(image.path, image.mtime), [image.path, image.mtime]);
    const thumbnailUrl = useMemo(
        () => buildGalleryThumbnailUrl(image.path, image.mtime, mediaId),
        [image.path, image.mtime, mediaId],
    );
    const isProvisional = Boolean(provisionalStatus);
    const [thumbnailRef, thumbnailStatus] = useGalleryThumbnail(isProvisional ? mediaUrl : thumbnailUrl, !isAudio && !(isVideo && isHovering));

    const handleMouseEnter = React.useCallback(() => {
        if (isVideo) setIsHovering(true);
    }, [isVideo]);

    const handleMouseLeave = React.useCallback(() => {
        if (isVideo) setIsHovering(false);
    }, [isVideo]);

    const showVideo = isVideo && isHovering && !image.cloud_reference;

    return (
        <div
            data-project-media-path={image.path}
            tabIndex={-1}
            className={cn(
                "h-full w-full relative group cursor-pointer rounded overflow-hidden border transition-all",
                isSelected
                    ? "border-ring ring-2 ring-ring scale-[0.97]"
                    : isViewing
                        ? "border-gray-700 ring-2 ring-gray-700/60 dark:border-gray-300 dark:ring-gray-300/60"
                        : "border-border/60 hover:border-ring hover:shadow-sm"
            )}
            draggable
            onDragStart={(e) => onDragStart(e, image)}
            onClick={(e) => onClick(image, e)}
            onContextMenu={(e) => onContextMenu(e, image)}
            onMouseDown={(e) => {
                // Fallback for runtimes where native contextmenu is never emitted.
                if (e.button === 2) onContextMenu(e, image);
            }}
            onMouseEnter={isVideo ? handleMouseEnter : undefined}
            onMouseLeave={isVideo ? handleMouseLeave : undefined}
            title={`${image.filename}\n${t("projectGallery.actions.itemSelectionHint")}`}
        >
            {/* Selection indicator */}
            {isSelected && (
                <div className="absolute top-1 left-1 z-20 bg-primary text-primary-foreground rounded-full p-0.5">
                    <Check className="w-3 h-3" />
                </div>
            )}
            {isProvisional && (
                <div className="absolute top-1 right-1 z-20 inline-flex items-center gap-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[7px] font-semibold uppercase tracking-[0.08em] text-white">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    <span>{provisionalStatus}</span>
                </div>
            )}
            {image.cloud_reference && mediaId ? (
                <StudioPreview imageId={mediaId} filename={image.filename} available={image.preview_available ?? true} />
            ) : isVideo && showVideo ? (
                <video
                    src={mediaUrl}
                    poster={thumbnailUrl}
                    className="w-full h-full object-contain bg-black/50"
                    preload="metadata"
                    muted
                    playsInline
                    loop
                    autoPlay
                />
            ) : isAudio ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/30 p-2">
                    <Music className="h-7 w-7 text-muted-foreground" />
                    <audio
                        src={mediaUrl}
                        className="w-full"
                        controls
                        preload="metadata"
                        onClick={(event) => event.stopPropagation()}
                    />
                </div>
            ) : (
                <div className="relative h-full w-full bg-muted/15">
                    <img
                        ref={thumbnailRef}
                        alt={image.filename}
                        className={cn("h-full w-full object-contain bg-black/50", thumbnailStatus !== "ready" && "opacity-0")}
                        decoding="async"
                    />
                    {thumbnailStatus !== "ready" && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            {thumbnailStatus === "failed" ? (
                                <span className="px-2 text-center text-[9px] text-muted-foreground">Preview unavailable</span>
                            ) : (
                                <span className="h-5 w-5 animate-pulse rounded bg-muted/50" aria-hidden="true" />
                            )}
                        </div>
                    )}
                </div>
            )}
            <div className="absolute inset-x-0 bottom-0 bg-black/70 text-white text-[8px] p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="truncate">{image.filename}</div>
                {image.width && image.height && (
                    <div className="text-[7px] text-white/70">{image.width}×{image.height}</div>
                )}
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    // Custom comparison - only re-render if these specific props change
    return prevProps.image.path === nextProps.image.path &&
        prevProps.image.mtime === nextProps.image.mtime &&
        prevProps.image.cloud_reference === nextProps.image.cloud_reference &&
        prevProps.image.preview_available === nextProps.image.preview_available &&
        prevProps.isSelected === nextProps.isSelected &&
        prevProps.isViewing === nextProps.isViewing &&
        prevProps.provisionalStatus === nextProps.provisionalStatus;
});

export const ProjectGallery = React.memo(function ProjectGallery({
    projects,
    layout,
    mediaActions,
    selection,
    className,
    onSelectImage,
    onImagesUpdate,
    workflows,
    onRegenerate,
    onUseInPipe,
    onDeleteStateChange,
    onBulkDelete,
    externalSelection,
    externalSelectionKey,
    provisionalImages = [],
    viewerImagePath,
    collapsed: controlledCollapsed,
    defaultCollapsed,
    onCollapsedChange,
}: ProjectGalleryProps) {
    const generationCatalog = useGenerationCatalog();
    const { t } = useTranslation("gallery");
    const { t: tProjects } = useTranslation("projects");
    const resolvedClassName = layout?.className ?? className;
    const resolvedControlledCollapsed =
        layout?.collapsed ?? controlledCollapsed;
    const resolvedDefaultCollapsed =
        layout?.defaultCollapsed ?? defaultCollapsed;
    const resolvedOnCollapsedChange =
        layout?.onCollapsedChange ?? onCollapsedChange;
    const resolvedOnSelectImage =
        mediaActions?.onSelectImage ?? onSelectImage;
    const resolvedOnImagesUpdate =
        mediaActions?.onImagesUpdate ?? onImagesUpdate;
    const resolvedWorkflows = mediaActions?.workflows ?? workflows ?? [];
    const resolvedOnRegenerate =
        mediaActions?.onRegenerate ?? onRegenerate;
    const resolvedOnUseInPipe =
        mediaActions?.onUseInPipe ?? onUseInPipe;
    const resolvedOnDeleteStateChange =
        mediaActions?.onDeleteStateChange ?? onDeleteStateChange;
    const resolvedOnBulkDelete =
        mediaActions?.onBulkDelete ?? onBulkDelete;
    const resolvedExternalSelection =
        selection?.externalSelection ?? externalSelection;
    const resolvedExternalSelectionKey =
        selection?.externalSelectionKey ?? externalSelectionKey;
    const resolvedRefreshKey = selection?.refreshKey ?? 0;
    const resolvedExternalViewImages =
        selection?.externalViewImages;
    const resolvedProvisionalImages =
        selection?.provisionalImages ?? provisionalImages ?? [];
    const resolvedViewerImagePath =
        selection?.viewerImagePath ?? viewerImagePath;
    const galleryRefreshKey = useAgentAccessStore((state) => state.galleryRefreshKey);
    const mediaMutation = useAgentAccessStore((state) => state.mediaMutation);
    const addToMediaTray = useMediaTrayStore(useCallback((state) => state.addItems, []));
    const [transformWorkspaceOpen, setTransformWorkspaceOpen] = useState(false);
    const [transformLaunchPayload, setTransformLaunchPayload] =
        useState<TransformWorkspaceLaunchPayload | null>(null);
    const [moveDialogOpen, setMoveDialogOpen] = useState(false);
    const [moveTargets, setMoveTargets] = useState<{
        ids: number[]; paths: string[]; projectId: number | null; folder: string | null;
    }>({ ids: [], paths: [], projectId: null, folder: null });
    const [renameTarget, setRenameTarget] = useState<FolderImage | null>(null);
    const [ancestryTarget, setAncestryTarget] = useState<AncestryTarget | null>(null);
    const {
        run: runMediaTransfer,
        state: mediaTransferState,
    } = useMediaTransferController();
    const {
        commitImages,
        nextMediaCursor,mediaPageError,loadingMore,loadMoreMedia,
        contextMenu,
        contextMenuRef,
        contextSubmenu,
        currentViewKey,
        closeContextMenu,
        emptyStateKind,
        folders,
        galleryItems,
        getDisplayImages,
        handleContextMenu,
        handleDragStart,
        handleImageClick,
        handleScrollPosition,
        handleSubmenuEnter,
        handleSubmenuLeave,
        images,
        initialScrollPosition,
        scrollRestorationReady,
        isCollapsed,
        mergedImages,
        metadataTargetPath,
        provisionalStatusByPath,
        refreshImages,
        selectedFolder,
        selectedPaths,
        selectedProject,
        selectedProjectId,
        selectionContext,
        setCollapsed,
        setMetadataTargetPath,
        setSelectedFolder,
        setSelectedPaths,
        setSelectedProjectId,
        sortedProjects,
        viewerRawPath,
    } = useProjectGalleryController({
        projects,
        onSelectImage: resolvedOnSelectImage,
        onImagesUpdate: resolvedOnImagesUpdate,
        externalSelection: resolvedExternalSelection,
        externalSelectionKey: resolvedExternalSelectionKey,
        provisionalImages: resolvedProvisionalImages,
        viewerImagePath: resolvedViewerImagePath,
        externalViewImages: resolvedExternalViewImages,
        refreshKey: galleryRefreshKey + resolvedRefreshKey,
        controlledCollapsed: resolvedControlledCollapsed,
        defaultCollapsed: resolvedDefaultCollapsed,
        onCollapsedChange: resolvedOnCollapsedChange,
    });
    const currentContextMenuPathRef = React.useRef(contextMenu?.image.path ?? null);
    currentContextMenuPathRef.current = contextMenu?.image.path ?? null;
    const transferImage = contextMenu ? getDisplayImages().find(image => image.path === contextMenu.image.path) : null;
    const transferSourceIdentity = JSON.stringify([selectedProjectId, selectedFolder,
        contextMenu?.image.path, transferImage?.mtime, transferImage ? folderImageMediaId(transferImage) : null, Boolean(transferImage)]);
    const transferSourceIdentityRef = React.useRef(transferSourceIdentity);
    transferSourceIdentityRef.current = transferSourceIdentity;
    useProjectGalleryGenerationRefresh({
        refreshImages,
        selectedFolder,
        selectedProjectId,
    });
    const handledMediaMutationKeyRef = React.useRef(mediaMutation?.key ?? 0);
    React.useEffect(() => {
        if (!mediaMutation || handledMediaMutationKeyRef.current === mediaMutation.key) {
            return;
        }
        handledMediaMutationKeyRef.current = mediaMutation.key;
        const visibleMediaIds = galleryItems
            .map(folderImageMediaId)
            .filter((mediaId): mediaId is number => mediaId !== null);
        if (!agentMediaMutationMatchesView(mediaMutation, {
            mediaIds: visibleMediaIds,
            projectId: selectedProjectId,
            folder: selectedFolder,
        })) {
            return;
        }
        void refreshImages({ showLoading: false });
    }, [galleryItems, mediaMutation, refreshImages, selectedFolder, selectedProjectId]);
    const transformActionTargetPath =
        contextMenu && isTransformableImageFile(contextMenu.image.path, contextMenu.image.filename)
            ? contextMenu.image.path
            : null;
    const {
        transformActionLabel,
        refreshTransformActionLabel,
    } = useTransformActionLabel(transformActionTargetPath);

    const useInPipeWorkflows = useMemo(() => {
        if (!resolvedOnUseInPipe || resolvedWorkflows.length === 0 || !contextMenu) return [];
        const kind = isAudioFile(contextMenu.image.path, contextMenu.image.filename)
            ? "audio"
            : isVideoFile(contextMenu.image.path, contextMenu.image.filename)
              ? "video"
              : "image";
        return resolvedWorkflows.filter((w) => workflowSupportsMediaInput(w?.graph_json, kind));
    }, [contextMenu, resolvedOnUseInPipe, resolvedWorkflows]);
    const galleryEmptyState = React.useMemo(() => {
        if (emptyStateKind === "loading") {
            return (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            );
        }
        if (emptyStateKind === "unselected") {
            return (
                <div className="text-center py-8 text-xs text-muted-foreground">
                    <ImageIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <div>{t("projectGallery.browsePrompt")}</div>
                </div>
            );
        }
        if (emptyStateKind === "empty") {
            return (
                <div className="text-center py-8 text-xs text-muted-foreground">
                    <ImageIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <div>{t("projectGallery.emptyFolder")}</div>
                </div>
            );
        }
        return null;
    }, [emptyStateKind, t]);

    // Bulk delete handler
    const handleBulkDelete = async () => {
        if (selectedPaths.size === 0 || !selectedProjectId || !selectedFolder) return;
        if (!confirm(t("projectGallery.deleteConfirm", {
            count: formatLocalizedNumber(selectedPaths.size),
        }))) return;

        // Capture the paths to delete before any async operations
        // This prevents stale closure issues where selectedPaths might change during the await
        const pathsToDelete = new Set(selectedPaths);

        // Clear selection immediately for better UX
        setSelectedPaths(new Set<string>());

        resolvedOnDeleteStateChange?.(true);
        try {
            const {
                deletedPaths,
                failedPaths,
                softDeletedIds,
                trashPaths,
            } = await deleteProjectGalleryFolderPaths({
                projectId: parseInt(selectedProjectId, 10),
                folder: selectedFolder,
                paths: Array.from(pathsToDelete),
                normalizePath: normalizeProjectGalleryPath,
                deleteFolderImages: api.deleteFolderImages,
                onBulkDeleteError: (error) => {
                    console.warn("Project gallery bulk delete failed", error);
                },
            });

            if (deletedPaths.length > 0) {
                const remainingImages = resolveProjectGalleryRemainingImages({
                    images,
                    deletedPaths,
                    normalizePath: normalizeProjectGalleryPath,
                });
                commitImages(remainingImages);
                resolvedOnBulkDelete?.(
                    deletedPaths,
                    remainingImages,
                    softDeletedIds,
                    trashPaths,
                    selectionContext,
                );
            }
            if (failedPaths.length > 0) {
                setSelectedPaths(new Set<string>(failedPaths));
                alert(t("projectGallery.deleteFailed", {
                    count: failedPaths.length,
                    formattedCount: formatLocalizedNumber(failedPaths.length),
                }));
            }
        } catch (e) {
            console.error("Bulk delete failed", e);
            alert(t("projectGallery.deleteSomeFailed"));
            // Restore selection if delete failed
            setSelectedPaths(pathsToDelete);
        } finally {
            resolvedOnDeleteStateChange?.(false);
        }
    };

    const handleAddSelectedToTray = useCallback(() => {
        if (selectedPaths.size === 0) return;
        const toAdd = getDisplayImages()
            .filter((img) => selectedPaths.has(img.path))
            .map((img) => ({ path: img.path, filename: img.filename }));
        if (toAdd.length === 0) return;
        addToMediaTray(toAdd);
    }, [addToMediaTray, getDisplayImages, selectedPaths]);

    const handleAddContextImageToTray = useCallback(() => {
        if (!contextMenu) return;
        addToMediaTray({ path: contextMenu.image.path, filename: contextMenu.image.filename });
        closeContextMenu();
    }, [addToMediaTray, closeContextMenu, contextMenu]);

    const openMoveDialog = useCallback((targets: FolderImage[]) => {
        if (!selectedProjectId || !selectedFolder || targets.length === 0) return;
        const ids: number[] = [];
        const paths: string[] = [];
        for (const image of targets) {
            const id = folderImageMediaId(image);
            if (id !== null) ids.push(id);
            else paths.push(image.path);
        }
        setMoveTargets({ ids, paths, projectId: Number(selectedProjectId), folder: selectedFolder });
        setMoveDialogOpen(true);
        closeContextMenu();
    }, [closeContextMenu, selectedFolder, selectedProjectId]);

    const handleMoveSelected = useCallback(() => {
        const selectedImages = getDisplayImages().filter((image) => selectedPaths.has(image.path));
        openMoveDialog(selectedImages);
    }, [getDisplayImages, openMoveDialog, selectedPaths]);

    const handleMoveContextImage = useCallback(() => {
        if (!contextMenu) return;
        openMoveDialog([contextMenu.image]);
    }, [contextMenu, openMoveDialog]);

    const handleMoveComplete = useCallback(async (result: MoveImagesResult) => {
        if (result.moved <= 0) return;
        const failedPaths = new Set(result.failed_paths || []);
        setSelectedPaths(failedPaths);
        await refreshImages({ showLoading: false });
    }, [refreshImages, setSelectedPaths]);

    const handleOpenMetadata = useCallback(() => {
        if (!contextMenu) return;
        setMetadataTargetPath(contextMenu.image.path);
        closeContextMenu();
    }, [closeContextMenu, contextMenu, setMetadataTargetPath]);

    const handleOpenRename = useCallback(() => {
        if (!contextMenu) return;
        setRenameTarget(contextMenu.image);
        closeContextMenu();
    }, [closeContextMenu, contextMenu]);

    const handleRenamed = useCallback(async (result: RenameImageResult) => {
        setSelectedPaths((current) => {
            if (!current.has(result.old_path)) return current;
            const next = new Set(current);
            next.delete(result.old_path);
            next.add(result.new_path);
            return next;
        });
        await refreshImages({ showLoading: false });
        setRenameTarget(null);
    }, [refreshImages, setSelectedPaths]);

    const handleDownload = async () => {
        if (!contextMenu) return;
        const { image } = contextMenu;
        try {
            const url = buildMediaUrl(image.path, image.mtime);
            const res = await fetch(url);
            const blob = await res.blob();
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = image.filename;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (e) {
            console.error("Download failed", e);
        }
        closeContextMenu();
    };

    const openTransformForImage = useCallback((image: FolderImage, initialMode: "edit" | "mask" = "edit") => {
        if (!isTransformableImageFile(image.path, image.filename)) return;
        const launch = () => {
            setTransformLaunchPayload({
                imagePath: image.path,
                images: getDisplayImages()
                    .filter((candidate) => isTransformableImageFile(candidate.path, candidate.filename))
                    .map((candidate) => ({
                        path: candidate.path,
                        filename: candidate.filename,
                        mtime: candidate.mtime,
                        width: candidate.width ?? null,
                        height: candidate.height ?? null,
                    })),
                initialMode,
                workspaceProjectSlug: selectedProject?.slug ?? null,
                workspaceFolder: selectedFolder || null,
            });
            setTransformWorkspaceOpen(true);
            closeContextMenu();
        };
        if (!image.cloud_reference) {
            launch();
            return;
        }
        void runMediaTransfer({
            command: {
                action: "transform",
                commandKey: buildMediaTransferCommandKey("transform", image.path, initialMode),
                failureMessage: t("projectGallery.transformOriginalFailed", { defaultValue: "Could not download the original. Reconnect its source and choose Transform again." }),
                pendingMessage: t("projectGallery.transformOriginalPending", { defaultValue: "Downloading original for Transform…" }),
                sourcePath: image.path,
                surface: "project-gallery",
            },
            resolve: ({signal}) => acquireProjectGalleryOriginal(image, signal),
            commit: () => {
                if (transferSourceIdentityRef.current === transferSourceIdentity) launch();
            },
        });
    }, [closeContextMenu, getDisplayImages, runMediaTransfer, selectedFolder, selectedProject?.slug, t, transferSourceIdentity]);
    const handleTransformWorkspaceOpenChange = useCallback((nextOpen: boolean) => {
        setTransformWorkspaceOpen(nextOpen);
        if (!nextOpen) {
            void refreshTransformActionLabel(transformLaunchPayload?.imagePath ?? null);
        }
    }, [refreshTransformActionLabel, transformLaunchPayload?.imagePath]);

    const handleTransformExported = useCallback(async (response?: TransformExportResponse) => {
        if (!response?.path) {
            await refreshImages({ showLoading: false });
            return;
        }

        const targetProject =
            response.project_slug
                ? sortedProjects.find((project) => project.slug === response.project_slug)
                : selectedProject;
        const targetProjectId =
            targetProject?.id !== undefined && targetProject?.id !== null
                ? String(targetProject.id)
                : selectedProjectId || null;
        const targetFolder = response.folder || selectedFolder || null;
        const visibleProjectId = selectedProjectId || null;
        const visibleFolder = selectedFolder || null;
        const exportMatchesVisibleGallery =
            targetProjectId === visibleProjectId && targetFolder === visibleFolder;
        const withExportedImage = (nextImages: FolderImage[]) => {
            return mergeTransformExportedFolderImage(
                nextImages,
                response,
                normalizeProjectGalleryPath,
            );
        };

        let targetImages: FolderImage[] | null = null;
        if (targetProjectId && targetFolder) {
            const numericProjectId = Number.parseInt(targetProjectId, 10);
            if (Number.isFinite(numericProjectId)) {
                try {
                    const fetchedImages = await api.getProjectFolderImages(
                        numericProjectId,
                        targetFolder,
                        {
                            includeDimensions: false,
                        },
                    );
                    targetImages = withExportedImage(
                        exportMatchesVisibleGallery
                            ? reconcileFolderImagesUsingRefreshedOrder(
                                getDisplayImages(),
                                fetchedImages,
                                normalizeProjectGalleryPath,
                            )
                            : fetchedImages,
                    );
                } catch (error) {
                    console.warn("Failed to refresh transform export target folder", error);
                }
            }
        }

        if (exportMatchesVisibleGallery) {
            if (targetImages) {
                commitImages(targetImages, {
                    projectId: targetProjectId,
                    folder: targetFolder,
                });
            } else {
                await refreshImages({ showLoading: false });
            }
        }

        if (resolvedOnSelectImage) {
            resolvedOnSelectImage(
                response.path,
                targetImages ?? withExportedImage(getDisplayImages()),
                {
                    projectId: targetProjectId,
                    folder: targetFolder,
                },
            );
        }
    }, [
        commitImages,
        getDisplayImages,
        normalizeProjectGalleryPath,
        refreshImages,
        resolvedOnSelectImage,
        selectedFolder,
        selectedProject,
        selectedProjectId,
        sortedProjects,
    ]);

    const resolveContextMenuGalleryItem = useCallback((
        workflowTemplateId?: number,
        options?: { requireResolvedSeed?: boolean; regenerate?: boolean },
        signal?: AbortSignal,
        correlationId?: string,
    ) => {
        if (!contextMenu) return null;
        const normalizedPath = normalizeProjectGalleryPath(contextMenu.image.path);
        const provisionalGalleryItem = normalizedPath
            ? resolvedProvisionalImages.find(
                (image) =>
                    normalizeProjectGalleryPath(image.path) === normalizedPath,
            )?.galleryItem ?? null
            : null;
        if (!options?.regenerate && hasResolvedTransferSourcePayload(provisionalGalleryItem, options)) {
            return provisionalGalleryItem;
        }
        const resolveItem = options?.regenerate ? resolveMediaRegenerationGalleryItem : resolveMediaActionGalleryItem;
        return resolveItem({
            installedWorkflows: generationCatalog?.workflows ?? resolvedWorkflows,
            refreshWorkflows: generationCatalog?.refreshWorkflows,
            requireResolvedSeed: options?.requireResolvedSeed,
            image: {
                id: -1,
                job_id: -1,
                path: contextMenu.image.path,
                filename: contextMenu.image.filename,
                created_at: "",
            },
            baseItem: provisionalGalleryItem,
            correlationId,
            workflowTemplateId,
            signal,
        });
    }, [contextMenu, generationCatalog, resolvedProvisionalImages, resolvedWorkflows]);

    const handleRegenerateSelection = useCallback(async (seedOption: "same" | "random") => {
        if (!contextMenu || !resolvedOnRegenerate) return false;
        const sourceName = contextMenu.image.filename || t("thisImage");
        const sourcePath = contextMenu.image.path;
        const seedLabel = seedOption === "same"
            ? t("projectGallery.sameSeed")
            : t("projectGallery.randomSeed");
        const completed = await runMediaTransfer({
            command: {
                action: "regenerate",
                commandKey: buildMediaTransferCommandKey("regenerate", sourcePath, seedOption),
                failureMessage: t("projectGallery.regenerateFailed", { name: sourceName, seed: seedLabel }),
                pendingMessage: t("projectGallery.regeneratePending", { name: sourceName, seed: seedLabel }),
                sourcePath,
                surface: "project-gallery",
            },
            resolve: async ({ correlationId, signal }) => {
                const galleryItem = await resolveContextMenuGalleryItem(undefined, {
                    requireResolvedSeed: seedOption === "same",
                    regenerate: true,
                }, signal, correlationId);
                if (!galleryItem) throw new Error(t("projectGallery.imageUnavailable"));
                return galleryItem;
            },
            commit: (galleryItem) => {
                resolvedOnRegenerate(galleryItem, seedOption);
            },
        });
        if (completed && currentContextMenuPathRef.current === sourcePath) {
            closeContextMenu();
        }
        return completed;
    }, [closeContextMenu, contextMenu, resolveContextMenuGalleryItem, resolvedOnRegenerate, runMediaTransfer, t]);

    const handleUseInPipeSelection = useCallback(async (workflowId: string) => {
        if (!contextMenu || !resolvedOnUseInPipe) return false;
        const sourceName = contextMenu.image.filename || t("thisImage");
        const imagePath = contextMenu.image.path;
        const workflowName = useInPipeWorkflows.find((workflow) => String(workflow.id) === workflowId)?.name
            ?? t("projectGallery.pipeFallback", { id: workflowId });
        const completed = await runMediaTransfer({
            command: {
                action: "use-in-pipe",
                commandKey: buildMediaTransferCommandKey("use-in-pipe", imagePath, workflowId),
                failureMessage: t("projectGallery.useInPipeFailed", { name: sourceName, pipe: workflowName }),
                pendingMessage: t("projectGallery.useInPipePending", { name: sourceName, pipe: workflowName }),
                sourcePath: imagePath,
                surface: "project-gallery",
            },
            resolve: async ({ correlationId, signal }) => {
                const galleryItem = await resolveProjectGalleryOriginal(
                    contextMenu.image,
                    async () => resolveContextMenuGalleryItem(Number(workflowId), undefined, signal, correlationId),
                    signal,
                );
                if (!galleryItem) throw new Error(t("projectGallery.imageUnavailable"));
                const fallbackProjectId = selectedProjectId
                    ? Number.parseInt(selectedProjectId, 10)
                    : Number.NaN;
                return Number.isFinite(fallbackProjectId) && galleryItem.project_id == null
                    ? { ...galleryItem, project_id: fallbackProjectId }
                    : galleryItem;
            },
            commit: (galleryItem) => {
                if (transferSourceIdentityRef.current !== transferSourceIdentity) return;
                resolvedOnUseInPipe({
                    workflowId,
                    imagePath,
                    galleryItem,
                });
            },
        });
        if (completed && transferSourceIdentityRef.current === transferSourceIdentity && currentContextMenuPathRef.current === imagePath) {
            closeContextMenu();
        }
        return completed;
    }, [
        transferSourceIdentity,
        closeContextMenu,
        contextMenu,
        resolveContextMenuGalleryItem,
        resolvedOnUseInPipe,
        runMediaTransfer,
        selectedProjectId,
        t,
        useInPipeWorkflows,
    ]);

    const handleDelete = async () => {
        if (!contextMenu) return;
        const { image } = contextMenu;

        if (!confirm(t("projectGallery.deleteFileConfirm", { filename: image.filename }))) {
            closeContextMenu();
            return;
        }

        resolvedOnDeleteStateChange?.(true);
        try {
            // Find the next image to navigate to before deleting
            const displayImages = getDisplayImages();
            const normalizedTargetPath = normalizeProjectGalleryPath(image.path);
            const currentIdx = displayImages.findIndex(
                (img) => normalizeProjectGalleryPath(img.path) === normalizedTargetPath
            );
            let nextImage: FolderImage | null = null;
            if (displayImages.length > 1 && currentIdx !== -1) {
                if (currentIdx < displayImages.length - 1) {
                    nextImage = displayImages[currentIdx + 1];
                } else {
                    nextImage = displayImages[currentIdx - 1];
                }
            }

            let deletedImageIds: number[] = [];
            let trashPaths: string[] = [];

            if (!selectedProjectId || !selectedFolder) {
                throw new Error(t("projectGallery.folderRequired"));
            }

            const {
                deletedPaths,
                failedPaths,
                softDeletedIds,
                trashPaths: deletedTrashPaths,
            } = await deleteProjectGalleryFolderPaths({
                projectId: parseInt(selectedProjectId, 10),
                folder: selectedFolder,
                paths: [image.path],
                normalizePath: normalizeProjectGalleryPath,
                deleteFolderImages: api.deleteFolderImages,
                onBulkDeleteError: (error) => {
                    console.warn("Project folder delete failed", error);
                },
            });

            if (failedPaths.length > 0 || deletedPaths.length === 0) {
                throw new Error(t("projectGallery.folderDeleteFailed"));
            }
            deletedImageIds = softDeletedIds;
            trashPaths = deletedTrashPaths;

            const remainingImages = resolveProjectGalleryRemainingImages({
                images,
                deletedPaths,
                normalizePath: normalizeProjectGalleryPath,
            });
            commitImages(remainingImages);
            resolvedOnBulkDelete?.(
                deletedPaths,
                remainingImages,
                deletedImageIds,
                trashPaths,
                selectionContext,
            );

            // Navigate to next image after deletion
            if (nextImage && resolvedOnSelectImage) {
                resolvedOnSelectImage(
                    nextImage.path,
                    displayImages.filter((img) => normalizeProjectGalleryPath(img.path) !== normalizedTargetPath),
                    selectionContext
                );
            }
        } catch (e) {
            console.error("Delete failed", e);
            alert(t("errors.deleteOne"));
        } finally {
            resolvedOnDeleteStateChange?.(false);
        }
        closeContextMenu();
    };

    // If collapsed, just show a narrow bar
    if (isCollapsed) {
        return (
            <button
                type="button"
                className={cn("w-7 h-full flex flex-col items-center py-3 bg-surface cursor-pointer hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", resolvedClassName)}
                onClick={() => setCollapsed(false)}
                title={t("projectGallery.expand")}
                aria-label={t("projectGallery.expand")}
            >
                <ChevronLeft className="h-4 w-4 shrink-0" />
                <span className="mt-4 [writing-mode:vertical-rl] [text-orientation:mixed] text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground whitespace-nowrap rotate-180">
                    {t("projectGallery.title")}
                </span>
            </button>
        );
    }

    return (
        <div className={cn("flex w-full h-full flex-col bg-surface overflow-hidden", resolvedClassName)}>
            {/* Context/Header Section */}
            <div className="flex-none p-3 space-y-3 bg-muted/10">
                <div className="flex items-center justify-between mb-3">
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-1 shadow-xs">
                        <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/90">{t("projectGallery.title")}</span>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => setCollapsed(true)}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>

                {/* Project Selector */}
                <div className="space-y-2 rounded-lg border border-border/70 bg-surface-raised/50 p-2 shadow-xs">
                    <div className="space-y-1">
                        <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("projectGallery.project")}</label>
                        <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                            <SelectTrigger className="h-8 text-xs bg-background/80 dark:bg-surface/80 overflow-hidden">
                                <span className="flex min-w-0 flex-1 items-center gap-1">
                                    <span className={cn(
                                        "min-w-0 flex-1 truncate text-left leading-normal",
                                        (!selectedProjectId || !selectedProject) && "text-muted-foreground"
                                    )}>
                                        {selectedProject?.name || t("projectGallery.selectProject")}
                                    </span>
                                </span>
                            </SelectTrigger>
                            <SelectContent>
                                {sortedProjects.length === 0 ? (
                                    <SelectItem value="__empty" disabled>{t("projectGallery.noProjects")}</SelectItem>
                                ) : (
                                    sortedProjects.map((p) => (
                                        <SelectItem key={p.id} value={String(p.id)}>
                                            {p.name}
                                        </SelectItem>
                                    ))
                                )}
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Folder Selector */}
                    {selectedProjectId && (
                        <div className="space-y-1">
                            <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("projectGallery.folder")}</label>
                            <ProjectFolderPicker projectId={Number(selectedProjectId)} value={selectedFolder} folders={folders} onValueChange={setSelectedFolder} writableOnly={false} />
                        </div>
                    )}
                </div>
            </div>

            {/* Image Grid */}
            <VirtualGrid
                key={currentViewKey}
                items={galleryItems}
                columnCount={2}
                rowHeight={(columnWidth) => columnWidth}
                gap={4}
                padding={8}
                overscan={3}
                className="flex-1"
                initialScrollPosition={initialScrollPosition}
                scrollRestorationReady={scrollRestorationReady}
                restoreScrollKey={currentViewKey}
                onScrollPosition={handleScrollPosition}
                emptyState={galleryEmptyState}
                getKey={(image) => image.path}
                renderItem={(image) => (
                    <GalleryItemCell
                        image={image}
                        isSelected={selectedPaths.has(image.path)}
                        isViewing={!!viewerRawPath && normalizeProjectGalleryPath(image.path) === viewerRawPath}
                        provisionalStatus={provisionalStatusByPath.get(normalizeProjectGalleryPath(image.path)) ?? null}
                        onDragStart={handleDragStart}
                        onClick={handleImageClick}
                        onContextMenu={handleContextMenu}
                    />
                )}
            />

            {mediaPageError&&<div role="alert" className="shrink-0 px-3 py-2 text-xs text-destructive">{mediaPageError}<Button type="button" variant="ghost" size="sm" onClick={()=>void refreshImages()}>{tProjects("mediaSources.retry")}</Button></div>}
            {nextMediaCursor&&<Button type="button" variant="outline" size="sm" className="m-2 shrink-0" disabled={loadingMore} onClick={()=>void loadMoreMedia()}>{tProjects("folderBrowser.more")}</Button>}
            <ProjectGalleryActionShell
                mergedImagesCount={mergedImages.length}
                selectedPaths={selectedPaths}
                onAddSelectedToTray={handleAddSelectedToTray}
                onMoveSelected={handleMoveSelected}
                onClearSelection={() => setSelectedPaths(new Set<string>())}
                onBulkDelete={handleBulkDelete}
                contextMenu={contextMenu}
                contextMenuRef={contextMenuRef}
                contextSubmenu={contextSubmenu}
                onDownload={handleDownload}
                onAddContextImageToTray={handleAddContextImageToTray}
                onMoveContextImage={handleMoveContextImage}
                onOpenMetadata={handleOpenMetadata}
                onOpenAncestry={() => {
                    if (!contextMenu) return;
                    const path = contextMenu.image.path;
                    setAncestryTarget({ imageId: contextMenu.image.image_id, path, filename: contextMenu.image.filename, returnFocus: () => [...document.querySelectorAll<HTMLElement>("[data-project-media-path]")].find(element => element.dataset.projectMediaPath === path)?.focus({preventScroll: true}) });
                    closeContextMenu();
                }}
                onOpenRename={handleOpenRename}
                onOpenTransformWorkspace={() => {
                    if (!contextMenu) return;
                    openTransformForImage(contextMenu.image);
                }}
                canDrawMask={contextMenu ? isTransformableImageFile(contextMenu.image.path, contextMenu.image.filename) : false}
                transformActionLabel={transformActionLabel}
                onHoverSubmenu={handleSubmenuEnter}
                onLeaveSubmenu={handleSubmenuLeave}
                onRegenerateSelection={resolvedOnRegenerate ? handleRegenerateSelection : undefined}
                useInPipeWorkflows={useInPipeWorkflows}
                onUseInPipeSelection={resolvedOnUseInPipe ? handleUseInPipeSelection : undefined}
                mediaTransferState={mediaTransferState}
                onDelete={handleDelete}
                transformWorkspaceOpen={transformWorkspaceOpen}
                transformLaunchPayload={transformLaunchPayload}
                onTransformWorkspaceOpenChange={handleTransformWorkspaceOpenChange}
                onTransformExported={handleTransformExported}
                metadataTargetPath={metadataTargetPath}
                onMetadataDialogOpenChange={(nextOpen) => {
                    if (!nextOpen) setMetadataTargetPath(null);
                }}
            />
            {ancestryTarget && <AncestryOverlay key={ancestryTarget.imageId || ancestryTarget.path} target={ancestryTarget} onClose={() => setAncestryTarget(null)} />}
            <RenameMediaDialog
                open={renameTarget !== null}
                onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
                imageId={renameTarget ? folderImageMediaId(renameTarget) : null}
                path={renameTarget?.path ?? null}
                filename={renameTarget?.filename ?? null}
                onRenamed={handleRenamed}
            />
            <MoveImagesDialog
                open={moveDialogOpen}
                onOpenChange={setMoveDialogOpen}
                selectedImageIds={moveTargets.ids}
                selectedImagePaths={moveTargets.paths}
                projects={projects}
                currentProjectId={moveTargets.projectId}
                currentFolder={moveTargets.folder}
                onMoveComplete={handleMoveComplete}
                onMoveStateChange={resolvedOnDeleteStateChange}
            />
        </div>
    );
});
