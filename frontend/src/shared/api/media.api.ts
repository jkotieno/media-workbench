import { getGlobalGalleryPage } from "./galleryPage.api";
import {mediaMutation} from "./mediaOperations";
import {getProfileStorageScope} from "@/lib/profileStorage";
import {recordMediaMutations} from "@/lib/mediaRevisions";
/**
 * Media, Gallery, and Folder API
 *
 * API methods for uploads, gallery CRUD, image metadata, captioning, VLM,
 * and project-folder image management.
 */

import { API_BASE, throwApiRequestError } from "./client";
import { useMediaRestorationStore } from "@/lib/stores/mediaRestorationStore";
import type {
    CaptionResponse,
    CaptionVersion,
    FileItem,
    FolderImage,
    GalleryResyncJobStatus,
    GalleryResyncResult,
    GalleryItem,
    GalleryQuery,
    ImageMetadata,
    ImageSourceExecution,
    ImageMetadataUpdate,
    ResyncPending,
    TransformMaskSaveResponse,
    WorkflowTemplate,
} from "@/shared/types";

export type DownloadImagesProgress = {
    phase: "downloading" | "complete";
    loadedBytes: number;
    totalBytes: number | null;
    percent: number | null;
};

type DownloadImagesOptions = {
    onProgress?: (progress: DownloadImagesProgress) => void;
};

export type MoveImagesOptions = {
    imagePaths?: string[];
    sourceProjectId?: number | null;
    sourceFolder?: string | null;
};

export type MoveImagesResult = {
    moved: number;
    failed: number[];
    failed_paths: string[];
    new_paths: Record<number, string>;
    moved_sources: Array<{
        image_id: number;
        source_path: string;
        destination_path: string;
    }>;
};

export type RenameImageResult = {
    image_id: number | null;
    filename: string;
    old_path: string;
    new_path: string;
    changed: boolean;
};

