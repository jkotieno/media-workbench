import {
  buildSnippetIndex,
  findSnippetMatches,
  selectNonOverlappingMatches,
} from "@/lib/snippetMatcher";
import { isTextSchemaField } from "@/lib/promptUtils";
import {
  getSnippetColorSeed,
  normalizeSnippetColor,
} from "@/lib/snippetColors";
import { normalizeSnippetLabel } from "@/lib/snippetLabels";
import type {
  PromptFieldSelection,
  PromptFieldSession,
  PromptItem,
  PromptRehydrationItemV2,
  PromptRehydrationSnapshot,
  PromptRehydrationSnapshotV2,
  PromptStaleSnippetDescriptor,
} from "@/lib/types";
import type { WorkflowInputSchema } from "@/shared/types/workflow.types";
import { getWorkflowInputFieldEntries } from "@/shared/workflow/workflowStructure";
import {
  arePromptFieldKeysEquivalent,
  findEquivalentPromptFieldKey,
} from "./promptFieldKeyEquivalence";

import {
  editPromptItems,
  promptTextDiff,
  promptItemRanges,
  itemsFromPromptRanges,
} from "./promptEditing";

type PromptPatch = {
  start: number;
  end: number;
  replacementLength: number;
};

const ITEM_SIGNATURE = (item: PromptItem) =>
  `${item.id}|${item.type}|${item.content}|${item.label || ""}|${item.sourceId || ""}|${item.color || ""}|${item.rehydrationMode || ""}|${item.frozenContent || ""}|${item.rehydrationDismissedChoiceKey || ""}|${item.separatorBefore ?? "implicit"}|${item.locallyEdited || false}`;

export const normalizePrompt = (value: string) =>
  value
    .trim()
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ");

