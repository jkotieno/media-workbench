/**
 * Gallery & Image types
 *
 * Types for images, gallery items, metadata, captions, and file browsing.
 */

import type { BackendOpenApiSchema } from "./openapi-schema.types";

type ImageReadSchema = BackendOpenApiSchema<"ImageRead">;

export type Image = Omit<
    ImageReadSchema,
    "media_revision" | "continuity_media_uuid" | "extra_metadata" | "format" | "is_deleted" | "is_kept" | "job_id" | "cloud_reference" | "availability" | "preview_available" | "original_pending"
> & {
    media_revision?: number;
    continuity_media_uuid?: string | null;
    format?: ImageReadSchema["format"];
    is_deleted?: ImageReadSchema["is_deleted"];
    is_kept?: ImageReadSchema["is_kept"];
    job_id?: ImageReadSchema["job_id"] | null;
    cloud_reference?: boolean;
    availability?: "original" | "preview_only" | "unavailable";
    preview_available?: boolean;
    original_pending?: ImageReadSchema["original_pending"];
    mtime?: string;
    tags?: string[];
    extra_metadata?: Record<string, unknown> | string | null;
};

type GalleryItemSchema = BackendOpenApiSchema<"GalleryItem">;

export type GalleryItem = Omit<
    GalleryItemSchema,
    "image" | "job_params" | "prompt_history"
> & {
    image: Image;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job_params: any;
    prompt_history?: Record<string, unknown>[];
    pipe_identity?: string | null;
    source_execution?: ImageSourceExecution | null;
    pipe_resolution?: ImagePipeResolution;
};

export type CaptionVersion = BackendOpenApiSchema<"CaptionVersionItem">;

export type ImageMetadataUpdate = BackendOpenApiSchema<"ImageMetadataUpdateResponse">;

export interface ImageParseSummary {
    source_used: string;
    checkpoint?: string | null;
    seed?: string | number | null;
    steps?: number | null;
    cfg?: number | null;
    sampler?: string | null;
    scheduler?: string | null;
    width?: number | null;
    height?: number | null;
    size?: string | null;
    prompt_present: boolean;
    negative_prompt_present: boolean;
    parameter_count: number;
}

export interface ImageWorkflowExtract {
    available: boolean;
    workflow_json?: Record<string, unknown> | null;
    graph?: Record<string, unknown> | null;
    fingerprint?: string | null;
    source_kind?: "comfyui_prompt" | "comfyui_workflow" | null;
}

export interface ImagePipeResolution {
    matched_workflow_template_id?: number | null;
    matched_workflow_name?: string | null;
    matched_pipe_id?: string | null;
    matched_via?: string | null;
    reason?: "matched" | "unmatched" | "ambiguous" | "identity_mismatch";
    sync_refresh_suggested?: boolean;
    ambiguous_matches?: Array<{
        workflow_template_id: number;
        workflow_name: string;
    }>;
}

/** Historical execution data travels with the image, independently of local row IDs. */
export interface ImageSourceExecution {
    version: 1;
    /** Decimal strings at these paths become integers again during Pipe import. */
    integer_paths?: string[];
    graph_json?: Record<string, unknown> | null;
    execution_graph?: Record<string, unknown> | null;
    input_schema?: Record<string, unknown> | null;
    node_mapping?: Record<string, unknown> | null;
    parameters?: Record<string, unknown> | null;
}

export interface ImageMetadataActions {
    can_import_workflow: boolean;
    can_open_pipe: boolean;
    can_create_pipe: boolean;
}

export interface ExecutionReceiptCost {
    kind: "actual";
    direction: "debit" | "credit";
    amount: number;
    unit: "buzz" | "comfy-credit" | "usd";
    variant?: "yellow" | "blue" | "green" | "red";
}

export interface ExecutionReceipt {
    schema: "sts.execution-receipt";
    schema_version: 1;
    provider: { id: string; label: string };
    operation: { id: string; label: string };
    transport: { kind: "comfy-node" | "api"; source_node_id: string };
    request: {
        id?: string;
        status: "estimated" | "submitted" | "running" | "succeeded" | "failed" | "canceled" | "refunded" | "partial";
    };
    capture: {
        status: "pending" | "complete" | "incomplete" | "failed";
        source: string;
    };
    estimate?: { amount: number; unit: "buzz" | "comfy-credit" | "usd" };
    costs: ExecutionReceiptCost[];
    artifacts: Array<{ output_index?: number; media_kind?: string }>;
    facts: Array<{
        key: string;
        label: string;
        value: string | number | boolean;
        value_type: string;
    }>;
}

export interface ImageMetadata {
    original_available?: boolean;
    environment?: GenerationEnvironment | null;
    path: string;
    image_id?: number;
    job_id?: number;
    workflow_template_id?: number | null;
    pipe_identity?: string | null;
    source_execution?: ImageSourceExecution | null;
    prompt?: string | null;
    negative_prompt?: string | null;
    caption?: string | null;
    caption_history?: CaptionVersion[];
    workflow?: unknown;
    parameters: Record<string, unknown>;
    job_params?: Record<string, unknown>;
    source: "sweet_tea" | "comfyui" | "comfyui_workflow" | "database" | "sidecar_json" | "comment" | "none";
    parse_summary?: ImageParseSummary;
    workflow_extract?: ImageWorkflowExtract;
    pipe_resolution?: ImagePipeResolution;
    actions?: ImageMetadataActions;
    execution_receipts?: ExecutionReceipt[];
}

export interface GenerationEnvironment {
    version: 1;
    execution_id: string | null;
    captured_at: string | null;
    observed_at: string | null;
    sources: string[];
    comfyui: { version: string | null; commit: string | null };
    runtime: { python: string | null; torch: string | null; cuda: string | null; cudnn: string | null };
    devices: Array<{ name: string | null; type: string | null; index: number | null; vram_total: number | null; driver: string | null }>;
    custom_node_packs: Array<{ repo: string | null; registry_id: string | null; commit: string | null; version: string | null; module: string | null; disabled: boolean; node_classes: string[] }>;
    unresolved_node_classes: string[];
}

export interface FileItem {
    name: string;
    path: string;
    type: "file" | "directory";
    is_root?: boolean;
}

export type FolderImage = Omit<BackendOpenApiSchema<"FolderImage">, "cloud_reference" | "preview_available"> & { cloud_reference?: boolean; preview_available?: boolean | null };

export interface GalleryQuery {
    search?: string;
    skip?: number;
    limit?: number;
    projectId?: number | null;
    folder?: string | null;
    unassignedOnly?: boolean;
    includeThumbnails?: boolean;
    includeParams?: boolean;
    imageIds?: number[];
}

export type CaptionResponse = BackendOpenApiSchema<"CaptionResponse">;
