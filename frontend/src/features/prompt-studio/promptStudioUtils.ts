import {
  type PromptItem,
  type PromptRehydrationItemV1,
  type PromptRehydrationItemV2,
  type PromptRehydrationSnapshot,
  type PromptRehydrationSnapshotV1,
  type PromptRehydrationSnapshotV2,
} from "@/lib/types";
import {
  loadPromptRehydrationSnapshot,
  savePromptRehydrationSnapshot,
} from "@/lib/persistedState";
import { normalizeSnippetLabel } from "@/lib/snippetLabels";
import { findEquivalentPromptFieldKey } from "@/features/prompt-studio/promptFieldKeyEquivalence";
import {
  compileItemsToPrompt,
  getPromptFieldKeys,
  normalizePrompt,
} from "@/features/prompt-studio/promptSessionEngine";
import type {
  WorkflowInputField,
  WorkflowInputSchema,
} from "@/shared/types/workflow.types";
import {
  getWorkflowInputField,
  isWorkflowInputField,
} from "@/shared/workflow/workflowStructure";

type PromptStudioRehydrationStateV1 = {
  v: 1;
  workflowId: string;
  snapshot: PromptRehydrationSnapshot | null;
  at: number;
};

export const isPromptRehydrationSnapshotV1 = (
  value: unknown
): value is PromptRehydrationSnapshotV1 => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PromptRehydrationSnapshotV1>;
  return snapshot.version === 1 && Boolean(snapshot.fields) && typeof snapshot.fields === "object";
};

export const isPromptRehydrationSnapshotV2 = (
  value: unknown
): value is PromptRehydrationSnapshotV2 => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<PromptRehydrationSnapshotV2>;
  return snapshot.version === 2 && Boolean(snapshot.fields) && typeof snapshot.fields === "object";
};

export const readPromptStudioRehydrationSnapshot = async (
  workflowId: string
): Promise<PromptRehydrationSnapshot | null> => {
  if (!workflowId) return null;

  try {
    const raw = await loadPromptRehydrationSnapshot(workflowId);
    if (!raw || typeof raw !== "object") return null;
    const parsed = raw as Partial<PromptStudioRehydrationStateV1> | null;
    if (!parsed || parsed.v !== 1) return null;
    const snapshot = parsed.snapshot;
    if (snapshot === null) return null;
    if (isPromptRehydrationSnapshotV2(snapshot) || isPromptRehydrationSnapshotV1(snapshot)) {
      return snapshot;
    }
    return null;
  } catch {
    return null;
  }
};

export const persistPromptStudioRehydrationSnapshot = (
  workflowId: string,
  snapshot: PromptRehydrationSnapshot | null
) => {
  if (!workflowId) return;
  if (!snapshot) {
    void savePromptRehydrationSnapshot(workflowId, null);
    return;
  }

  const state: PromptStudioRehydrationStateV1 = {
    v: 1,
    workflowId,
    snapshot,
    at: Date.now(),
  };
  void savePromptRehydrationSnapshot(workflowId, state);
};

export const isPersistableSchemaKey = (key: string) =>
  !key.startsWith("__") || key.startsWith("__bypass_");

const getPromptStudioSchemaEntries = (
  schema: WorkflowInputSchema | null | undefined
): Array<[string, WorkflowInputField]> => {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  return Object.entries(schema).filter(
    ([key, field]) => isPersistableSchemaKey(key) && isWorkflowInputField(field)
  ) as Array<[string, WorkflowInputField]>;
};

const getPromptStudioSchemaField = (
  schema: WorkflowInputSchema | null | undefined,
  key: string
): WorkflowInputField | null => {
  if (!isPersistableSchemaKey(key)) {
    return null;
  }
  return getWorkflowInputField(schema, key);
};

export const buildSchemaDefaults = (schema: WorkflowInputSchema | null | undefined) => {
  const defaults: Record<string, unknown> = {};
  getPromptStudioSchemaEntries(schema).forEach(([key, field]) => {
    if (field.default !== undefined) {
      defaults[key] = field.default;
    }
  });
  return defaults;
};