const stripTrailingWrappers = (value: string) =>
  value.trimEnd().replace(/[\s"'`)\]]+$/g, "");

export const isNaturalLanguageSnippet = (item: PromptItem) => {
  const stripped = stripTrailingWrappers(item.content || "");
  return /[.!?…]$/.test(stripped);
};

export const getImplicitSeparator = (
  prev: PromptItem | undefined,
  next: PromptItem | undefined,
) => {
  if (!prev || !next) return "";

  if (isNaturalLanguageSnippet(prev) || isNaturalLanguageSnippet(next)) {
    const hasBoundaryWhitespace =
      /\s$/.test(prev.content) || /^\s/.test(next.content);
    return hasBoundaryWhitespace ? "" : " ";
  }

  return ", ";
};

export const compileItemsToPrompt = (items: PromptItem[]) => {
  if (!items.length) return "";

  let compiled = (items[0]?.separatorBefore ?? "") + (items[0]?.content || "");
  for (let index = 1; index < items.length; index += 1) {
    compiled +=
      items[index].separatorBefore ??
      getImplicitSeparator(items[index - 1], items[index]);
    compiled += items[index]?.content || "";
  }
  return compiled;
};

export const getPromptFieldKeys = (
  schema: WorkflowInputSchema | null | undefined,
) =>
  getWorkflowInputFieldEntries(schema)
    .filter(([, field]) => isTextSchemaField(field))
    .map(([key]) => key);

export const createEmptyPromptFieldSession = (
  fieldKey: string,
  value = "",
): PromptFieldSession => ({
  fieldKey,
  value,
  items: [],
  selection: {
    start: Math.min(value.length, 0),
    end: Math.min(value.length, 0),
    direction: "none",
  },
  selectionRevision: 0,
});

const asBlockLibrary = (library: PromptItem[]) =>
  library.filter((item): item is PromptItem => item.type === "block");

const blockLibraryMaps = new WeakMap<PromptItem[], Map<string, PromptItem>>();
const blockLibraryMap = (library: PromptItem[]) => {
  let map = blockLibraryMaps.get(library);
  if (!map) {
    map = new Map(asBlockLibrary(library).map((item) => [item.id, item]));
    blockLibraryMaps.set(library, map);
  }
  return map;
};

const toLinkedSnippetItem = (snippet: PromptItem, id: string): PromptItem => ({
  id,
  type: "block",
  sourceId:
    (typeof snippet.sourceId === "string" && snippet.sourceId) || snippet.id,
  content: snippet.content,
  label: snippet.label,
  color: normalizeSnippetColor(snippet.color, getSnippetColorSeed(snippet)),
  rehydrationMode: snippet.rehydrationMode,
  frozenContent:
    snippet.rehydrationMode === "frozen"
      ? snippet.frozenContent || snippet.content
      : snippet.frozenContent,
});

const labelTextItems = (items: PromptItem[]) => items;

const buildItemsFromSelectedMatches = (
  value: string,
  selectedMatches: Array<{ start: number; end: number; snippet: PromptItem }>,
) =>
  itemsFromPromptRanges(
    value,
    selectedMatches.map((match) => ({
      from: match.start,
      to: match.end,
      item: toLinkedSnippetItem(match.snippet, `instance-${match.start}`),
    })),
  );

const buildItemsFromMatches = (
  value: string,
  matches: Array<{
    start: number;
    end: number;
    order: number;
    length: number;
    snippet: PromptItem;
  }>,
) => {
  if (!matches || matches.length === 0) {
    return value.trim().length > 0
      ? labelTextItems([{ id: "text-0", type: "text", content: value }])
      : [];
  }

  const selectedMatches = selectNonOverlappingMatches(matches, {
    preferLongest: true,
  });
  if (!selectedMatches.length) {
    return value.trim().length > 0
      ? labelTextItems([{ id: "text-0", type: "text", content: value }])
      : [];
  }

  return buildItemsFromSelectedMatches(
    value,
    selectedMatches.map((match) => ({
      start: match.start,
      end: match.end,
      snippet: match.snippet,
    })),
  );
};

export const buildItemsFromValue = (value: string, library: PromptItem[]) => {
  if (!value) return [];

  const snippetIndex = buildSnippetIndex(library);
  const matches = findSnippetMatches(value, snippetIndex);
  return buildItemsFromMatches(
    value,
    (matches || []).map((match) => ({
      ...match,
      snippet: match.snippet as PromptItem,
    })),
  );
};

const relinkTextItemsToLibrary = (
  items: PromptItem[],
  library: PromptItem[],
) => {
  let didRelink = false;
  const relinkedItems: PromptItem[] = [];

  items.forEach((item, itemIndex) => {
    if (item.type !== "text" || !item.content) {
      relinkedItems.push(item);
      return;
    }

    const rebuilt = buildItemsFromValue(item.content, library);
    const hasLinkedBlocks = rebuilt.some(
      (entry) => entry.type === "block" && Boolean(entry.sourceId),
    );
    if (!hasLinkedBlocks) {
      relinkedItems.push(item);
      return;
    }

    didRelink = true;
    rebuilt.forEach((entry, index) => {
      const separatorBefore = index === 0
        ? (item.separatorBefore ?? getImplicitSeparator(items[itemIndex - 1], item)) +
          (entry.separatorBefore ?? "")
        : entry.separatorBefore;
      relinkedItems.push({
        ...entry,
        id: `${item.id}-relink-${index}`,
        separatorBefore,
      });
    });
  });

  return didRelink ? relinkedItems : items;
};

const buildUniquePromptItemId = (
  fieldKey: string,
  preferredId: string | null | undefined,
  seenIds: Set<string>,
  nextGeneratedIndexRef: { current: number },
) => {
  const normalizedPreferredId =
    typeof preferredId === "string" ? preferredId.trim() : "";
  if (normalizedPreferredId && !seenIds.has(normalizedPreferredId)) {
    seenIds.add(normalizedPreferredId);
    return normalizedPreferredId;
  }

  let candidate = `${fieldKey}-item-${nextGeneratedIndexRef.current}`;
  while (seenIds.has(candidate)) {
    nextGeneratedIndexRef.current += 1;
    candidate = `${fieldKey}-item-${nextGeneratedIndexRef.current}`;
  }
  seenIds.add(candidate);
  nextGeneratedIndexRef.current += 1;
  return candidate;
};

const compactPromptItems = (
  fieldKey: string,
  items: PromptItem[],
): PromptItem[] => {
  const compacted: PromptItem[] = [];
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

    const nextId = buildUniquePromptItemId(
      fieldKey,
      item.id,
      seenIds,
      nextGeneratedIndexRef,
    );

    if (item.type !== "block") {
      const previousItem = compacted[compacted.length - 1];
      if (previousItem?.type === "text") {
        previousItem.content += content;
        return;
      }

      compacted.push({
        id: nextId,
        type: "text",
        content,
        label: item.label,
        separatorBefore: item.separatorBefore,
      });
      return;
    }

    compacted.push({
      ...item,
      id: nextId,
      content,
      frozenContent: item.frozenContent,
    });
  });

  return compacted;
};

