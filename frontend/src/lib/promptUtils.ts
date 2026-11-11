/** Prompt extraction from explicitly named semantic fields. */

import type {
    WorkflowInputField,
    WorkflowInputSchema,
} from "@/shared/types/workflow.types";
import {
    getWorkflowInputField,
    getWorkflowInputFieldEntries,
    isWorkflowInputField,
} from "@/shared/workflow/workflowStructure";

export interface PromptExtractionResult {
    positive: string | null;
    negative: string | null;
    /** The actual key in job_params where positive was found */
    positiveFieldKey: string | null;
    /** The actual key in job_params where negative was found */
    negativeFieldKey: string | null;
}

const POSITIVE_PROMPT_FIELD_KEYS = [
    "positive",
    "prompt",
    "text_positive",
    "active_positive",
] as const;
const NEGATIVE_PROMPT_FIELD_KEYS = [
    "negative_prompt",
    "negative",
    "text_negative",
    "clip_l_negative",
    "active_negative",
] as const;

/**
 * Extract positive and negative prompts from job_params object.
 * Anonymous text requires graph/schema context and must not be guessed here.
 */
export function extractPrompts(params: Record<string, unknown> | null | undefined): PromptExtractionResult {
    const result: PromptExtractionResult = {
        positive: null,
        negative: null,
        positiveFieldKey: null,
        negativeFieldKey: null,
    };

    if (!params || typeof params !== "object") {
        return result;
    }

    // A parameter name can establish polarity; node order cannot. Anonymous
    // text/string/value fields also contain model names and system instructions.
    const positiveKeys = new Set<string>([...POSITIVE_PROMPT_FIELD_KEYS, "positive_prompt"]);
    const negativeKeys = new Set<string>(NEGATIVE_PROMPT_FIELD_KEYS);
    for (const [key, value] of Object.entries(params)) {
        if (typeof value !== "string" || !value.trim()) continue;
        const leaf = key.split(".").slice(-1)[0].toLowerCase();
        if (positiveKeys.has(leaf) && !result.positive) {
            result.positive = value;
            result.positiveFieldKey = key;
        }
        if (negativeKeys.has(leaf) && !result.negative) {
            result.negative = value;
            result.negativeFieldKey = key;
        }
    }

    return result;
}

export interface ResolvedPrompts {
    positive: string;
    negative: string;
}

