import React from "react";
import { createPortal } from "react-dom";
import { Download, FolderInput, GitBranch, Info, Pencil, PenTool, Plus, RotateCcw, Trash2, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MediaMetadataDialog } from "@/components/MediaMetadataDialog";
import { MediaTransferStatusMessage } from "@/components/MediaTransferStatusMessage";
import { DeferredTransformWorkspaceDialog } from "@/features/transform/DeferredTransformWorkspaceDialog";
import {
    buildMediaTransferCommandKey,
    isMediaTransferCommandPending,
    type MediaTransferState,
} from "@/lib/useMediaTransferController";
import type { TransformExportResponse, TransformWorkspaceLaunchPayload } from "@/shared/types";

import type {
    ProjectGalleryContextMenuState,
    ProjectGalleryContextSubmenu,
} from "./useProjectGalleryController";
import { useTranslation } from "react-i18next";
import { formatLocalizedNumber } from "@/i18n/format";

type ProjectGalleryWorkflowOption = {
    id: string | number;
    name: string;
};

type ProjectGalleryActionShellProps = {
    mergedImagesCount: number;
    selectedPaths: Set<string>;
    onAddSelectedToTray: () => void;
    onMoveSelected: () => void;
    onClearSelection: () => void;
    onBulkDelete: () => void;
    contextMenu: ProjectGalleryContextMenuState | null;
    contextMenuRef: React.RefObject<HTMLDivElement | null>;
    contextSubmenu: ProjectGalleryContextSubmenu | null;
    onDownload: () => void;
    onAddContextImageToTray: () => void;
    onMoveContextImage: () => void;
    onOpenMetadata: () => void;
    onOpenAncestry?: () => void;
    onOpenRename: () => void;
    onOpenTransformWorkspace: () => void;
    canDrawMask: boolean;
    transformActionLabel?: string;
    onHoverSubmenu: (menu: ProjectGalleryContextSubmenu) => void;
    onLeaveSubmenu: () => void;
    onRegenerateSelection?: (seedOption: "same" | "random") => boolean | void | Promise<boolean | void>;
    useInPipeWorkflows?: ProjectGalleryWorkflowOption[];
    onUseInPipeSelection?: (workflowId: string) => boolean | void | Promise<boolean | void>;
    mediaTransferState?: MediaTransferState;
    onDelete: () => void;
    transformWorkspaceOpen: boolean;
    transformLaunchPayload: TransformWorkspaceLaunchPayload | null;
    onTransformWorkspaceOpenChange: (open: boolean) => void;
    onTransformExported?: (response?: TransformExportResponse) => void | Promise<void>;
    metadataTargetPath: string | null;
    onMetadataDialogOpenChange: (open: boolean) => void;
};