export const ensureUniquePromptItemIds = (
  fieldKey: string,
  items: PromptItem[],
): PromptItem[] => {
  const seenIds = new Set<string>();
  const nextGeneratedIndexRef = { current: 0 };
  let didChange = false;

  const nextItems = items.map((item) => {
    const nextId = buildUniquePromptItemId(
      fieldKey,
      item.id,
      seenIds,
      nextGeneratedIndexRef,
    );
    if (nextId === item.id) {
      return item;
    }

    didChange = true;
    return {
      ...item,
      id: nextId,
    };
  });

  return didChange ? nextItems : items;
};

const itemsEqual = (left: PromptItem[], right: PromptItem[]) => {
  if (left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      ITEM_SIGNATURE(item) === ITEM_SIGNATURE(right[index] as PromptItem),
  );
};

const clampSelectionOffset = (offset: number, valueLength: number) =>
  Math.max(0, Math.min(valueLength, offset));

export const clampSelection = (
  selection: PromptFieldSelection | undefined,
  valueLength: number,
): PromptFieldSelection => {
  const start = clampSelectionOffset(selection?.start ?? 0, valueLength);
  const end = clampSelectionOffset(selection?.end ?? start, valueLength);
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
    direction: selection?.direction || "none",
  };
};

const bumpSelectionRevision = (
  field: PromptFieldSession,
  nextSelection: PromptFieldSelection,
  shouldBump: boolean,
) => ({
  ...field,
  selection: nextSelection,
  selectionRevision: shouldBump
    ? field.selectionRevision + 1
    : field.selectionRevision,
});

const selectSnapshotItems = (
  fieldKey: string,
  snapshot: PromptRehydrationSnapshot | null | undefined,
): PromptRehydrationItemV2[] | undefined => {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  if (snapshot.version === 2) {
    const fields = snapshot.fields || {};
    if (Array.isArray(fields[fieldKey])) {
      return fields[fieldKey];
    }
    const equivalentFieldKey = findEquivalentPromptFieldKey(
      fieldKey,
      Object.keys(fields),
    );
    return equivalentFieldKey ? fields[equivalentFieldKey] : undefined;
  }
  if (snapshot.version === 1) {
    const fields = snapshot.fields || {};
    const equivalentFieldKey = findEquivalentPromptFieldKey(
      fieldKey,
      Object.keys(fields),
    );
    const items =
      fields[fieldKey] ||
      (equivalentFieldKey ? fields[equivalentFieldKey] : undefined);
    if (!Array.isArray(items)) return undefined;
    return items.map((item, index) => ({
      instanceId: `legacy-${fieldKey}-${index}`,
      type: item.type,
      content: item.content,
      sourceId: item.sourceId,
      label: item.label,
      color: item.color,
      frozenContent: item.type === "block" ? item.content : undefined,
    }));
  }
  return undefined;
};

const resolveLiveSnippetCandidate = (
  candidate: {
    sourceId?: string | undefined;
    label?: string | undefined;
    content?: string | undefined;
  },
  library: PromptItem[],
) => {
  const blockLibrary = asBlockLibrary(library);

  if (typeof candidate.sourceId === "string" && candidate.sourceId) {
    const byId = blockLibrary.find(
      (snippet) => snippet.id === candidate.sourceId,
    );
    // An explicit identity must never be rebound by label or matching text.
    return byId ?? null;
  }

  const normalizedLabel =
    typeof candidate.label === "string" && candidate.label.trim().length > 0
      ? normalizeSnippetLabel(candidate.label)
      : "";
  const content =
    typeof candidate.content === "string" ? candidate.content : "";

  if (normalizedLabel && content) {
    const labelAndContent = blockLibrary.filter(
      (snippet) =>
        normalizeSnippetLabel(snippet.label || "") === normalizedLabel &&
        snippet.content === content,
    );
    if (labelAndContent.length === 1) {
      return labelAndContent[0];
    }
  }

  if (normalizedLabel) {
    const labelOnly = blockLibrary.filter(
      (snippet) =>
        normalizeSnippetLabel(snippet.label || "") === normalizedLabel,
    );
    if (labelOnly.length === 1) {
      return labelOnly[0];
    }
  }

  if (content) {
    const contentOnly = blockLibrary.filter(
      (snippet) => snippet.content === content,
    );
    if (contentOnly.length === 1) {
      return contentOnly[0];
    }
  }

  return null;
};

