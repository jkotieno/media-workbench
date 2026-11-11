import { api, type GalleryItem, type Image, type ImageMetadata, type ImageSourceExecution, type WorkflowTemplate } from "@/lib/api";
import { hasResolvedSeedValue, mergeJobParamsWithResolvedSeed } from "@/lib/metadataSeed";
import { resolvePromptsForGalleryItem } from "@/lib/promptUtils";

type MetadataBackedGalleryPayload = Pick<
  ImageMetadata,
  "prompt" | "negative_prompt" | "parameters" | "job_params" | "caption" |
  "workflow_template_id" | "pipe_resolution" | "pipe_identity" | "source_execution" | "workflow_extract"
>;

type MediaActionImageInput = Pick<Image, "path" | "filename"> &
  Partial<Pick<Image, "id" | "job_id" | "created_at">>;

type BuildMediaActionGalleryItemArgs = {
  image: MediaActionImageInput;
  metadata?: Partial<MetadataBackedGalleryPayload> | null;
  baseItem?: GalleryItem | null;
  workflowTemplateId?: number;
  defaultCreatedAt?: string;
  preserveExecutionParameters?: boolean;
};

type ResolveMediaActionGalleryItemArgs = {
  image: MediaActionImageInput;
  workflowTemplateId?: number;
  metadata?: Partial<MetadataBackedGalleryPayload> | null;
  metadataPath?: string;
  baseItem?: GalleryItem | null;
  defaultCreatedAt?: string;
  correlationId?: string;
  onMetadataError?: (error: unknown) => void;
  signal?: AbortSignal;
};

type HasResolvedTransferSourcePayloadOptions = {
  requireResolvedSeed?: boolean;
};

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const resolveGalleryItemWorkflowId = (item: GalleryItem | null | undefined): string => {
  if (!item) return "";
  const itemWorkflowId = item.workflow_template_id;
  if (typeof itemWorkflowId === "number" && Number.isFinite(itemWorkflowId)) {
    return String(itemWorkflowId);
  }
  if (itemWorkflowId === null) return "";
  const jobParams =
    item.job_params && typeof item.job_params === "object"
      ? (item.job_params as Record<string, unknown>)
      : {};
  const candidate = jobParams.workflow_template_id ?? jobParams.workflow_id;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return String(candidate);
  }
  if (hasNonEmptyString(candidate)) {
    return candidate.trim();
  }
  return "";
};

const hasMetadataPayload = (
  metadata?: Partial<MetadataBackedGalleryPayload> | null,
): metadata is Partial<MetadataBackedGalleryPayload> => {
  if (!metadata) return false;
  return (
    metadata.prompt !== undefined ||
    metadata.negative_prompt !== undefined ||
    metadata.parameters !== undefined ||
    metadata.job_params !== undefined ||
    metadata.caption !== undefined ||
    metadata.source_execution !== undefined ||
    metadata.pipe_resolution !== undefined ||
    metadata.workflow_template_id !== undefined
  );
};

export const buildGalleryItemJobParamsFromMetadata = (
  metadata: Partial<MetadataBackedGalleryPayload>,
): Record<string, unknown> => {
  const mergedParams = mergeJobParamsWithResolvedSeed(
    metadata.parameters,
    metadata.job_params,
  );
  const resolvedPrompts = resolvePromptsForGalleryItem({
    prompt: metadata.prompt ?? null,
    negative_prompt: metadata.negative_prompt ?? null,
    job_params: mergedParams,
  });

  return {
    ...mergedParams,
    ...(resolvedPrompts.positive
      ? {
          prompt: resolvedPrompts.positive,
          positive: resolvedPrompts.positive,
        }
      : {}),
    ...(resolvedPrompts.negative
      ? {
          negative_prompt: resolvedPrompts.negative,
          negative: resolvedPrompts.negative,
        }
      : {}),
    // Recorded execution values include hidden and bypassed fields. Never replace
    // them with currently displayed defaults or prompt aliases from other metadata.
    ...metadata.source_execution?.parameters,
  };
};

export const hasResolvedTransferSourcePayload = (
  item: GalleryItem | null | undefined,
  options: HasResolvedTransferSourcePayloadOptions = {},
): item is GalleryItem => {
  if (!item) return false;
  const jobParams =
    item.job_params && typeof item.job_params === "object"
      ? (item.job_params as Record<string, unknown>)
      : {};
  const hasPromptText =
    hasNonEmptyString(
      resolvePromptsForGalleryItem({
        prompt: item.prompt ?? null,
        negative_prompt: item.negative_prompt ?? null,
        job_params: jobParams,
      }).positive,
    );
  const hasRehydration =
    Boolean(jobParams.__st_prompt_rehydration) &&
    typeof jobParams.__st_prompt_rehydration === "object";

  if (resolveGalleryItemWorkflowId(item).length === 0) {
    return false;
  }
  if (!hasPromptText && !hasRehydration) {
    return false;
  }
  if (options.requireResolvedSeed) {
    return hasResolvedSeedValue(jobParams);
  }
  return true;
};