export function ProjectGalleryActionShell({
    mergedImagesCount,
    selectedPaths,
    onAddSelectedToTray,
    onMoveSelected,
    onClearSelection,
    onBulkDelete,
    contextMenu,
    contextMenuRef,
    contextSubmenu,
    onDownload,
    onAddContextImageToTray,
    onMoveContextImage,
    onOpenMetadata,
    onOpenAncestry,
    onOpenRename,
    onOpenTransformWorkspace,
    canDrawMask,
    transformActionLabel,
    onHoverSubmenu,
    onLeaveSubmenu,
    onRegenerateSelection,
    useInPipeWorkflows = [],
    onUseInPipeSelection,
    mediaTransferState,
    onDelete,
    transformWorkspaceOpen,
    transformLaunchPayload,
    onTransformWorkspaceOpenChange,
    onTransformExported,
    metadataTargetPath,
    onMetadataDialogOpenChange,
}: ProjectGalleryActionShellProps) {
    const { t } = useTranslation("gallery");
    const selectedCount = selectedPaths.size;
    const showUseInPipe = Boolean(onUseInPipeSelection && useInPipeWorkflows.length > 0);
    const resolvedTransformActionLabel =
        transformActionLabel || t("viewer.transform");

    return (
        <>
            {!contextMenu && (
                <MediaTransferStatusMessage
                    className="border-b border-t-0 bg-muted/20"
                    showPending={
                        !mediaTransferState ||
                        mediaTransferState.phase === "idle" ||
                        mediaTransferState.action !== "regenerate"
                    }
                    state={mediaTransferState}
                    surface="project-gallery"
                />
            )}

            {mergedImagesCount > 0 && (
                <div className="flex-none p-3 border-t border-border/50 bg-background">
                    {selectedCount > 0 ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-nowrap items-center justify-between gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2 text-[11px] whitespace-nowrap"
                                    onClick={onAddSelectedToTray}
                                >
                                    <Plus className="h-4 w-4 mr-1" />
                                    {t("projectGallery.actions.add")}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 px-2 text-[11px] whitespace-nowrap"
                                    onClick={onMoveSelected}
                                >
                                    <FolderInput className="h-4 w-4 mr-1" />
                                    {t("projectGallery.actions.move")}
                                </Button>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    className="h-8 px-2 text-[11px] whitespace-nowrap"
                                    onClick={onBulkDelete}
                                >
                                    <Trash2 className="h-4 w-4 mr-1" />
                                    {t("projectGallery.actions.delete")}
                                </Button>
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                                <span>{t("projectGallery.actions.selected", {
                                    count: selectedCount,
                                    formattedCount: formatLocalizedNumber(selectedCount),
                                })}</span>
                                <button
                                    type="button"
                                    className="hover:text-foreground hover:underline"
                                    onClick={onClearSelection}
                                >
                                    {t("projectGallery.actions.clearSelection")}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center text-xs text-muted-foreground">
                            {t("projectGallery.actions.selectionHint")}
                        </div>
                    )}
                </div>
            )}

            {contextMenu && typeof document !== "undefined" && createPortal(
                <div
                    ref={contextMenuRef}
                    data-testid="project-gallery-context-menu"
                    className="fixed z-50 bg-popover border border-border/60 rounded-md shadow-lg py-1 min-w-[140px] text-popover-foreground"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                    onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                >
                    <button
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2 cursor-pointer"
                        onClick={onDownload}
                    >
                        <Download className="h-3 w-3" />
                        {t("projectGallery.actions.download")}
                    </button>

                    <button
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2 cursor-pointer"
                        onClick={onAddContextImageToTray}
                    >
                        <Plus className="h-3 w-3" />
                        {t("projectGallery.actions.addToTray")}
                    </button>

                    <button
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2 cursor-pointer"
                        onClick={onMoveContextImage}
                    >
                        <FolderInput className="h-3 w-3" />
                        {t("projectGallery.actions.move")}
                    </button>

                    <button
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2 cursor-pointer"
                        onClick={onOpenMetadata}
                    >
                        <Info className="h-3 w-3" />
                        {t("projectGallery.actions.metadata")}
                    </button>
                    {onOpenAncestry && <button type="button" className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2" onClick={onOpenAncestry}><GitBranch className="h-3 w-3" />Ancestry</button>}

                    <button
                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2 cursor-pointer"
                        onClick={onOpenRename}
                    >
                        <Pencil className="h-3 w-3" />
                        {t("projectGallery.actions.rename")}
                    </button>

                    {canDrawMask && (
                        <button
                            className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center gap-2 cursor-pointer"
                            onClick={onOpenTransformWorkspace}
                            disabled={isMediaTransferCommandPending(
                                mediaTransferState,
                                buildMediaTransferCommandKey("transform", contextMenu.image.path, "edit"),
                            )}
                        >
                            <PenTool className="h-3 w-3" />
                            {resolvedTransformActionLabel}
                        </button>
                    )}

                    {onRegenerateSelection && (
                        <div
                            className="relative"
                            onMouseEnter={() => onHoverSubmenu("regenerate")}
                            onMouseLeave={onLeaveSubmenu}
                        >
                            <div className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center justify-between cursor-pointer">
                                <span className="flex items-center gap-2">
                                    <RotateCcw className="h-3 w-3" />
                                    {t("projectGallery.actions.regenerate")}
                                </span>
                                <span className="text-[10px]">
                                    {contextMenu.submenuSide === "left" ? "◀" : "▶"}
                                </span>
                            </div>
                            <div
                                className={`absolute ${contextMenu.submenuSide === "left" ? "right-full pr-1 -mr-px" : "left-full pl-1 -ml-px"} ${contextMenu.submenuFlipUp ? "bottom-0" : "top-0"} ${contextSubmenu === "regenerate" ? "block" : "hidden"}`}
                                onMouseEnter={() => onHoverSubmenu("regenerate")}
                                onMouseLeave={onLeaveSubmenu}
                            >
                                <div className="bg-popover border border-border/60 rounded-md shadow-lg py-1 w-36">
                                    <button
                                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover cursor-pointer disabled:cursor-wait disabled:opacity-60"
                                        disabled={isMediaTransferCommandPending(
                                            mediaTransferState,
                                            buildMediaTransferCommandKey("regenerate", contextMenu.image.path, "same"),
                                        )}
                                        onClick={() => {
                                            void onRegenerateSelection("same");
                                        }}
                                    >
                                        {t("viewer.sameSeed")}
                                    </button>
                                    <button
                                        className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover cursor-pointer disabled:cursor-wait disabled:opacity-60"
                                        disabled={isMediaTransferCommandPending(
                                            mediaTransferState,
                                            buildMediaTransferCommandKey("regenerate", contextMenu.image.path, "random"),
                                        )}
                                        onClick={() => {
                                            void onRegenerateSelection("random");
                                        }}
                                    >
                                        {t("viewer.randomSeed")}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {showUseInPipe && (
                        <div
                            className="relative"
                            data-testid="project-gallery-context-use-in-pipe"
                            onMouseEnter={() => onHoverSubmenu("useInPipe")}
                            onMouseLeave={onLeaveSubmenu}
                        >
                            <div className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover flex items-center justify-between cursor-pointer">
                                <span className="flex items-center gap-2">
                                    <Workflow className="h-3 w-3" />
                                    {t("projectGallery.actions.useInPipe")}
                                </span>
                                <span className="text-[10px]">
                                    {contextMenu.submenuSide === "left" ? "◀" : "▶"}
                                </span>
                            </div>
                            <div
                                className={`absolute ${contextMenu.submenuSide === "left" ? "right-full pr-1 -mr-px" : "left-full pl-1 -ml-px"} ${contextMenu.submenuFlipUp ? "bottom-0" : "top-0"} ${contextSubmenu === "useInPipe" ? "block" : "hidden"}`}
                                data-testid="project-gallery-context-use-in-pipe-menu"
                                onMouseEnter={() => onHoverSubmenu("useInPipe")}
                                onMouseLeave={onLeaveSubmenu}
                            >
                                <div className="bg-popover border border-border/60 rounded-md shadow-lg py-1 w-40 max-h-48 overflow-y-auto">
                                    {useInPipeWorkflows.map((workflow) => (
                                        <button
                                            key={workflow.id}
                                            className="w-full px-3 py-1.5 text-left text-xs hover:bg-hover truncate cursor-pointer disabled:cursor-wait disabled:opacity-60"
                                            data-testid={`project-gallery-use-in-pipe-option-${workflow.id}`}
                                            disabled={isMediaTransferCommandPending(
                                                mediaTransferState,
                                                buildMediaTransferCommandKey(
                                                    "use-in-pipe",
                                                    contextMenu.image.path,
                                                    String(workflow.id),
                                                ),
                                            )}
                                            title={workflow.name}
                                            onClick={() => {
                                                void onUseInPipeSelection?.(String(workflow.id));
                                            }}
                                        >
                                            {workflow.name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    <MediaTransferStatusMessage
                        showPending={
                            !mediaTransferState ||
                            mediaTransferState.phase === "idle" ||
                            mediaTransferState.action !== "regenerate"
                        }
                        state={mediaTransferState}
                        sourcePath={contextMenu.image.path}
                        surface="project-gallery"
                    />

                    <div className="h-px bg-border/50 my-1" />
                    <button
                        className="w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10 flex items-center gap-2 cursor-pointer"
                        onClick={onDelete}
                    >
                        <Trash2 className="h-3 w-3" />
                        {t("projectGallery.actions.delete")}
                    </button>
                </div>,
                document.body,
            )}

            <DeferredTransformWorkspaceDialog
                open={transformWorkspaceOpen}
                onOpenChange={onTransformWorkspaceOpenChange}
                launchPayload={transformLaunchPayload}
                onExported={onTransformExported}
            />

            <MediaMetadataDialog
                open={metadataTargetPath !== null}
                onOpenChange={onMetadataDialogOpenChange}
                mediaPath={metadataTargetPath}
                imageId={null}
            />
        </>
    );
}