const resolveLiveSnippet = (
  snapshotItem: PromptRehydrationItemV2,
  library: PromptItem[],
) =>
  snapshotItem.type !== "block"
    ? null
    : resolveLiveSnippetCandidate(
        {
          sourceId: snapshotItem.sourceId,
          label: snapshotItem.label,
          content: snapshotItem.content,
        },
        library,
      );

const getSavedBlockContent = (
  item: {
    content?: string | undefined;
    frozenContent?: string | undefined;
  },
  isFrozen: boolean,
) => {
  const content = typeof item.content === "string" ? item.content : "";
  if (!isFrozen) return content;
  return typeof item.frozenContent === "string" ? item.frozenContent : content;
};

const getCanonicalBlockMode = (
  item: {
    content?: string;
    frozenContent?: string;
    locallyEdited?: boolean;
    sourceId?: string;
    mode?: "live" | "frozen";
    rehydrationMode?: "live" | "frozen";
  },
  isFrozen: boolean,
  liveSnippet: PromptItem | null | undefined,
): "live" | "frozen" => {
  // Link policy is user intent, not a comparison with today's bank content.
  // A temporarily missing source retains its identity and saved fallback.
  if (isFrozen || item.locallyEdited) return "frozen";
  if (item.mode === "live" || item.rehydrationMode === "live") return "live";
  return item.sourceId || liveSnippet ? "live" : "frozen";
};

export const buildItemsFromSnapshot = (
  fieldKey: string,
  snapshot: PromptRehydrationSnapshot | null | undefined,
  library: PromptItem[],
) => {
  const snapshotItems = selectSnapshotItems(fieldKey, snapshot);
  if (!Array.isArray(snapshotItems) || snapshotItems.length === 0) return null;

  return compactPromptItems(
    fieldKey,
    snapshotItems.flatMap((snapshotItem, index): PromptItem[] => {
      const content =
        typeof snapshotItem.content === "string" ? snapshotItem.content : "";
      if (snapshotItem.type !== "block") {
        if (!content.length) return [];
        return [
          {
            id: snapshotItem.instanceId || `rehydrate-${fieldKey}-${index}`,
            type: "text",
            content,
            label: snapshotItem.label,
            separatorBefore: snapshotItem.separatorBefore,
          },
        ];
      }

      const liveSnippet = resolveLiveSnippet(snapshotItem, library);
      const snapshotExplicitlyFrozen = snapshotItem.mode === "frozen";
      const resolvedMode = getCanonicalBlockMode(
        snapshotItem,
        snapshotExplicitlyFrozen,
        liveSnippet,
      );
      const resolvedSourceId =
        liveSnippet?.id ||
        (typeof snapshotItem.sourceId === "string" && snapshotItem.sourceId
          ? snapshotItem.sourceId
          : undefined);
      const savedContent = getSavedBlockContent(
        snapshotItem,
        snapshotExplicitlyFrozen,
      );
      const frozenContent =
        resolvedMode === "frozen" ? savedContent : undefined;
      const renderedContent =
        resolvedMode === "live" && liveSnippet
          ? liveSnippet.content
          : savedContent;
      const label = liveSnippet?.label || snapshotItem.label || "";
      const color = normalizeSnippetColor(
        liveSnippet?.color || snapshotItem.color,
        `${resolvedSourceId || snapshotItem.instanceId || ""}|${label}|${savedContent}`,
      );

      return [
        {
          id: snapshotItem.instanceId || `rehydrate-${fieldKey}-${index}`,
          type: "block",
          sourceId: resolvedSourceId,
          content: renderedContent,
          label,
          color,
          rehydrationMode: resolvedMode,
          separatorBefore: snapshotItem.separatorBefore,
          locallyEdited: snapshotItem.locallyEdited,
          frozenContent: resolvedMode === "frozen" ? frozenContent : undefined,
        },
      ];
    }),
  );
};