export const buildBypassDefaults = (schema: WorkflowInputSchema | null | undefined) => {
  const defaults: Record<string, unknown> = {};
  getPromptStudioSchemaEntries(schema).forEach(([key, field]) => {
    if (!key.startsWith("__bypass_")) return;
    if (field.default === undefined) return;
    defaults[key] = field.default;
  });
  return defaults;
};

export const mergeBypassDefaults = (
  schema: WorkflowInputSchema | null | undefined,
  params: Record<string, unknown> | null | undefined
) => {
  const normalizedParams =
    params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  return {
    ...buildBypassDefaults(schema),
    ...normalizedParams,
  };
};

export const filterParamsForSchema = (
  schema: WorkflowInputSchema | null | undefined,
  params: Record<string, unknown> | null | undefined
) => {
  const filtered: Record<string, unknown> = {};
  if (!params || typeof params !== "object") return filtered;
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) return;
    if (key.startsWith("__bypass_")) {
      filtered[key] = value;
      return;
    }
    if (getPromptStudioSchemaField(schema, key)) {
      filtered[key] = value;
    }
  });
  return filtered;
};

export const remapParamsToSchemaKeys = (
  schema: WorkflowInputSchema | null | undefined,
  params: Record<string, unknown> | null | undefined
) => {
  const sourceParams =
    params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const remapped: Record<string, unknown> = { ...sourceParams };
  if (!schema || typeof schema !== "object") return remapped;

  const schemaEntries = getPromptStudioSchemaEntries(schema).filter(
    ([key]) => !key.startsWith("__")
  );
  const nodeIdFieldToSchemaKey = new Map<string, string>();
  const nodeTokenFieldToSchemaKeys = new Map<string, string[]>();

  schemaEntries.forEach(([schemaKey, field]) => {
    const keyParts = schemaKey.split(".");
    const nodeToken = String(keyParts[0] || "").split("#")[0].toLowerCase();
    const fieldName = String(keyParts.slice(1).join(".") || schemaKey).toLowerCase();
    const nodeId = field.x_node_id;
    if (nodeId !== undefined && nodeId !== null) {
      nodeIdFieldToSchemaKey.set(`${String(nodeId)}.${fieldName}`, schemaKey);
    }
    const tokenKey = `${nodeToken}.${fieldName}`;
    const existing = nodeTokenFieldToSchemaKeys.get(tokenKey) || [];
    existing.push(schemaKey);
    nodeTokenFieldToSchemaKeys.set(tokenKey, existing);
  });

  Object.entries(sourceParams).forEach(([rawKey, value]) => {
    if (value === undefined) return;
    if (rawKey in schema) return;
    if (!rawKey.includes(".")) return;

    const keyParts = rawKey.split(".");
    const rawNodeToken = String(keyParts[0] || "");
    const fieldName = String(keyParts.slice(1).join(".") || rawKey).toLowerCase();
    if (!fieldName) return;

    const numericNode = rawNodeToken.match(/(\d+)(?!.*\d)/)?.[1] || null;
    if (numericNode) {
      const byNodeId = nodeIdFieldToSchemaKey.get(`${numericNode}.${fieldName}`);
      if (byNodeId && remapped[byNodeId] === undefined) {
        remapped[byNodeId] = value;
        return;
      }
    }

    const normalizedNodeToken = rawNodeToken.split("#")[0].toLowerCase();
    const byToken = nodeTokenFieldToSchemaKeys.get(`${normalizedNodeToken}.${fieldName}`);
    if (byToken && byToken.length === 1 && remapped[byToken[0]] === undefined) {
      remapped[byToken[0]] = value;
    }
  });

  return remapped;
};

export const normalizeParamsWithDefaults = (
  schema: WorkflowInputSchema | null | undefined,
  params: Record<string, unknown>
) => {
  const normalized: Record<string, unknown> = { ...params };
  getPromptStudioSchemaEntries(schema).forEach(([key, field]) => {
    if (field.default === undefined) return;

    const value = normalized[key];
    if (value === undefined || value === null) {
      normalized[key] = field.default;
      return;
    }

    if (Array.isArray(field.enum)) {
      const defaultValue = field.default;
      const valueStr = typeof value === "string" ? value : String(value);
      const trimmed = valueStr.trim();
      const enumHasEmpty = field.enum.includes("");
      if (trimmed.length === 0 && !enumHasEmpty) {
        normalized[key] = defaultValue;
      }
    }
  });
  return normalized;
};