export const buildMediaActionGalleryItem = ({
  image,
  metadata,
  baseItem,
  workflowTemplateId,
  defaultCreatedAt,
  preserveExecutionParameters = false,
}: BuildMediaActionGalleryItemArgs): GalleryItem => {
  const safeMetadata = metadata ?? {};
  const baseJobParams =
    baseItem?.job_params && typeof baseItem.job_params === "object"
      ? (baseItem.job_params as Record<string, unknown>)
      : {};
  const metadataJobParams = preserveExecutionParameters
    ? { ...safeMetadata.parameters, ...safeMetadata.job_params, ...safeMetadata.source_execution?.parameters }
    : buildGalleryItemJobParamsFromMetadata(safeMetadata);
  const mergedJobParams = {
    ...baseJobParams,
    ...metadataJobParams,
  };
  const resolvedPrompts = resolvePromptsForGalleryItem({
    prompt: safeMetadata.prompt ?? baseItem?.prompt ?? null,
    negative_prompt: safeMetadata.negative_prompt ?? baseItem?.negative_prompt ?? null,
    job_params: mergedJobParams,
  });
  const baseImage = baseItem?.image;
  const resolvedCreatedAt =
    image.created_at ?? baseImage?.created_at ?? defaultCreatedAt ?? "";
  const hasResolvedWorkflowId = safeMetadata.workflow_template_id !== undefined;
  const hasPipeResolution = safeMetadata.pipe_resolution !== undefined;
  const resolvedWorkflowId = hasResolvedWorkflowId
    ? safeMetadata.workflow_template_id
    : hasPipeResolution
      ? safeMetadata.pipe_resolution?.matched_workflow_template_id ?? null
      : baseItem?.workflow_template_id ?? workflowTemplateId;
  if (hasResolvedWorkflowId || hasPipeResolution) {
    delete mergedJobParams.workflow_id;
    if (typeof resolvedWorkflowId === "number") {
      mergedJobParams.workflow_template_id = resolvedWorkflowId;
    } else {
      delete mergedJobParams.workflow_template_id;
    }
  }

  return {
    ...baseItem,
    image: {
      ...(baseImage ?? {}),
      ...image,
      id: baseImage?.id ?? image.id ?? -1,
      job_id: baseImage?.job_id ?? image.job_id ?? -1,
      path: image.path,
      filename: image.filename,
      created_at: resolvedCreatedAt,
    },
    job_params: mergedJobParams,
    prompt: resolvedPrompts.positive || undefined,
    negative_prompt: resolvedPrompts.negative || undefined,
    prompt_history: baseItem?.prompt_history ?? [],
    workflow_template_id: resolvedWorkflowId,
    source_execution: safeMetadata.source_execution !== undefined ? safeMetadata.source_execution : baseItem?.source_execution,
    pipe_identity: safeMetadata.pipe_identity !== undefined ? safeMetadata.pipe_identity : baseItem?.pipe_identity,
    pipe_resolution: safeMetadata.pipe_resolution ?? baseItem?.pipe_resolution,
    created_at: baseItem?.created_at ?? resolvedCreatedAt,
    caption: safeMetadata.caption ?? baseItem?.caption ?? undefined,
    prompt_tags: baseItem?.prompt_tags ?? [],
    prompt_name: baseItem?.prompt_name,
    collection_id: baseItem?.collection_id,
    project_id: baseItem?.project_id,
  };
};

export const resolveMediaActionGalleryItem = async ({
  image,
  workflowTemplateId,
  metadata,
  metadataPath,
  baseItem,
  defaultCreatedAt,
  correlationId,
  onMetadataError,
  signal,
}: ResolveMediaActionGalleryItemArgs): Promise<GalleryItem> => {
  if (hasMetadataPayload(metadata)) {
    return buildMediaActionGalleryItem({
      image,
      metadata,
      baseItem,
      workflowTemplateId,
      defaultCreatedAt,
    });
  }

  try {
    const resolvedMetadataPath = metadataPath ?? image.path;
    const requestInit: RequestInit | undefined = signal || correlationId
      ? {
          ...(signal ? { signal } : {}),
          ...(correlationId
            ? { headers: { "X-Request-Id": correlationId } }
            : {}),
        }
      : undefined;
    const fetchedMetadata = requestInit
      ? await api.getImageMetadata(resolvedMetadataPath, requestInit)
      : await api.getImageMetadata(resolvedMetadataPath);
    return buildMediaActionGalleryItem({
      image,
      metadata: fetchedMetadata,
      baseItem,
      workflowTemplateId,
      defaultCreatedAt,
    });
  } catch (error) {
    onMetadataError?.(error);
    throw error;
  }
};

