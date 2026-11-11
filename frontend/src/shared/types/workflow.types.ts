import type { NodeExecutionEffects, ExecutionEffectsSummary } from "@/lib/executionEffects";
/**
 * Workflow & Pipe types
 *
 * Types for workflow templates, dependency checking, validation,
 * discovery/import, Tea packages, and model dependency resolution.
 */

import type { BackendOpenApiSchema } from "./openapi-schema.types";
import type { CanonicalResourceEnrichment } from "@/lib/resourcesRegistry";

export type WorkflowFormSection = "inputs" | "prompts" | "loras" | "nodes";

export interface WorkflowInputFieldAnnotation {
    section?: WorkflowFormSection;
    groupId?: string;
    groupTitle?: string;
    order?: number;
}

export interface WorkflowInputField {
    title?: string;
    default?: unknown;
    enum?: Array<string | number | boolean>;
    options?: unknown[];
    widget?: string;
    type?: string;
    minimum?: string | number;
    maximum?: string | number;
    step?: string | number;
    x_class_type?: string;
    x_form?: WorkflowInputFieldAnnotation;
    x_node_id?: string | number;
    x_title?: string;
    x_node_alias?: string;
    x_core?: boolean;
    x_media_kind?: string;
    x_tooltip?: string;
    tooltip?: string;
    description?: string;
    x_description?: string;
    help?: string;
    x_help?: string;
    __hidden?: boolean;
    x_compose_readonly?: boolean;
    x_skip_runtime_mapping?: boolean;
    x_compose_fed_by?: string;
    x_compose_fed?: boolean;
    x_compose_feeds_omega?: boolean;
    x_options?: unknown[];
    x_dynamic_options?: boolean;
    x_use_media_caption?: boolean;
    x_sts_codec?: Record<string, unknown>;
    x_sts_provider_resource?: {
        provider?: string;
        resource_kind?: string;
        ecosystem?: string;
        [key: string]: unknown;
    };
    x_sts_visibility?: {
        when?: {
            field?: string;
            op?: string;
            value?: unknown;
            values?: unknown[];
        };
        hidden_value?: "retain" | "clear";
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export type WorkflowInputFieldMap = Record<string, WorkflowInputField>;
export type WorkflowInputSchema = Record<string, unknown>;
export type WorkflowNodeMapping = Record<string, unknown>;

export interface WorkflowGraphNodeMeta extends Record<string, unknown> {
    title?: string;
    hiddenInControls?: boolean;
}

export interface WorkflowGraphPort extends Record<string, unknown> {
    name: string;
    type?: string;
}

export interface WorkflowGraphUiNode extends Record<string, unknown> {
    id: string | number;
    type?: string;
    title?: string;
    pos?: [number, number] | number[];
    inputs?: WorkflowGraphPort[];
    outputs?: WorkflowGraphPort[];
    properties?: Record<string, unknown>;
}

export type WorkflowGraphUiLink = [
    string | number,
    string | number,
    string | number,
    string | number,
    string | number,
    ...unknown[],
];

export interface WorkflowGraphNode extends Record<string, unknown> {
    class_type?: string;
    title?: string;
    inputs?: Record<string, unknown>;
    _meta?: WorkflowGraphNodeMeta;
}

export type WorkflowGraph = Record<string, WorkflowGraphNode | unknown> & {
    nodes?: WorkflowGraphUiNode[];
    links?: WorkflowGraphUiLink[];
};

type WorkflowTemplateReadSchema = BackendOpenApiSchema<"WorkflowTemplateRead">;

export type WorkflowTemplate = Omit<
    WorkflowTemplateReadSchema,
    "execution_runtime" | "execution_effects" | "graph_json" | "input_schema" | "node_mapping" | "created_at" | "updated_at" | "display_order"
> & {
    execution_runtime?: WorkflowTemplateReadSchema["execution_runtime"];
    graph_json: WorkflowGraph;
    execution_effects?: ExecutionEffectsSummary;
    input_schema: WorkflowInputSchema;
    node_mapping?: WorkflowNodeMapping | null;
    created_at?: WorkflowTemplateReadSchema["created_at"];
    updated_at?: WorkflowTemplateReadSchema["updated_at"];
    display_order?: WorkflowTemplateReadSchema["display_order"];
};

export type WorkflowTemplateCreate = Omit<
    BackendOpenApiSchema<"WorkflowTemplateCreate">,
    "graph_json" | "input_schema" | "node_mapping"
> & {
    graph_json: WorkflowGraph;
    input_schema: WorkflowInputSchema;
    node_mapping?: WorkflowNodeMapping | null;
};

export type WorkflowComposeFieldCandidate = BackendOpenApiSchema<"ComposeFieldCandidateResponse">;

export type WorkflowComposeBridgeCandidates = Omit<
    BackendOpenApiSchema<"ComposeBridgeCandidatesResponse">,
    "alpha_sources" | "omega_targets" | "compatible_targets_by_alpha"
> & {
    alpha_sources: WorkflowComposeFieldCandidate[];
    omega_targets: WorkflowComposeFieldCandidate[];
    compatible_targets_by_alpha: Record<string, string[]>;
};

export type WorkflowComposeCarryCandidates = Omit<
    BackendOpenApiSchema<"ComposeCarryCandidatesResponse">,
    "alpha_sources" | "omega_targets"
> & {
    alpha_sources: WorkflowComposeFieldCandidate[];
    omega_targets: WorkflowComposeFieldCandidate[];
};

export type WorkflowComposeCandidatesResponse = Omit<
    BackendOpenApiSchema<"WorkflowComposeCandidatesResponse">,
    "bridge" | "carry" | "errors"
> & {
    bridge: WorkflowComposeBridgeCandidates;
    carry: WorkflowComposeCarryCandidates;
    errors: string[];
};

// --- Comfy Workflow Discovery & Import ---

export type ComfyWorkflowDiscoveryItem = Omit<
    BackendOpenApiSchema<"ComfyWorkflowDiscoveryItem">,
    "source_refs" | "class_types" | "issues"
> & {
    source_refs: string[];
    class_types: string[];
    issues: string[];
};

export type ComfyWorkflowDiscoveryResponse = Omit<
    BackendOpenApiSchema<"ComfyWorkflowDiscoveryResponse">,
    "items"
> & {
    items: ComfyWorkflowDiscoveryItem[];
};

export type ComfyWorkflowDiscoveryRequest = Partial<
    BackendOpenApiSchema<"ComfyWorkflowDiscoveryRequest">
>;

export type ComfyWorkflowImportRequest = Omit<
    Partial<BackendOpenApiSchema<"ComfyWorkflowImportRequest">>,
    "candidate_ids"
> & {
    candidate_ids: string[];
};

export type ComfyWorkflowImportItem = BackendOpenApiSchema<"ComfyWorkflowImportItem">;

export type ComfyWorkflowImportResponse = Omit<
    BackendOpenApiSchema<"ComfyWorkflowImportResponse">,
    "items"
> & {
    items: ComfyWorkflowImportItem[];
};

export interface WorkflowExportBundle {
    workflow: WorkflowGraph;
    _sweet_tea: {
        version: number;
        name: string;
        description?: string | null;
        exported_at: string;
        input_schema: WorkflowInputSchema;
        node_mapping?: WorkflowNodeMapping;
        integrity: {
            graph_sha256: string;
            input_schema_sha256: string;
            bundle_sha256: string;
        };
        settings: {
            node_count: number;
            input_schema_count: number;
            node_mapping_count: number;
        };
        source: string;
        comfy_format: string;
        notes?: string;
    };
}

// --- Tea Package Dependencies ---

export interface TeaModelDependencyStatus {
    kind?: string | null;
    name?: string | null;
    air?: string | null;
    preferred_filename?: string | null;
    size_bytes?: number | null;
    required?: boolean;
    notes?: string | null;
    status?: string | null;
    found_path?: string | null;
}

export interface TeaCustomNodeDependencyStatus {
    repo?: string | null;
    source?: string | null;
    reference_url?: string | null;
    channel?: string | null;
    required?: boolean;
    status?: string | null;
    found_path?: string | null;
    why?: string | null;
}

export interface TeaDependencyStatus {
    ready: boolean;
    models: TeaModelDependencyStatus[];
    custom_nodes: TeaCustomNodeDependencyStatus[];
    missing_models: TeaModelDependencyStatus[];
    missing_custom_nodes: TeaCustomNodeDependencyStatus[];
}

export type TeaWorkflowStatus = Omit<
    BackendOpenApiSchema<"TeaWorkflowStatus">,
    "manifest" | "readiness"
> & {
    manifest?: Record<string, unknown> | null;
    readiness?: TeaDependencyStatus | null;
};

export type TeaImportResponse = Omit<
    BackendOpenApiSchema<"TeaImportResponse">,
    "workflow" | "status" | "warnings"
> & {
    workflow: WorkflowTemplate;
    status: TeaWorkflowStatus;
    warnings: string[];
};

export interface WorkflowNodeDocumentation {
    execution_effects?: NodeExecutionEffects | null;
    node_id: string;
    label?: string | null;
    class_type?: string | null;
    note: string;
}

export interface WorkflowStageDocumentation {
    description?: string | null;
    readme?: string | null;
}

export interface WorkflowDocumentation {
    execution_effects?: ExecutionEffectsSummary;
    workflow_id: number;
    updated_at?: string | null;
    description?: string | null;
    package_description?: string | null;
    readme?: string | null;
    node_explanations: Record<string, WorkflowNodeDocumentation>;
    stages: Record<string, WorkflowStageDocumentation>;
}

export type WorkflowComposeBridgeRequest = BackendOpenApiSchema<"WorkflowComposeBridgeRequest">;

export type WorkflowComposeCarryMappingRequest =
    BackendOpenApiSchema<"WorkflowComposeCarryMappingRequest">;

export type WorkflowComposeRequest = Omit<
    BackendOpenApiSchema<"WorkflowComposeRequest">,
    "bridge" | "carry_mappings"
> & {
    bridge?: WorkflowComposeBridgeRequest;
    carry_mappings?: WorkflowComposeCarryMappingRequest[];
};

export type WorkflowImportRequest = Omit<
    BackendOpenApiSchema<"WorkflowImportRequest">,
    "data"
> & {
    data: Record<string, unknown>;
};

// --- Dependency Resolution ---

export interface WorkflowMissingDependencyRepo {
    repo: string;
    reference_url?: string | null;
    github_url?: string | null;
    installable: boolean;
    verified: boolean;
    already_installed?: boolean;
    install_target?: string | null;
    unverified_install_target?: string | null;
    required: boolean;
    matched_nodes: string[];
    reason?: string | null;
    normalized_id?: string | null;
    source_type?: "registry" | "github" | "local" | "unknown";
    source_url?: string | null;
    source_access?: "requires_source" | null;
    registry_id?: string | null;
    confidence?: number | null;
    resolution_reason?: string | null;
    preferred_ref?: string | null;
    requested_version?: string | null;
    requested_pin?: string | null;
    version?: string | null;
    latest_version?: string | null;
    node_count?: number | null;
    size_bytes?: number | null;
    last_updated?: string | null;
}

export interface WorkflowUnknownNodeHint {
    class_type: string;
    inferred_repo?: string | null;
    installed?: boolean;
    source?: string | null;
}

export interface WorkflowDependencyCheck {
    meaning: string;
    deterministic: boolean;
    registry_loaded: boolean;
    registry_source?: string | null;
    missing_node_pack_count: number;
    missing_node_class_count: number;
    unknown_node_class_count: number;
    missing_node_packs: WorkflowMissingDependencyRepo[];
    missing_node_classes: string[];
    unknown_node_classes: string[];
    unknown_node_hints?: WorkflowUnknownNodeHint[];
    resolved_packs_registered?: WorkflowMissingDependencyRepo[];
    resolved_packs_unregistered_candidates?: WorkflowMissingDependencyRepo[];
    unresolved_nodes?: string[];
}

export interface WorkflowAmbiguousNode {
    node: string;
    reason?: string | null;
    recommended_reason?: string | null;
    recommended_candidate?: {
        repo?: string | null;
        reference_url?: string | null;
        github_url?: string | null;
        confidence?: number | null;
        registry_id?: string | null;
        verified?: boolean;
        source_type?: "registry" | "github" | "local" | "unknown";
        version?: string | null;
        latest_version?: string | null;
        node_count?: number | null;
        last_updated?: string | null;
        github_stars?: number | null;
        github_forks?: number | null;
        score?: number | null;
        covers_nodes?: string[] | null;
        coverage_count?: number | null;
        already_installed?: boolean;
    } | null;
    candidates: Array<{
        repo?: string | null;
        reference_url?: string | null;
        github_url?: string | null;
        confidence?: number | null;
        registry_id?: string | null;
        verified?: boolean;
        source_type?: "registry" | "github" | "local" | "unknown";
        installable?: boolean;
        reason?: string | null;
        version?: string | null;
        latest_version?: string | null;
        node_count?: number | null;
        last_updated?: string | null;
        github_stars?: number | null;
        github_forks?: number | null;
        score?: number | null;
        rank?: number | null;
        covers_nodes?: string[] | null;
        coverage_count?: number | null;
        already_installed?: boolean;
    }>;
}

export interface WorkflowNodeResolution {
    missing_nodes: string[];
    resolved_packs_registered: WorkflowMissingDependencyRepo[];
    resolved_packs_unregistered_candidates: WorkflowMissingDependencyRepo[];
    unresolved_nodes: string[];
    core_missing_nodes?: string[];
    ambiguous_nodes?: WorkflowAmbiguousNode[];
    node_classification_trace?: WorkflowNodeClassificationTrace[];
}

export interface WorkflowNodeClassificationTrace {
    class_type: string;
    status: string;
    reason?: string | null;
    candidate_repos?: string[];
    resource_match?: CanonicalResourceEnrichment | null;
}

export interface WorkflowMissingModelDependency {
    kind?: string | null;
    name?: string | null;
    preferred_filename?: string | null;
    air?: string | null;
    required?: boolean;
    notes?: string | null;
    status?: string | null;
    found_path?: string | null;
    reason?: string | null;
    canonical_id?: string | null;
    source_url?: string | null;
    source_access?: "requires_source" | null;
    hash?: string | null;
    candidate_ids?: string[];
    canonical_resource_id?: string | null;
    resource_match?: CanonicalResourceEnrichment | null;
}

export interface PipeDefinitionValidation {
    state: "passed" | "failed" | "unknown";
    checked_at: string;
    outdated?: boolean;
    structural: { state: string; issues: Array<{ code: string; node?: string; input?: string; message: string }> };
    catalog: { state: string; known_classes: string[]; unresolved_classes: string[] };
    installed_inventory: { state: string; checked_at?: string };
    runtime: { state: "not_checked"; reason: string };
}

export interface WorkflowRuntimeValidation {
    state: "passed" | "failed" | "execution_error" | "incompatible" | "passing" | "failing" | "warning" | "unknown";
    operational: boolean;
    checked_at: string;
    summary: string;
    execution_state?: "ran" | "error" | "skipped_preflight" | "not_run";
    scope?: string;
    validation_outcome?: "passed" | "failed" | "not_run" | "incompatible";
    missing_class_types: string[];
    missing_node_classes?: string[];
    missing_node_packs?: string[];
    unknown_node_classes?: string[];
    unknown_node_hints?: WorkflowUnknownNodeHint[];
    unresolved_manifest_repos: string[];
    incompatible_reasons?: string[];
    confidence: "high" | "medium" | "low";
    dependency_check?: WorkflowDependencyCheck | null;
}

export interface WorkflowDependencyStatus {
    graph_signature?: string;
    runtime_validation_cached_checked_at?: string | null;
    workflow_id: number;
    workflow_name: string;
    source_type: "tea_manifest" | "workflow_json";
    deterministic: boolean;
    manager_available: boolean;
    manager_install_hint?: string | null;
    comfy_root_path?: string | null;
    python_exe?: string | null;
    cm_cli_path?: string | null;
    registry_loaded: boolean;
    registry_source?: string | null;
    installed_repos_source?: string;
    installed_repos_count: number;
    required_repos_count: number;
    missing_repos: WorkflowMissingDependencyRepo[];
    unknown_nodes: string[];
    missing_nodes_raw?: string[];
    core_missing_nodes?: string[];
    resolved_packs_registered?: WorkflowMissingDependencyRepo[];
    resolved_packs_unregistered_candidates?: WorkflowMissingDependencyRepo[];
    unresolved_nodes?: string[];
    ambiguous_nodes?: WorkflowAmbiguousNode[];
    node_classification_trace?: WorkflowNodeClassificationTrace[];
    node_resolution?: WorkflowNodeResolution;
    model_resolution?: Record<string, unknown>;
    missing_models?: WorkflowMissingModelDependency[];
    unknown_models?: WorkflowMissingModelDependency[];
    ambiguous_models?: WorkflowMissingModelDependency[];
    not_missing_models?: WorkflowMissingModelDependency[];
    unknown_node_hints?: WorkflowUnknownNodeHint[];
    note?: string | null;
    runtime_validation?: WorkflowRuntimeValidation;
    definition_validation?: PipeDefinitionValidation | null;
    validation_state?: string;
    is_valid?: boolean;
    is_verified?: boolean;
    dependency_check?: WorkflowDependencyCheck | null;
    missing_node_packs?: string[];
    missing_node_classes?: string[];
    incompatible_reasons?: string[];
    validation_outdated?: boolean;
    validation_attempt_error?: string | null;
    validation_attempt_checked_at?: string | null;
    runtime_probe_error?: string | null;
    last_known_runtime_validation?: WorkflowRuntimeValidation;
    persisted_validation?: Record<string, unknown> | null;
    operational?: boolean;
}

export interface WorkflowValidationSummary {
    checked_at: string;
    total: number;
    passed: number;
    offline_checked?: number;
    failed: number;
    execution_error: number;
    incompatible: number;
    failed_workflow_ids: number[];
    execution_error_workflow_ids: number[];
    incompatible_workflow_ids: number[];
    // Backward-compatible aliases
    passing?: number;
    failing?: number;
    warning?: number;
    unknown?: number;
    warning_workflow_ids?: number[];
    error?: string;
}

// --- Dependency Install ---

export interface DependencyInstallJob {
    id: string;
    operation?: "install" | "rollback";
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    selected: Array<{ repo?: string | null; reference_url?: string | null }>;
    install_targets: string[];
    already_installed_targets?: string[];
    unverified_targets: string[];
    run_restore_dependencies: boolean;
    command: string[];
    created_at: string;
    started_at?: string | null;
    finished_at?: string | null;
    exit_code?: number | null;
    error?: string | null;
    error_code?: string | null;
    source_job_id?: string | null;
    rollback_available?: boolean;
    rollback_plan?: { uninstall: string[]; install: string[] };
    pre_install_snapshot?: string[];
    post_install_snapshot?: string[];
    revalidation_summary?: WorkflowValidationSummary | null;
}

export interface DependencyInstallLogLine {
    seq: number;
    ts: string;
    stream: "stdout" | "stderr" | "system";
    line: string;
}

// --- Missing Model Resolution ---

export interface MissingModelResolution {
    source_type?: string | null;
    source_url?: string | null;
    source_access?: "requires_source" | null;
    hash?: string | null;
    reason?: string | null;
    confidence?: number | null;
}

export interface MissingModelResolveItem {
    dependency_key: string;
    kind?: string | null;
    name?: string | null;
    preferred_filename?: string | null;
    display_name?: string | null;
    target_folder: string;
    recommended_target_folder: string;
    target_folder_error?: string | null;
    resolution?: MissingModelResolution | null;
    links?: {
        civitai_search?: string | null;
        huggingface_search?: string | null;
    };
}

export interface MissingModelResolveResponse {
    items: MissingModelResolveItem[];
}

export interface MissingModelInstallQueuedItem {
    dependency_key: string;
    display_name?: string | null;
    job_id: string;
    source_url: string;
    target_folder: string;
    resolution_reason?: string | null;
    resolution_confidence?: number | null;
}

export interface MissingModelInstallUnresolvedItem {
    dependency_key: string;
    display_name?: string | null;
    reason?: string | null;
    links?: {
        civitai_search?: string | null;
        huggingface_search?: string | null;
    };
}

export interface MissingModelInstallResponse {
    queued: MissingModelInstallQueuedItem[];
    unresolved: MissingModelInstallUnresolvedItem[];
    total_selected: number;
    queued_count: number;
    unresolved_count: number;
}

// --- Model Directories ---

export interface ModelDirectoryItem {
    name: string;
    path: string;
    type: "file" | "directory";
}

export interface ModelDirectorySummary {
    name: string;
    path: string;
    items: ModelDirectoryItem[];
}

export interface ModelDirectoriesResponse {
    root: string;
    folders: ModelDirectorySummary[];
}