const normalizeSnapshotItem = (
  fieldKey: string,
  index: number,
  item: PromptRehydrationItemV1 | PromptRehydrationItemV2,
  version: 1 | 2
): PromptRehydrationItemV2 => {
  if (version === 2) {
    const nextItem = item as PromptRehydrationItemV2;
    return {
      instanceId: nextItem.instanceId || `${fieldKey}-${index}`,
      type: nextItem.type,
      content: nextItem.content,
      sourceId: nextItem.sourceId,
      label: nextItem.label,
      color: nextItem.color,
      mode: nextItem.mode,
      frozenContent: nextItem.frozenContent,
      separatorBefore: nextItem.separatorBefore,
      locallyEdited: nextItem.locallyEdited,
    };
  }

  const legacyItem = item as PromptRehydrationItemV1;
  return {
    instanceId: `${fieldKey}-${index}`,
    type: legacyItem.type,
    content: legacyItem.content,
    sourceId: legacyItem.sourceId,
    label: legacyItem.label,
    color: legacyItem.color,
    frozenContent: legacyItem.type === "block" ? legacyItem.content : undefined,
  };
};

const buildUniqueSnapshotInstanceId = (
  fieldKey: string,
  preferredId: string | null | undefined,
  seenIds: Set<string>,
  nextGeneratedIndexRef: { current: number }
) => {
  const normalizedPreferredId =
    typeof preferredId === "string" ? preferredId.trim() : "";
  if (normalizedPreferredId && !seenIds.has(normalizedPreferredId)) {
    seenIds.add(normalizedPreferredId);
    return normalizedPreferredId;
  }

  let candidate = `${fieldKey}-${nextGeneratedIndexRef.current}`;
  while (seenIds.has(candidate)) {
    nextGeneratedIndexRef.current += 1;
    candidate = `${fieldKey}-${nextGeneratedIndexRef.current}`;
  }
  seenIds.add(candidate);
  nextGeneratedIndexRef.current += 1;
  return candidate;
};

const compactPromptRehydrationItems = (
  fieldKey: string,
  items: PromptRehydrationItemV2[]
): PromptRehydrationItemV2[] => {
  const compacted: PromptRehydrationItemV2[] = [];
  const seenIds = new Set<string>();
  const nextGeneratedIndexRef = { current: 0 };

  items.forEach((item) => {
    const fallbackContent =
      item.type === "block" && typeof item.frozenContent === "string"
        ? item.frozenContent
        : "";
    const content =
      typeof item.content === "string" && item.content.length > 0
        ? item.content
        : fallbackContent;
    if (!content.length) return;

    const instanceId = buildUniqueSnapshotInstanceId(
      fieldKey,
      item.instanceId,
      seenIds,
      nextGeneratedIndexRef
    );

    if (item.type !== "block") {
      const previousItem = compacted[compacted.length - 1];
      if (previousItem?.type === "text") {
        previousItem.content += content;
        return;
      }

      compacted.push({
        instanceId,
        type: "text",
        content,
        separatorBefore: item.separatorBefore,
      });
      return;
    }

    compacted.push({
      instanceId,
      type: "block",
      content,
      sourceId: item.sourceId,
      separatorBefore: item.separatorBefore,
      locallyEdited: item.locallyEdited,
      label: item.label,
      color: item.color,
      mode: item.mode === "frozen" ? "frozen" : item.mode === "live" ? "live" : undefined,
      frozenContent:
        typeof item.frozenContent === "string" && item.frozenContent.length > 0
          ? item.frozenContent
          : undefined,
    });
  });

  return compacted;
};