export const buildPromptFieldSession = ({
  fieldKey,
  value,
  library,
  snapshot,
  previousField,
}: {
  fieldKey: string;
  value: string;
  library: PromptItem[];
  snapshot: PromptRehydrationSnapshot | null | undefined;
  previousField?: PromptFieldSession | undefined;
}): PromptFieldSession => {
  const rawSnapshotItems = buildItemsFromSnapshot(fieldKey, snapshot, library);
  const snapshotItems = rawSnapshotItems
    ? relinkTextItemsToLibrary(rawSnapshotItems, library)
    : null;
  const hasSnapshotItems =
    Array.isArray(snapshotItems) && snapshotItems.length > 0;
  const snapshotIsTextOnly =
    hasSnapshotItems && snapshotItems.every((item) => item.type === "text");
  const snapshotMatchesValue =
    hasSnapshotItems &&
    (normalizePrompt(compileItemsToPrompt(snapshotItems)) === normalizePrompt(value) ||
      normalizePrompt(compileItemsToPrompt(
        buildItemsFromSnapshot(fieldKey, snapshot, []) ?? [],
      )) === normalizePrompt(value));
  const valueMatchedItems =
    !hasSnapshotItems || snapshotIsTextOnly || !snapshotMatchesValue
      ? buildItemsFromValue(value, library)
      : [];
  const valueMatchedHasLinkedBlocks = valueMatchedItems.some(
    (item) => item.type === "block" && Boolean(item.sourceId),
  );
  const shouldPreferValueMatchedItems =
    snapshotIsTextOnly && valueMatchedHasLinkedBlocks;
  const fallbackItems: PromptItem[] = shouldPreferValueMatchedItems
    ? valueMatchedItems
    : hasSnapshotItems && snapshotMatchesValue
      ? snapshotItems
      : valueMatchedItems;

  const previousFieldMatchesKey = Boolean(
    previousField?.fieldKey &&
      (previousField.fieldKey === fieldKey ||
        arePromptFieldKeysEquivalent(previousField.fieldKey, fieldKey)),
  );
  const previousItems = previousField?.items || [];
  const canReusePreviousLinkedItems =
    !hasSnapshotItems &&
    previousFieldMatchesKey &&
    previousItems.length > 0 &&
    previousItems.some(
      (item) =>
        item.type === "block" &&
        typeof item.sourceId === "string" &&
        item.sourceId.length > 0,
    ) &&
    compileItemsToPrompt(previousItems) === value;

  const compactedItems = compactPromptItems(
    fieldKey,
    canReusePreviousLinkedItems ? previousItems : fallbackItems,
  );
  const compiledItems = compileItemsToPrompt(compactedItems);
  const items = compactedItems.some((item) => item.type === "block")
    ? itemsFromPromptRanges(
        compiledItems,
        promptItemRanges(compiledItems, compactedItems),
        compactedItems,
      )
    : compactedItems;
  const normalizedValue = compileItemsToPrompt(items);
  const nextValue = canReusePreviousLinkedItems
    ? value
    : items.length > 0
      ? normalizedValue
      : value;
  const baseSelection = clampSelection(
    previousField?.selection,
    nextValue.length,
  );

  return {
    fieldKey,
    value: nextValue,
    items,
    selection: baseSelection,
    selectionRevision: previousField?.selectionRevision || 0,
  };
};

export const reconcilePromptFieldText = (
  field: PromptFieldSession,
  nextValue: string,
  _library: PromptItem[],
  selection: PromptFieldSelection,
) => ({
  ...field,
  value: nextValue,
  items: editPromptItems(
    field.value,
    field.items,
    promptTextDiff(field.value, nextValue),
  ),
  selection: clampSelection(selection, nextValue.length),
});

const mapSelectionOffset = (offset: number, patches: PromptPatch[]) => {
  let delta = 0;

  for (const patch of patches) {
    if (offset < patch.start) {
      break;
    }

    if (offset <= patch.end) {
      return patch.start + delta + patch.replacementLength;
    }

    delta += patch.replacementLength - (patch.end - patch.start);
  }

  return offset + delta;
};

const applySelectionPatches = (
  selection: PromptFieldSelection,
  patches: PromptPatch[],
  valueLength: number,
) =>
  clampSelection(
    {
      start: mapSelectionOffset(selection.start, patches),
      end: mapSelectionOffset(selection.end, patches),
      direction: selection.direction,
    },
    valueLength,
  );

