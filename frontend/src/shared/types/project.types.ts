/**
 * Project & Collection types
 *
 * Types for project management and legacy collections.
 */

import type { BackendOpenApiSchema } from "./openapi-schema.types";

export interface ProjectConfig {
    folders?: string[];
    storage_root_dir?: string | null;
    [key: string]: unknown;
}

type ProjectReadSchema = BackendOpenApiSchema<"ProjectRead">;

export type Project = Omit<ProjectReadSchema, "config_json" | "display_order"> & {
    config_json: ProjectConfig | null;
    display_order?: ProjectReadSchema["display_order"];
};

export type ProjectCreate = BackendOpenApiSchema<"ProjectCreate">;

export type ProjectStorageRoot = BackendOpenApiSchema<"StorageRootRead">;

export type ResyncPending = BackendOpenApiSchema<"ResyncPendingResult">;

export type GalleryResyncResult = {
    found: number;
    already_in_db: number;
    imported: number;
    updated: number;
    relinked: number;
    errors: number;
    scanned_folders: string[];
    cancelled: boolean;
    committed_batches: number;
};

export type GalleryResyncJobStatus = {
    job_id: string;
    source: string;
    status: "pending" | "running" | "completed" | "cancelled" | "failed";
    stage: string;
    found: number;
    already_in_db: number;
    imported: number;
    updated: number;
    relinked: number;
    errors: number;
    scanned_root_count: number;
    total_root_count: number;
    current_root: string | null;
    committed_batches: number;
    cancel_requested: boolean;
    error: string | null;
    result: GalleryResyncResult | null;
    created_at: number;
    updated_at: number;
};

export type ProjectTrashEntry = BackendOpenApiSchema<"ProjectTrashEntry">;

export type ProjectTrashRestoreResult = BackendOpenApiSchema<"ProjectTrashRestoreResult">;

// --- Collections (Legacy) ---

export type Collection = BackendOpenApiSchema<"CollectionRead">;

export type CollectionCreate = BackendOpenApiSchema<"CollectionCreate">;