type ResolveMediaRegenerationGalleryItemArgs = ResolveMediaActionGalleryItemArgs & {
  installedWorkflows?: ReadonlyArray<Pick<WorkflowTemplate, "id">>;
  refreshWorkflows?: () => Promise<unknown> | void;
  requireResolvedSeed?: boolean;
};

const imagePipeImportsInFlight = new Map<string, Promise<{ workflow: WorkflowTemplate; reused: boolean }>>();
const isGraph = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("The media transfer was cancelled", "AbortError");
};

const isRecoveredMediaRow = (image: Image): boolean => {
  let metadata: unknown = image.extra_metadata;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { return false; }
  }
  return Boolean(metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).recovered === true);
};

/** Regeneration resolves image provenance before choosing a Pipe. Embedded row IDs
 * are never a portable identity, and an unresolved image never uses the active Pipe. */
export const resolveMediaRegenerationGalleryItem = async ({
  installedWorkflows,
  refreshWorkflows,
  requireResolvedSeed = false,
  ...args
}: ResolveMediaRegenerationGalleryItemArgs): Promise<GalleryItem> => {
  throwIfAborted(args.signal);
  let metadata = args.metadata;
  // A naked numeric ID may have come from embedded metadata or a legacy caller.
  // Only the backend's resolution contract makes a preloaded metadata result usable.
  const hasAuthoritativeResolution = metadata?.pipe_resolution !== undefined;
  if (!hasAuthoritativeResolution) {
    try {
      metadata = await api.getImageMetadata(args.metadataPath ?? args.image.path, {
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.correlationId ? { headers: { "X-Request-Id": args.correlationId } } : {}),
      });
    } catch (error) {
      throwIfAborted(args.signal);
      args.onMetadataError?.(error);
      const localItem = args.baseItem;
      const portableResolution = localItem?.pipe_resolution;
      const hasVerifiedPortableResolution = portableResolution?.reason === "matched" &&
        (portableResolution.matched_via === "pipe_identity" || portableResolution.matched_via === "workflow_fingerprint") &&
        portableResolution.matched_workflow_template_id === localItem?.workflow_template_id;
      // This is only the existing local-job compatibility path. An imported file's
      // numeric job/workflow values do not establish a local database relationship.
      if (
        localItem && typeof localItem.image.job_id === "number" && localItem.image.job_id > 0 &&
        (!isRecoveredMediaRow(localItem.image) || hasVerifiedPortableResolution) &&
        typeof localItem.workflow_template_id === "number" &&
        installedWorkflows?.some((workflow) => workflow.id === localItem.workflow_template_id) &&
        hasResolvedTransferSourcePayload(localItem, { requireResolvedSeed })
      ) return localItem;
      throw error;
    }
  }
  throwIfAborted(args.signal);
  const resolvedItem = buildMediaActionGalleryItem({ ...args, metadata, preserveExecutionParameters: true });
  const resolution = metadata?.pipe_resolution;
  const isUnresolved = (resolution?.reason !== undefined && resolution.reason !== "matched") ||
    Boolean(resolution?.ambiguous_matches?.length);
  const candidateId = metadata?.workflow_template_id !== undefined
    ? metadata?.workflow_template_id
    : resolution?.matched_workflow_template_id;
  const matchedId = !isUnresolved && typeof candidateId === "number" && Number.isInteger(candidateId) && candidateId > 0
    ? candidateId : null;

  if (matchedId !== null) {
    if (installedWorkflows && !installedWorkflows.some((workflow) => workflow.id === matchedId)) {
      const workflows = await refreshWorkflows?.();
      if (!Array.isArray(workflows) || !workflows.some((workflow: Pick<WorkflowTemplate, "id">) => workflow.id === matchedId)) {
        throw new Error("The image's Pipe is installed, but the Pipe catalog has not loaded it yet. Try Regenerate again.");
      }
      throwIfAborted(args.signal);
    }
    return {
      ...resolvedItem,
      workflow_template_id: matchedId,
      job_params: { ...resolvedItem.job_params, workflow_template_id: matchedId },
    };
  }

  if (!refreshWorkflows) {
    throw new Error("The Pipe catalog is unavailable. Reopen Studio before regenerating this image.");
  }
  const imported = await importMediaMetadataPipe({
    metadata: { ...metadata, job_params: resolvedItem.job_params },
    name: `${args.image.filename.replace(/\.[^.]+$/, "")} Pipe`,
    correlationId: args.correlationId,
    signal: args.signal,
  });
  const workflows = await refreshWorkflows();
  if (!Array.isArray(workflows) || !workflows.some((workflow: Pick<WorkflowTemplate, "id">) => workflow.id === imported.workflow.id)) {
    throw new Error("The image's Pipe was imported, but the Pipe catalog has not loaded it yet. Try Regenerate again.");
  }
  throwIfAborted(args.signal);
  const jobParams = { ...resolvedItem.job_params, ...imported.source_execution.parameters, workflow_template_id: imported.workflow.id };
  delete jobParams.workflow_id;
  return {
    ...resolvedItem,
    ...imported.metadataUpdate,
    workflow_template_id: imported.workflow.id,
    job_params: jobParams,
  };
};