export const normalizePromptRehydrationSnapshot = (
  snapshot: PromptRehydrationSnapshot | null | undefined
): PromptRehydrationSnapshotV2 | null => {
  if (!snapshot || !snapshot.fields || typeof snapshot.fields !== "object") {
    return null;
  }

  const fields: Record<string, PromptRehydrationItemV2[]> = {};
  Object.entries(snapshot.fields).forEach(([fieldKey, items]) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const normalizedItems = items.map((item, index) =>
      normalizeSnapshotItem(
        fieldKey,
        index,
        item as PromptRehydrationItemV1 | PromptRehydrationItemV2,
        snapshot.version
      )
    );
    const compactedItems = compactPromptRehydrationItems(fieldKey, normalizedItems);
    if (compactedItems.length === 0) return;
    fields[fieldKey] = compactedItems;
  });

  return Object.keys(fields).length > 0 ? { version: 2, fields } : null;
};

export const canonicalizePromptRehydrationSnapshot = ({
  snapshot,
  schema,
  params,
}: {
  snapshot: PromptRehydrationSnapshot | null | undefined;
  schema: WorkflowInputSchema | null | undefined;
  params: Record<string, unknown>;
}): PromptRehydrationSnapshotV2 | null => {
  const normalizedSnapshot = normalizePromptRehydrationSnapshot(snapshot);
  if (!normalizedSnapshot) return null;

  const promptFieldKeys = getPromptFieldKeys(schema);
  if (promptFieldKeys.length === 0) return null;

  const sourceFieldKeys = Object.keys(normalizedSnapshot.fields || {});
  if (sourceFieldKeys.length === 0) return null;

  const resolvedParams: Record<string, unknown> = {};
  const remappedFields: Record<string, PromptRehydrationItemV2[]> = {};

  promptFieldKeys.forEach((fieldKey) => {
    const directValue = params[fieldKey];
    if (typeof directValue === "string") {
      resolvedParams[fieldKey] = directValue;
    } else {
      const equivalentParamKey = findEquivalentPromptFieldKey(
        fieldKey,
        Object.keys(params || {})
      );
      if (equivalentParamKey) {
        const equivalentValue = params[equivalentParamKey];
        if (typeof equivalentValue === "string") {
          resolvedParams[fieldKey] = equivalentValue;
        }
      }
    }

    const sourceFieldKey = sourceFieldKeys.includes(fieldKey)
      ? fieldKey
      : findEquivalentPromptFieldKey(fieldKey, sourceFieldKeys);
    if (!sourceFieldKey) return;

    const sourceItems = normalizedSnapshot.fields[sourceFieldKey];
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) return;

    const compactedItems = compactPromptRehydrationItems(fieldKey, sourceItems);
    if (compactedItems.length === 0) return;

    const targetValue = resolvedParams[fieldKey];
    if (typeof targetValue !== "string") return;

    const compiledPromptValue = compileItemsToPrompt(
      compactedItems.map((item) =>
        item.type === "block"
          ? {
              id: item.instanceId,
              type: "block" as const,
              content: item.content,
              sourceId: item.sourceId,
              label: item.label,
              color: item.color,
              rehydrationMode: item.mode,
              frozenContent: item.frozenContent,
              separatorBefore: item.separatorBefore,
              locallyEdited: item.locallyEdited,
            }
          : {
              id: item.instanceId,
              type: "text" as const,
              content: item.content,
              separatorBefore: item.separatorBefore,
            }
      )
    );
    if (normalizePrompt(compiledPromptValue) !== normalizePrompt(targetValue)) {
      return;
    }

    remappedFields[fieldKey] = compactedItems;
  });

  if (Object.keys(remappedFields).length === 0) return null;
  return { version: 2, fields: remappedFields };
};