const pickFirstNonEmptyPrompt = (
    params: Record<string, unknown> | null | undefined,
    keys: readonly string[]
): string => {
    if (!params || typeof params !== "object") return "";
    for (const key of keys) {
        const value = params[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
};

export const normalizeResolvedPrompt = (value: string): string =>
    value.trim().replace(/\s+/g, " ");

export function resolvePromptsForGalleryItem(item: {
    prompt?: string | null;
    negative_prompt?: string | null;
    job_params?: Record<string, unknown> | null | undefined;
}): ResolvedPrompts {
    const positiveFromItem = typeof item.prompt === "string" ? item.prompt.trim() : "";
    const negativeFromItem = typeof item.negative_prompt === "string" ? item.negative_prompt.trim() : "";

    const extracted = extractPrompts(item.job_params);
    const positiveFromParams =
        pickFirstNonEmptyPrompt(item.job_params, POSITIVE_PROMPT_FIELD_KEYS) ||
        extracted.positive?.trim() ||
        "";
    const negativeFromParams =
        pickFirstNonEmptyPrompt(item.job_params, NEGATIVE_PROMPT_FIELD_KEYS) ||
        extracted.negative?.trim() ||
        "";

    let positive = positiveFromItem || positiveFromParams;
    let negative = negativeFromItem || negativeFromParams;

    const normalizedPositive = positive ? normalizeResolvedPrompt(positive) : "";
    const normalizedNegative = negative ? normalizeResolvedPrompt(negative) : "";
    const normalizedPositiveFromParams = positiveFromParams
        ? normalizeResolvedPrompt(positiveFromParams)
        : "";
    const normalizedNegativeFromParams = negativeFromParams
        ? normalizeResolvedPrompt(negativeFromParams)
        : "";

    if (
        normalizedPositive &&
        normalizedNegative &&
        normalizedPositive === normalizedNegative
    ) {
        if (normalizedNegativeFromParams && normalizedNegativeFromParams !== normalizedPositive) {
            negative = negativeFromParams;
        } else if (normalizedPositiveFromParams && normalizedPositiveFromParams !== normalizedNegative) {
            positive = positiveFromParams;
        }
    }

    return {
        positive,
        negative,
    };
}

export const isTextSchemaField = (
    field: WorkflowInputField | null | undefined
): boolean => {
    if (!field) return false;
    const widget = String(field.widget || "").toLowerCase();
    const type = String(field.type || "").toLowerCase();
    const hasStringEnum = Array.isArray(field.enum) && field.enum.length > 0;
    const hasDynamicOptions =
        Array.isArray(field.options) ||
        Array.isArray(field.x_options) ||
        Boolean(field.x_dynamic_options);
    const isDropdownWidget =
        widget === "select" ||
        widget === "dropdown" ||
        widget === "combo" ||
        widget === "multiselect";
    const isTextWidget = widget === "textarea" || widget === "text";
    const isStringType = type === "string" || type === "string_literal";

    return (
        (isTextWidget || (isStringType && !widget)) &&
        !hasStringEnum &&
        !hasDynamicOptions &&
        !isDropdownWidget
    );
};

export const isPromptSchemaField = (
    fieldKey: string,
    field: WorkflowInputField | null | undefined
): boolean => {
    if (!field) return false;
    const widget = String(field.widget || "").toLowerCase();
    const type = String(field.type || "").toLowerCase();
    const mediaKind = String(field.x_media_kind || "").toLowerCase();
    const keyLower = String(fieldKey || "").toLowerCase();

    if (
        widget === "media_upload" ||
        widget === "image_upload" ||
        widget === "upload"
    ) {
        return false;
    }
    if (mediaKind === "image" || mediaKind === "video") return false;
    if (type && type !== "string" && type !== "string_literal") return false;
    if (Array.isArray(field.enum) && field.enum.length > 0) return false;
    if (
        Array.isArray(field.options) ||
        Array.isArray(field.x_options) ||
        Boolean(field.x_dynamic_options)
    ) {
        return false;
    }
    if (
        widget === "select" ||
        widget === "dropdown" ||
        widget === "combo" ||
        widget === "multiselect"
    ) {
        return false;
    }
    if (widget && widget !== "text" && widget !== "textarea") return false;

    const titleLower = String(field.title || "").toLowerCase();
    const xTitleLower = String(field.x_title || "").toLowerCase();
    const aliasLower = String(field.x_node_alias || "").toLowerCase();
    const classLower = String(field.x_class_type || "").toLowerCase();
    const mockLower = String(field.mock_field || "").toLowerCase();
    const blob = `${keyLower} ${titleLower} ${xTitleLower} ${aliasLower} ${classLower} ${mockLower}`;

    const negativeContext = [
        "filename",
        "file_name",
        "filename_prefix",
        "save",
        "output",
        "folder",
        "directory",
        "path",
        "caption",
        "transcript",
        "subtitle",
    ];
    const positiveContext = ["positive", "negative", "prompt", "cliptextencode"];
    if (
        negativeContext.some((token) => blob.includes(token)) &&
        !positiveContext.some((token) => blob.includes(token))
    ) {
        return false;
    }

    if (classLower.includes("cliptextencode") || keyLower.includes("cliptextencode")) {
        return true;
    }
    if (
        classLower.includes("string literal") ||
        keyLower.includes("string literal") ||
        classLower.includes("string_literal") ||
        keyLower.includes("string_literal") ||
        classLower.includes("stringliteral") ||
        keyLower.includes("stringliteral")
    ) {
        return true;
    }
    if (/\b(positive|negative|prompt)\b/.test(blob)) return true;
    if (keyLower.endsWith(".prompt") || keyLower.endsWith("_prompt")) return true;
    if (
        (mockLower === "text" || mockLower === "prompt") &&
        (classLower.includes("clip") || classLower.includes("prompt"))
    ) {
        return true;
    }
    if (
        keyLower.endsWith(".text") &&
        (classLower.includes("clip") ||
            classLower.includes("prompt") ||
            classLower.includes("textencode") ||
            classLower.includes("string"))
    ) {
        return true;
    }
    return false;
};

/**
 * Find schema fields that match CLIPTextEncode text inputs.
 * Used to map extracted prompts to the correct form fields in a workflow.
 */
export function findPromptFieldsInSchema(
    schema: WorkflowInputSchema,
    nodeOrder?: string[]
): { positiveField: string | null; negativeField: string | null } {
    let positiveField: string | null = null;
    let negativeField: string | null = null;

    type PromptCandidate = {
        key: string;
        nodeId: string;
        title: string;
        xTitle: string;
        label: string;
    };

    const resolveNodeId = (
        key: string,
        field: WorkflowInputField
    ) => {
        if (field.x_node_id !== undefined && field.x_node_id !== null) {
            return String(field.x_node_id);
        }
        const nodeToken = String(key.split(".")[0] || "");
        const hashNodeId = nodeToken.match(/#(\d+)$/)?.[1];
        return hashNodeId || nodeToken;
    };

    const orderCandidates = <T extends { key: string; nodeId: string }>(items: T[]) => {
        return [...items].sort((a, b) => {
            const aIndex = nodeOrder ? nodeOrder.indexOf(String(a.nodeId)) : -1;
            const bIndex = nodeOrder ? nodeOrder.indexOf(String(b.nodeId)) : -1;
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            const aNum = parseInt(String(a.nodeId), 10);
            const bNum = parseInt(String(b.nodeId), 10);
            if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
            const nodeCmp = String(a.nodeId).localeCompare(String(b.nodeId));
            if (nodeCmp !== 0) return nodeCmp;
            return a.key.localeCompare(b.key);
        });
    };

    const collectPromptCandidates = (
        predicate: (key: string, field: WorkflowInputField) => boolean
    ): PromptCandidate[] =>
        getWorkflowInputFieldEntries(schema)
            .filter(([key, field]) => predicate(key, field))
            .map(([key, field]) => ({
                key,
                nodeId: resolveNodeId(key, field),
                title: String(field.title || ""),
                xTitle: String(field.x_title || ""),
                label: `${String(field.x_node_alias || "")} ${String(field.x_title || "")} ${String(field.title || "")} ${key}`.toLowerCase(),
            }));

    const assignByLabels = (candidates: PromptCandidate[]) => {
        for (const candidate of candidates) {
            if (!positiveField && /(positive|pos)[ _-]?(prompt|text)?/.test(candidate.label)) {
                positiveField = candidate.key;
            }
            if (!negativeField && /(negative|neg)[ _-]?(prompt|text)?/.test(candidate.label)) {
                negativeField = candidate.key;
            }
            if (positiveField && negativeField) break;
        }
    };

    const assignByOrder = (candidates: PromptCandidate[]) => {
        if (!positiveField && candidates.length >= 1) {
            positiveField = candidates.find((candidate) => candidate.key !== negativeField)?.key || null;
        }
        if (!negativeField && candidates.length >= 2) {
            negativeField = candidates.find((candidate) => candidate.key !== positiveField)?.key || null;
        }
    };

    const clipTextCandidates = orderCandidates(
        collectPromptCandidates((key) => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes("cliptextencode") && lowerKey.includes(".text");
        })
    );

    const fallbackStringCandidates = orderCandidates(
        collectPromptCandidates((key) => {
            const lowerKey = key.toLowerCase();
            return (
                lowerKey.includes("string_literal") ||
                (lowerKey.includes(".string") && !lowerKey.includes("lora"))
            );
        })
    );

    // Priority 1: explicit labels within CLIP text fields.
    assignByLabels(clipTextCandidates);
    // Priority 2: positional assignment within CLIP text fields.
    assignByOrder(clipTextCandidates);

    if (!positiveField || !negativeField) {
        // Only if CLIP fields were insufficient, widen the search to other
        // prompt-like string nodes.
        const widenedCandidates = orderCandidates([
            ...clipTextCandidates,
            ...fallbackStringCandidates.filter(
                (candidate) => !clipTextCandidates.some((clip) => clip.key === candidate.key)
            ),
        ]);
        assignByLabels(widenedCandidates);
        assignByOrder(widenedCandidates);
    }

    if (!positiveField || !negativeField) {
        const textCandidates = orderCandidates(
            collectPromptCandidates((_, field) => isTextSchemaField(field))
        );
        assignByLabels(textCandidates);
        assignByOrder(textCandidates);
    }

    if (positiveField && negativeField && positiveField === negativeField) {
        negativeField = null;
    }

    return { positiveField, negativeField };
}

export function findCaptionInputFieldInSchema(
    schema: WorkflowInputSchema,
    nodeOrder?: string[]
): string | null {
    const explicit = Object.entries(schema).find(([key, field]) => {
        if (key.startsWith("__")) return false;
        if (!isWorkflowInputField(field) || !isTextSchemaField(field)) return false;
        return field.x_use_media_caption === true;
    });
    if (explicit) return explicit[0];

    const textCandidates = getWorkflowInputFieldEntries(schema).filter(([_, field]) =>
        isTextSchemaField(field)
    );

    if (!textCandidates.length) return null;

    const sortByNodeOrder = <T extends { key: string; nodeId: string }>(items: T[]) => {
        if (!nodeOrder || nodeOrder.length === 0) return items;
        return [...items].sort((a, b) => {
            const aIndex = nodeOrder.indexOf(a.nodeId);
            const bIndex = nodeOrder.indexOf(b.nodeId);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return 0;
        });
    };

    const normalizedCandidates = sortByNodeOrder(
        textCandidates.map(([key, field]) => ({
            key,
            nodeId: String(field.x_node_id ?? key.split(".")[0] ?? ""),
            label: `${String(field.title || "")} ${key}`.toLowerCase(),
        }))
    );

    const captionNamed = normalizedCandidates.find((candidate) =>
        /\b(caption|description|image text)\b/.test(candidate.label)
    );
    if (captionNamed) return captionNamed.key;

    return null;
}

/**
 * Find schema fields that are image uploads (LoadImage nodes).
 * Used to map source images to the correct form fields in a workflow.
 */
export type MediaKind = "image" | "video" | "audio";

const resolveMediaKind = (field: { x_media_kind?: unknown }): MediaKind | null => {
    if (typeof field.x_media_kind !== "string") {
        return null;
    }
    const normalized = field.x_media_kind.toLowerCase();
    if (normalized === "image" || normalized === "video" || normalized === "audio") {
        return normalized;
    }
    return null;
};

export function findMediaFieldsInSchema(
    schema: WorkflowInputSchema,
    kind: MediaKind = "image",
    nodeOrder?: string[]
): string[] {
    const mediaFields: string[] = [];

    for (const [key, field] of getWorkflowInputFieldEntries(schema)) {

        const resolvedKind = resolveMediaKind(field);
        if (resolvedKind && resolvedKind !== kind) {
            continue;
        }

        const lowerKey = key.toLowerCase();
        const lowerTitle = String(field.title || "").toLowerCase();
        const lowerClass = String(field.x_class_type || "").toLowerCase();

        if (!resolvedKind && kind === "video" && !(lowerKey.endsWith(".video") && lowerClass.includes("loadvideo"))) {
            continue;
        }
        if (!resolvedKind && kind === "audio" && !(lowerKey.endsWith(".audio") && (lowerClass.includes("loadaudio") || lowerClass.includes("recordaudio")))) {
            continue;
        }

        const isMediaUpload =
            field.widget === "upload" ||
            field.widget === "image_upload" ||
            field.widget === "media_upload" ||
            lowerKey.includes("loadimage") ||
            lowerTitle.includes("loadimage") ||
            lowerClass.includes("loadimage") ||
            (lowerKey.endsWith(".video") && lowerClass.includes("loadvideo")) ||
            (lowerKey.endsWith(".audio") && (lowerClass.includes("loadaudio") || lowerClass.includes("recordaudio")));

        if (isMediaUpload) {
            mediaFields.push(key);
        }
    }

    // Sort by nodeOrder if provided (respects user-defined order from pipe editor)
    if (nodeOrder && nodeOrder.length > 0) {
        mediaFields.sort((a, b) => {
            const aNodeId = String(getWorkflowInputField(schema, a)?.x_node_id ?? "");
            const bNodeId = String(getWorkflowInputField(schema, b)?.x_node_id ?? "");
            const aIndex = nodeOrder.indexOf(aNodeId);
            const bIndex = nodeOrder.indexOf(bNodeId);
            // If both found in nodeOrder, sort by position
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            // If only one found, prioritize the one in nodeOrder
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            // Neither in nodeOrder, keep original order
            return 0;
        });
    }

    return mediaFields;
}

export function findImageFieldsInSchema(
    schema: WorkflowInputSchema,
    nodeOrder?: string[]
): string[] {
    return findMediaFieldsInSchema(schema, "image", nodeOrder);
}