export const applyPromptLibraryChange = (
  field: PromptFieldSession,
  _previousLibrary: PromptItem[],
  nextLibrary: PromptItem[],
) => {
  const nextById = new Map(nextLibrary.map((item) => [item.id, item]));
  const ranges = promptItemRanges(field.value, field.items);
  const patches: PromptPatch[] = [];
  let offset = 0,
    value = field.value;
  const nextRanges = ranges.map((range) => {
    const source = range.item.sourceId
      ? nextById.get(range.item.sourceId)
      : undefined;
    const frozen =
      range.item.locallyEdited || range.item.rehydrationMode === "frozen";
    const content = source && !frozen ? source.content : range.item.content;
    const delta = content.length - (range.to - range.from),
      from = range.from + offset;
    if (content !== range.item.content) {
      value = value.slice(0, from) + content + value.slice(range.to + offset);
      patches.push({
        start: range.from,
        end: range.to,
        replacementLength: content.length,
      });
    }
    const item = {
      ...range.item,
      content,
      label: source?.label ?? range.item.label,
      color: source?.color ?? range.item.color,
    };
    offset += delta;
    return { from, to: from + content.length, item };
  });
  const next = {
    ...field,
    value,
    // A saved snippet can now match text that was plain when the prompt loaded.
    // Relink only plain pieces; existing live/frozen instances retain ownership.
    items: relinkTextItemsToLibrary(
      itemsFromPromptRanges(value, nextRanges, field.items),
      nextLibrary,
    ),
  };
  if (fieldSessionEqual(field, next)) return field;
  return bumpSelectionRevision(
    next,
    applySelectionPatches(field.selection, patches, value.length),
    value !== field.value,
  );
};

export const buildPromptRehydrationSnapshotV2 = (
  fields: Record<string, PromptFieldSession>,
  library: PromptItem[],
): PromptRehydrationSnapshotV2 | null => {
  const libraryById = blockLibraryMap(library);
  const nextFields: Record<string, PromptRehydrationItemV2[]> = {};

  Object.entries(fields).forEach(([fieldKey, field]) => {
    if (!field.items.some((item) => item.type === "block")) return;

    nextFields[fieldKey] = field.items.map((item) => {
      if (item.type !== "block") {
        return {
          instanceId: item.id,
          type: "text",
          content: item.content,
          separatorBefore: item.separatorBefore,
        };
      }

      const liveSnippet = item.sourceId
        ? libraryById.get(item.sourceId)
        : undefined;
      const inferredMode = getCanonicalBlockMode(
        item,
        item.rehydrationMode === "frozen",
        liveSnippet,
      );
      const savedContent = getSavedBlockContent(
        item,
        item.rehydrationMode === "frozen",
      );
      return {
        instanceId: item.id,
        type: "block",
        content: item.content,
        sourceId: item.sourceId,
        label: item.label,
        color: item.color,
        mode: inferredMode,
        separatorBefore: item.separatorBefore,
        locallyEdited: item.locallyEdited,
        frozenContent: inferredMode === "frozen" ? savedContent : undefined,
      };
    });
  });

  return Object.keys(nextFields).length > 0
    ? { version: 2, fields: nextFields }
    : null;
};

export const buildStaleSnippetDescriptors = (
  field: PromptFieldSession | undefined,
  library: PromptItem[],
): PromptStaleSnippetDescriptor[] => {
  if (!field) return [];

  const libraryById = new Map(
    asBlockLibrary(library).map((item) => [item.id, item]),
  );
  const descriptors = new Map<string, PromptStaleSnippetDescriptor>();

  field.items.forEach((item) => {
    if (item.type !== "block" || !item.sourceId) return;

    const liveSnippet = libraryById.get(item.sourceId);
    if (!liveSnippet) return;

    const renderedFrozenContent =
      item.rehydrationMode === "frozen"
        ? item.frozenContent || item.content
        : undefined;
    const staleContent =
      renderedFrozenContent && renderedFrozenContent !== liveSnippet.content
        ? renderedFrozenContent
        : item.content !== liveSnippet.content
          ? item.content
          : "";
    if (!staleContent) return;

    const key = `${item.sourceId}::${staleContent}`;
    if (descriptors.has(key)) return;

    descriptors.set(key, {
      id: key,
      sourceId: item.sourceId,
      content: staleContent,
      liveContent: liveSnippet.content,
      label: liveSnippet.label || item.label,
      color: liveSnippet.color || item.color,
    });
  });

  return Array.from(descriptors.values());
};

export const preserveClampedSelection = (
  field: PromptFieldSession,
  nextValue: string,
  shouldBump = false,
) =>
  bumpSelectionRevision(
    {
      ...field,
      value: nextValue,
    },
    clampSelection(field.selection, nextValue.length),
    shouldBump,
  );

export const fieldSessionEqual = (
  left: PromptFieldSession | undefined,
  right: PromptFieldSession | undefined,
) => {
  if (!left || !right) return false;
  return (
    left.value === right.value &&
    left.selectionRevision === right.selectionRevision &&
    left.selection.start === right.selection.start &&
    left.selection.end === right.selection.end &&
    left.selection.direction === right.selection.direction &&
    itemsEqual(left.items, right.items)
  );
};