export type ImagePipeResolutionUpdate = Pick<ImageMetadata,
  "workflow_template_id" | "pipe_identity" | "source_execution" | "pipe_resolution"
>;

/** Shared by automatic regeneration and the explicit metadata Import Pipe action. */
export const importMediaMetadataPipe = async ({
  metadata,
  graph: fallbackGraph,
  name,
  correlationId,
  signal,
  requireExactDefinition = false,
}: {
  metadata?: Partial<MetadataBackedGalleryPayload> | null;
  graph?: Record<string, unknown> | null;
  name: string;
  correlationId?: string;
  signal?: AbortSignal;
  requireExactDefinition?: boolean;
}) => {
  throwIfAborted(signal);
  const historical = metadata?.source_execution;
  const graph = isGraph(historical?.graph_json) ? historical.graph_json
    : isGraph(historical?.execution_graph) ? historical.execution_graph
      : metadata?.workflow_extract?.graph ?? fallbackGraph;
  if (!isGraph(graph)) {
    throw new Error("This image has no recorded Pipe graph to regenerate. Its embedded workflow ID cannot identify a local Pipe.");
  }
  const sourceExecution: ImageSourceExecution = {
    version: 1,
    ...historical,
    graph_json: graph,
    input_schema: historical?.input_schema ?? {},
    parameters: historical?.parameters ?? { ...metadata?.parameters, ...metadata?.job_params },
  };
  const importPayload = { source_execution: sourceExecution, pipe_identity: metadata?.pipe_identity ?? null, name,
    ...(requireExactDefinition ? {require_exact_definition: true} : {}) };
  const importKey = JSON.stringify([
    importPayload.pipe_identity, graph, sourceExecution.input_schema, sourceExecution.node_mapping, requireExactDefinition,
  ]);
  let pendingImport = imagePipeImportsInFlight.get(importKey);
  if (!pendingImport) {
    // Once started, finish this idempotent import even if navigation cancels the
    // transfer. The transfer controller still prevents a stale navigation commit.
    pendingImport = api.importImagePipe(importPayload, correlationId
      ? { headers: { "X-Request-Id": correlationId } } : undefined);
    imagePipeImportsInFlight.set(importKey, pendingImport);
    const trackedImport = pendingImport;
    void pendingImport.finally(() => {
      if (imagePipeImportsInFlight.get(importKey) === trackedImport) imagePipeImportsInFlight.delete(importKey);
    }).catch(() => {});
  }
  const imported = await pendingImport;
  const localPipeIdentity = imported.workflow.input_schema.__tea_pipe_id;
  const metadataUpdate: ImagePipeResolutionUpdate = {
    workflow_template_id: imported.workflow.id,
    pipe_identity: importPayload.pipe_identity,
    source_execution: sourceExecution,
    pipe_resolution: {
      reason: "matched",
      matched_workflow_template_id: imported.workflow.id,
      matched_workflow_name: imported.workflow.name,
      matched_pipe_id: typeof localPipeIdentity === "string" ? localPipeIdentity : null,
      matched_via: importPayload.pipe_identity ? "pipe_identity" : "workflow_fingerprint",
      sync_refresh_suggested: false,
      ambiguous_matches: [],
    },
  };
  return { ...imported, source_execution: sourceExecution, metadataUpdate };
};

export const applyImagePipeResolutionToMetadata = (
  metadata: ImageMetadata,
  update: ImagePipeResolutionUpdate,
): ImageMetadata => {
  const jobParams: Record<string, unknown> = { ...metadata.job_params, workflow_template_id: update.workflow_template_id };
  const parameters: Record<string, unknown> = { ...metadata.parameters, workflow_template_id: update.workflow_template_id };
  delete jobParams.workflow_id;
  delete parameters.workflow_id;
  return {
    ...metadata,
    ...update,
    job_params: jobParams,
    parameters,
    actions: { can_import_workflow: true, can_open_pipe: true, can_create_pipe: false },
  };
};