export const filterPromptRehydrationSnapshot = (
  snapshot: PromptRehydrationSnapshot | null | undefined,
  params: Record<string, unknown>,
  library: PromptItem[]
): PromptRehydrationSnapshotV2 | null => {
  const normalizedSnapshot = normalizePromptRehydrationSnapshot(snapshot);
  if (!normalizedSnapshot) return null;

  const fields: Record<string, PromptRehydrationItemV2[]> = {};
  const blockLibrary = library.filter((snippet): snippet is PromptItem => snippet.type === "block");
  const libraryById = new Map(blockLibrary.map((snippet) => [snippet.id, snippet]));
  const stringParamKeys = Object.keys(params || {}).filter(
    (key) => typeof params[key] === "string"
  );
  const compileSnapshotItems = (items: PromptRehydrationItemV2[]) =>
    compileItemsToPrompt(
      items.map((item) =>
        item.type === "block"
          ? {
              id: item.instanceId,
              type: "block" as const,
              content: item.content,
              sourceId: item.sourceId,
              label: item.label,
              color: item.color,
              rehydrationMode: item.mode,
              frozenContent: item.frozenContent,
              separatorBefore: item.separatorBefore,
              locallyEdited: item.locallyEdited,
            }
          : {
              id: item.instanceId,
              type: "text" as const,
              content: item.content,
              separatorBefore: item.separatorBefore,
            }
      )
    );

  const resolveLiveSnippet = (item: PromptRehydrationItemV2): PromptItem | null => {
    if (item.type !== "block") return null;

    if (typeof item.sourceId === "string" && item.sourceId) {
      const byId = libraryById.get(item.sourceId);
      if (byId) return byId;
    }

    const normalizedLabel =
      typeof item.label === "string" && item.label.trim().length > 0
        ? normalizeSnippetLabel(item.label)
        : "";

    if (normalizedLabel) {
      const labelAndContent = blockLibrary.filter(
        (snippet) =>
          normalizeSnippetLabel(snippet.label || "") === normalizedLabel &&
          snippet.content === item.content
      );
      if (labelAndContent.length > 0) return labelAndContent[0];

      const labelOnly = blockLibrary.filter(
        (snippet) => normalizeSnippetLabel(snippet.label || "") === normalizedLabel
      );
      if (labelOnly.length === 1) return labelOnly[0];
    }

    if (item.content) {
      const contentOnly = blockLibrary.filter(
        (snippet) => snippet.content === item.content
      );
      if (contentOnly.length === 1) return contentOnly[0];
    }

    return null;
  };

  Object.entries(normalizedSnapshot.fields).forEach(([fieldKey, items]) => {
    const resolvedParamKey = findEquivalentPromptFieldKey(fieldKey, stringParamKeys);
    if (!resolvedParamKey) return;
    if (!Array.isArray(items) || items.length === 0) return;
    const targetPromptValue = params[resolvedParamKey];
    if (typeof targetPromptValue !== "string" || targetPromptValue.trim().length === 0) {
      return;
    }

    const normalizedItems = items.map((item) => {
      if (item.type !== "block" || typeof item.sourceId !== "string" || !item.sourceId) {
        return item;
      }

      const liveSnippet = resolveLiveSnippet(item);
      if (!liveSnippet) {
        return {
          instanceId: item.instanceId,
          type: "text" as const,
          content: item.content,
        };
      }

      if ((item.mode || "live") === "frozen" || item.content !== liveSnippet.content) {
        return {
          ...item,
          sourceId: liveSnippet.id,
          label: liveSnippet.label || item.label,
          color: liveSnippet.color || item.color,
          type: "block" as const,
          mode: "frozen" as const,
          content: item.frozenContent || item.content,
          frozenContent: item.frozenContent || item.content,
        };
      }

      if (
        item.sourceId !== liveSnippet.id ||
        item.label !== liveSnippet.label ||
        item.color !== liveSnippet.color ||
        item.mode !== "live" ||
        item.frozenContent !== undefined
      ) {
        return {
          ...item,
          sourceId: liveSnippet.id,
          label: liveSnippet.label,
          color: liveSnippet.color,
          mode: "live" as const,
          frozenContent: undefined,
        };
      }

      return item;
    });

    const hasLinkedSnippet = normalizedItems.some(
      (item) => item.type === "block" && typeof item.sourceId === "string" && item.sourceId.length > 0
    );
    if (!hasLinkedSnippet) return;
    const snapshotPromptValue = compileSnapshotItems(normalizedItems);
    if (!snapshotPromptValue.trim()) return;
    if (normalizePrompt(snapshotPromptValue) !== normalizePrompt(targetPromptValue)) {
      return;
    }

    const compactedItems = compactPromptRehydrationItems(fieldKey, normalizedItems);
    if (compactedItems.length === 0) return;
    fields[fieldKey] = compactedItems;
  });

  return Object.keys(fields).length > 0 ? { version: 2, fields } : null;
};