export const mediaApi = {
    resolveMediaReference: async (reference: { path?: string; mediaUuid?: string | null }, init?: RequestInit):
      Promise<{ path: string; media_uuid: string | null }> => {
        const query = new URLSearchParams();
        if (reference.mediaUuid) query.set("media_uuid", reference.mediaUuid);
        else if (reference.path) query.set("path", reference.path);
        const response = await fetch(API_BASE + "/gallery/image/reference?" + query, init);
        if (!response.ok) await throwApiRequestError(response, "This saved image is unavailable");
        return response.json();
    },
    // --- Files ---

    getFileTree: async (engineId?: number, path = "", projectId?: number): Promise<FileItem[]> => {
        let url = `${API_BASE}/files/tree?path=${encodeURIComponent(path)}`;
        if (engineId) url += `&engine_id=${engineId}`;
        if (projectId) url += `&project_id=${projectId}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch file tree");
        return res.json();
    },

    uploadFile: async (
        file: File,
        engineId?: number,
        projectSlug?: string,
        subfolder?: string,
        init?: RequestInit,
    ): Promise<{ filename: string; path: string; mime_type?: string; size_bytes?: number }> => {
        const formData = new FormData();
        formData.append("file", file);
        if (engineId) formData.append("engine_id", String(engineId));
        if (projectSlug) formData.append("project_slug", projectSlug);
        if (subfolder) formData.append("subfolder", subfolder);

        const res = await fetch(`${API_BASE}/files/upload`, {
            ...init,
            method: "POST",
            body: formData,
        });
        if (!res.ok) await throwApiRequestError(res, "Failed to upload file");
        return res.json();
    },

    saveMask: async (
        maskFile: File,
        sourcePath: string,
        options?: {
            engineId?: number;
            projectSlug?: string | null;
            subfolder?: string | null;
        },
    ): Promise<TransformMaskSaveResponse> => {
        const formData = new FormData();
        formData.append("file", maskFile);
        formData.append("source_path", sourcePath);
        if (options?.engineId) formData.append("engine_id", String(options.engineId));
        if (options?.projectSlug) formData.append("project_slug", options.projectSlug);
        if (options?.subfolder) formData.append("subfolder", options.subfolder);

        const res = await fetch(`${API_BASE}/files/save-mask`, {
            method: "POST",
            body: formData,
        });
        if (!res.ok) throw new Error("Failed to save mask");
        return res.json();
    },

    copyToInput: async (
        sourcePath: string, engineId?: number, projectSlug?: string, subfolder?: string,
        signal?: AbortSignal,
        expected?: {expectedSha256?: string; expectedMediaUuid?: string},
    ): Promise<{ filename: string; path: string; already_exists: boolean }> => {
        const formData = new FormData();
        formData.append("source_path", sourcePath);
        if (expected?.expectedSha256) formData.append("expected_sha256", expected.expectedSha256);
        if (expected?.expectedMediaUuid) formData.append("expected_media_uuid", expected.expectedMediaUuid);
        if (engineId) formData.append("engine_id", String(engineId));
        if (projectSlug) formData.append("project_slug", projectSlug);
        if (subfolder) formData.append("subfolder", subfolder);
        const send = () => fetch(API_BASE + "/files/copy-to-input", {method: "POST", body: formData, signal});
        let response = await send();
        const detail = response.status === 409 ? (await response.clone().json()).detail : null;
        if (detail?.code === "storage_original_downloading" && typeof detail.transfer_id === "string") {
            const deadline = Date.now() + 120_000;
            for (;;) {
                signal?.throwIfAborted();
                const transfer = await fetch(API_BASE + "/storage/transfers/" + encodeURIComponent(detail.transfer_id), {signal, cache: "no-store"});
                if (!transfer.ok) await throwApiRequestError(transfer, "Could not check the original download.");
                const state = await transfer.json();
                if (state.state === "completed") break;
                if (["failed", "cancelled", "interrupted"].includes(state.state)) throw new Error("The original could not be prepared. Check its transfer in Storage and try again.");
                if (Date.now() >= deadline) throw new Error("The original is still downloading. Its progress is saved in Storage; select it again when ready.");
                await new Promise<void>((resolve, reject) => {
                    const abort = () => {clearTimeout(timer); reject(new DOMException("Aborted", "AbortError"));};
                    const timer = setTimeout(() => {signal?.removeEventListener("abort", abort); resolve();}, 1000);
                    signal?.addEventListener("abort", abort, {once: true});
                    if (signal?.aborted) abort();
                });
            }
            response = await send();
        }
        if (detail?.code === "storage_original_downloading" && typeof detail.bridge_asset_id === "string") {
            const deadline = Date.now() + 120_000;
            while (response.status === 409) {
                const pending = (await response.clone().json()).detail;
                if (pending?.code !== "storage_original_downloading") break;
                signal?.throwIfAborted();
                if (Date.now() >= deadline) throw new Error("The machine is still preparing this input. Its progress is saved; select it again when ready.");
                await new Promise<void>((resolve, reject) => {
                    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
                    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 1000);
                    signal?.addEventListener("abort", abort, { once: true });
                    if (signal?.aborted) abort();
                });
                response = await send();
            }
        }
        if (!response.ok) await throwApiRequestError(response, "Failed to prepare this input.");
        return response.json();
    },

    // --- Gallery ---

    getGlobalGalleryPage,

    getGallery: async (
        searchOrSkip?: GalleryQuery | string | number,
        limit?: number,
        projectId?: number | null,
        unassignedOnly = false,
    ): Promise<GalleryItem[]> => {
        const params = new URLSearchParams();
        let usedNewParams = false;

        if (searchOrSkip && typeof searchOrSkip === "object") {
            usedNewParams = true;
            const query = searchOrSkip as GalleryQuery;
            if (query.search) params.append("search", query.search);
            if (query.skip !== undefined) params.append("skip", String(query.skip));
            if (query.limit !== undefined) params.append("limit", String(query.limit));
            if (query.projectId !== undefined && query.projectId !== null) {
                params.append("project_id", String(query.projectId));
            }
            if (query.folder) params.append("folder", query.folder);
            if (query.unassignedOnly) params.append("unassigned_only", "true");
            if (query.includeThumbnails !== undefined) {
                params.append("include_thumbnails", query.includeThumbnails ? "true" : "false");
            }
            if (query.includeParams !== undefined) {
                params.append("include_params", query.includeParams ? "true" : "false");
            }
            for (const imageId of query.imageIds ?? []) {
                params.append("image_ids", String(imageId));
            }
        } else {
            if (typeof searchOrSkip === "string") {
                if (searchOrSkip) params.append("search", searchOrSkip);
                params.append("skip", "0");
            } else {
                params.append("skip", String(searchOrSkip ?? 0));
            }
            if (limit !== undefined) {
                params.append("limit", String(limit));
            }
            if (projectId !== undefined && projectId !== null) {
                params.append("project_id", String(projectId));
            }
            if (unassignedOnly) {
                params.append("unassigned_only", "true");
            }
        }

        let res = await fetch(`${API_BASE}/gallery/?${params.toString()}`, { cache: "no-store" });
        if (!res.ok && usedNewParams && params.has("include_thumbnails")) {
            params.delete("include_thumbnails");
            res = await fetch(`${API_BASE}/gallery/?${params.toString()}`, { cache: "no-store" });
        }
        if (!res.ok) await throwApiRequestError(res, "Failed to fetch gallery");
        return res.json();
    },

    getResyncPending: async (): Promise<ResyncPending> => {
        const res = await fetch(`${API_BASE}/gallery/resync/pending`);
        if (!res.ok) throw new Error("Failed to fetch pending import count");
        return res.json();
    },

    resyncGalleryFromDisk: async (): Promise<GalleryResyncResult> => {
        const res = await fetch(`${API_BASE}/gallery/resync`, {
            method: "POST",
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || "Failed to resync images");
        }
        return res.json();
    },

    startGalleryResyncJob: async (): Promise<GalleryResyncJobStatus> => {
        const res = await fetch(`${API_BASE}/gallery/resync/jobs`, {
            method: "POST",
        });
        if (!res.ok) await throwApiRequestError(res, "Failed to start media scan");
        return res.json();
    },

    getActiveGalleryResyncJob: async (): Promise<GalleryResyncJobStatus | null> => {
        const res = await fetch(`${API_BASE}/gallery/resync/jobs/active`, {
            cache: "no-store",
        });
        if (!res.ok) await throwApiRequestError(res, "Failed to load media scan status");
        return res.json();
    },

    getGalleryResyncJob: async (jobId: string): Promise<GalleryResyncJobStatus> => {
        const res = await fetch(
            `${API_BASE}/gallery/resync/jobs/${encodeURIComponent(jobId)}`,
            { cache: "no-store" },
        );
        if (!res.ok) await throwApiRequestError(res, "Failed to load media scan status");
        return res.json();
    },

    cancelGalleryResyncJob: async (jobId: string): Promise<GalleryResyncJobStatus> => {
        const res = await fetch(
            `${API_BASE}/gallery/resync/jobs/${encodeURIComponent(jobId)}/cancel`,
            { method: "POST" },
        );
        if (!res.ok) await throwApiRequestError(res, "Failed to cancel media scan");
        return res.json();
    },

    bulkDeleteImages: async (imageIds: number[]): Promise<{ deleted: number; not_found: number[]; file_errors: number[]; deleted_ids?: number[] }> => {
        const requestScope = getProfileStorageScope();
        const res = await mediaMutation(`${API_BASE}/gallery/bulk_delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_ids: imageIds }),
        });
        if (!res.ok) await throwApiRequestError(res, "Failed to delete images");
        const result = await res.json();
        recordMediaMutations(result.deleted_ids ?? [], result.revisions, true, requestScope, result.media_uuids);
        useMediaRestorationStore.getState().forget((result.deleted_ids ?? []).map((id: number) => ({ id })));
        return result;
    },

    deleteImage: async (imageId: number): Promise<{ deleted: number; not_found: number[]; file_errors: number[]; deleted_ids?: number[] }> => {
        return mediaApi.bulkDeleteImages([imageId]);
    },

    deleteImageByPath: async (path: string): Promise<{ deleted: boolean; error?: string; image_id?:number; deleted_ids?:number[]; revisions?:Record<string,number> }> => {
        const requestScope=getProfileStorageScope();
        const res = await mediaMutation(`${API_BASE}/gallery/image/path/delete`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || "Failed to delete image");
        }
        const result = await res.json();
        recordMediaMutations(result.deleted_ids ?? [], result.revisions, true, requestScope, result.media_uuids);
        return result;
    },

    restoreImages: async (imageIds: number[]): Promise<{ restored: number; not_found: number[]; conflicts: number[]; file_errors: number[] }> => {
        const requestScope=getProfileStorageScope();
        const res = await mediaMutation(`${API_BASE}/gallery/restore`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_ids: imageIds }),
        });
        if (!res.ok) throw new Error("Failed to restore images");
        const result = await res.json();
        if (result.restored > 0) {
            recordMediaMutations(imageIds, result.revisions, false, requestScope, result.media_uuids);
            const failed = new Set<number>([...result.not_found, ...result.conflicts, ...result.file_errors]);
            useMediaRestorationStore.getState().record(imageIds.filter(id => !failed.has(id)).map(id => ({ id })));
        }
        return result;
    },

    moveImages: async (
        imageIds: number[],
        projectId: number,
        subfolder?: string,
        options?: MoveImagesOptions,
    ): Promise<MoveImagesResult> => {
        const res = await mediaMutation(`${API_BASE}/gallery/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                image_ids: imageIds,
                image_paths: options?.imagePaths || [],
                project_id: projectId,
                subfolder: subfolder || "output",
                source_project_id: options?.sourceProjectId ?? null,
                source_folder: options?.sourceFolder || null,
            }),
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            const detail = errorData.detail;
            const message =
                typeof detail === "string"
                    ? detail
                    : detail && typeof detail.message === "string"
                      ? detail.message
                      : "Failed to move images";
            throw new Error(message);
        }
        return res.json();
    },

    renameImage: async (imageId: number, newName: string): Promise<RenameImageResult> => {
        const res = await mediaMutation(`${API_BASE}/gallery/${imageId}/rename`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ new_name: newName }),
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            const detail = errorData.detail;
            const message =
                typeof detail === "string"
                    ? detail
                    : detail && typeof detail.message === "string"
                      ? detail.message
                      : "Failed to rename media";
            throw new Error(message);
        }
        return res.json();
    },

    renameImageByPath: async (path: string, newName: string): Promise<RenameImageResult> => {
        const res = await mediaMutation(`${API_BASE}/gallery/image/path/rename`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, new_name: newName }),
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            const detail = errorData.detail;
            const message =
                typeof detail === "string"
                    ? detail
                    : detail && typeof detail.message === "string"
                      ? detail.message
                      : "Failed to rename media";
            throw new Error(message);
        }
        return res.json();
    },

    updateImage: async (
        imageId: number,
        data: { caption?: string | null; source?: string },
    ): Promise<ImageMetadataUpdate> => {
        const res = await fetch(`${API_BASE}/gallery/${imageId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error("Failed to update image");
        return res.json();
    },

    updateImageMetadataByPath: async (
        path: string,
        data: { caption?: string | null; source?: string },
    ): Promise<ImageMetadataUpdate> => {
        const params = new URLSearchParams({ path });
        const res = await fetch(`${API_BASE}/gallery/image/path/metadata?${params.toString()}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error("Failed to update image metadata");
        return res.json();
    },

    getCaptionHistoryByImageId: async (imageId: number, limit = 50): Promise<CaptionVersion[]> => {
        const res = await fetch(`${API_BASE}/gallery/${imageId}/captions?limit=${limit}`);
        if (!res.ok) throw new Error("Failed to fetch caption history");
        return res.json();
    },

    getCaptionHistoryByPath: async (path: string, limit = 50): Promise<CaptionVersion[]> => {
        const params = new URLSearchParams({ path, limit: String(limit) });
        const res = await fetch(`${API_BASE}/gallery/image/path/captions?${params.toString()}`);
        if (!res.ok) throw new Error("Failed to fetch caption history");
        return res.json();
    },

    getImageMetadata: async (path: string, init?: RequestInit): Promise<ImageMetadata> => {
        const res = await fetch(`${API_BASE}/gallery/image/path/metadata?path=${encodeURIComponent(path)}`, init);
        if (!res.ok) await throwApiRequestError(res, "Failed to fetch image metadata");
        return res.json();
    },

    importImagePipe: async (
        payload: { source_execution: ImageSourceExecution; pipe_identity?: string | null; name?: string; require_exact_definition?: boolean },
        init?: RequestInit,
    ): Promise<{ workflow: WorkflowTemplate; reused: boolean }> => {
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        const res = await fetch(`${API_BASE}/gallery/image/import-pipe`, {
            ...init,
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
        if (!res.ok) await throwApiRequestError(res, "Failed to import the image's Pipe");
        return res.json();
    },

    inspectImageMetadata: async (file: File): Promise<ImageMetadata> => {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`${API_BASE}/gallery/image/inspect`, {
            method: "POST",
            body: formData,
        });
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            throw new Error(errorData.detail || "Failed to inspect image metadata");
        }
        return res.json();
    },

    keepImages: async (imageIds: number[], keep: boolean): Promise<{ status: string; count: number }> => {
        const res = await fetch(`${API_BASE}/gallery/keep`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_ids: imageIds, keep }),
        });
        if (!res.ok) throw new Error("Failed to update kept status");
        return res.json();
    },

    cleanupGallery: async (
        options?: { jobId?: number; projectId?: number | null; folder?: string | null; keepImageIds?: number[] },
    ): Promise<{ status: string; count: number; files_deleted: number; file_errors: number[]; soft_delete: boolean; deleted_ids: number[] }> => {
        const res = await fetch(`${API_BASE}/gallery/cleanup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                job_id: options?.jobId,
                project_id: options?.projectId,
                folder: options?.folder,
                keep_image_ids: options?.keepImageIds,
            }),
        });
        if (!res.ok) throw new Error("Failed to cleanup gallery");
        return res.json();
    },

    downloadImages: async (imageIds: number[], options?: DownloadImagesOptions): Promise<Blob> => {
        const res = await fetch(`${API_BASE}/gallery/download`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image_ids: imageIds }),
        });
        if (!res.ok) throw new Error("Failed to download images");
        const totalHeader = Number(res.headers.get("content-length"));
        const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
        const contentType = res.headers.get("content-type") || undefined;

        if (!res.body) {
            const blob = await res.blob();
            options?.onProgress?.({
                phase: "complete",
                loadedBytes: blob.size,
                totalBytes: blob.size || totalBytes,
                percent: 100,
            });
            return blob;
        }

        const reader = res.body.getReader();
        const chunks: ArrayBuffer[] = [];
        let loadedBytes = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const chunk = new ArrayBuffer(value.byteLength);
            new Uint8Array(chunk).set(value);
            chunks.push(chunk);
            loadedBytes += value.byteLength;
            options?.onProgress?.({
                phase: "downloading",
                loadedBytes,
                totalBytes,
                percent: totalBytes ? Math.min(100, (loadedBytes / totalBytes) * 100) : null,
            });
        }

        const blob = new Blob(chunks, { type: contentType });
        options?.onProgress?.({
            phase: "complete",
            loadedBytes,
            totalBytes: totalBytes ?? loadedBytes,
            percent: 100,
        });
        return blob;
    },

    // --- Captioning ---

    captionImage: async (file: File, imageId?: number): Promise<CaptionResponse> => {
        const formData = new FormData();
        formData.append("image", file);
        if (imageId) formData.append("image_id", String(imageId));

        const res = await fetch(`${API_BASE}/vlm/caption`, {
            method: "POST",
            body: formData,
        });
        if (!res.ok) throw new Error("Failed to caption image");
        return res.json();
    },

    // --- VLM/Captioning ---

    vlmHealth: async (): Promise<{ available: boolean; loaded?: boolean; backend?: string; model?: string; error?: string }> => {
        const res = await fetch(`${API_BASE}/vlm/health`);
        if (!res.ok) return { available: false, loaded: false };
        const data = await res.json();
        return {
            available: Boolean(data.loaded ?? data.available),
            loaded: Boolean(data.loaded ?? data.available),
            backend: data.backend,
            model: data.model_id ?? data.model,
            error: data.error,
        };
    },

    generateCaption: async (imageId: number): Promise<CaptionResponse> => {
        const res = await fetch(`${API_BASE}/vlm/caption/${imageId}`, { method: "POST" });
        if (!res.ok) throw new Error("Failed to generate caption");
        return res.json();
    },

    // --- Project Folder Images ---

    getProjectFolderImages: async (
        projectId: number,
        folderName: string,
        options?: { includeDimensions?: boolean; dimensionsSource?: "auto" | "db" | "file" },
    ): Promise<FolderImage[]> => {
        const params = new URLSearchParams();
        if (options?.includeDimensions === false) {
            params.append("include_dimensions", "false");
        }
        if (options?.dimensionsSource) {
            params.append("dimensions_source", options.dimensionsSource);
        }
        const qs = params.toString();
        const url = `${API_BASE}/projects/${projectId}/folder-images?folder_name=${encodeURIComponent(folderName)}${qs ? `&${qs}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to fetch folder images");
        return res.json();
    },

    deleteFolderImages: async (
        projectId: number,
        folderName: string,
        paths: string[],
    ): Promise<{
        deleted: number;
        errors: string[];
        soft_deleted: number;
        soft_deleted_ids: number[];
        deleted_paths?: string[];
        failed_paths?: string[];
        trash_paths?: string[];
    }> => {
        const res = await mediaMutation(`${API_BASE}/projects/${projectId}/folder-images/delete?folder_name=${encodeURIComponent(folderName)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths }),
        });
        if (!res.ok) throw new Error("Failed to delete folder images");
        return res.json();
    },
};
