import type { PromptItem } from "@/lib/types";

export type PromptTextEdit = { from: number; to: number; insert: string };
export type PromptItemRange = { from: number; to: number; item: PromptItem };

let nextInstance = 0;
const instanceId = () => `edit-${Date.now().toString(36)}-${++nextInstance}`;

/** Existing items own identity; matching only locates their ordered occurrences. */
export function promptItemRanges(
  value: string,
  items: readonly PromptItem[],
): PromptItemRange[] {
  let cursor = 0;
  const ranges: PromptItemRange[] = [];
  for (const item of items) {
    if (!item.content) continue;
    const from = value.indexOf(item.content, cursor);
    if (from < 0) continue;
    cursor = from + item.content.length;
    if (item.type === "block") ranges.push({ from, to: cursor, item });
  }
  return ranges;
}

export function itemsFromPromptRanges(
  value: string,
  ranges: readonly PromptItemRange[],
  previousItems: readonly PromptItem[] = [],
): PromptItem[] {
  const items: PromptItem[] = [];
  const nextBlocks: string[] = [];
  let nextBlock = "";
  for (let i = previousItems.length - 1; i >= 0; i--) {
    nextBlocks[i] = nextBlock;
    if (previousItems[i].type === "block") nextBlock = previousItems[i].id;
  }
  const previousGaps = new Map<string, PromptItem>();
  let previousBlock = "";
  previousItems.forEach((item, index) => {
    if (item.type === "block") previousBlock = item.id;
    else {
      const key = `${previousBlock}|${nextBlocks[index]}`;
      if (!previousGaps.has(key)) previousGaps.set(key, item);
    }
  });
  let lastBlock = "";
  const appendText = (content: string, followingBlock: string) => {
    const previous = previousGaps.get(`${lastBlock}|${followingBlock}`);
    items.push(
      previous?.content === content && previous.separatorBefore === ""
        ? previous
        : {
            id: previous?.id || instanceId(),
            type: "text",
            label: previous?.label,
            content,
            separatorBefore: "",
          },
    );
  };
  let cursor = 0;
  for (const range of ranges) {
    if (
      range.from < cursor ||
      range.to <= range.from ||
      range.to > value.length
    )
      continue;
    const gap = value.slice(cursor, range.from);
    const separatorBefore = gap.match(/[\s,]+$/u)?.[0] || "";
    const text = gap.slice(0, gap.length - separatorBefore.length);
    if (text) appendText(text, range.item.id);
    const content = value.slice(range.from, range.to);
    items.push(
      range.item.content === content &&
        range.item.separatorBefore === separatorBefore
        ? range.item
        : { ...range.item, content, separatorBefore },
    );
    lastBlock = range.item.id;
    cursor = range.to;
  }
  if (cursor < value.length) appendText(value.slice(cursor), "");
  return items;
}

/** Edits use original-document offsets, in ascending order. No library scan. */
export function editPromptItems(
  value: string,
  items: readonly PromptItem[],
  edits: readonly PromptTextEdit[],
): PromptItem[] {
  let ranges = promptItemRanges(value, items);
  let text = value;
  let offset = 0;
  for (const edit of edits) {
    const from = edit.from + offset,
      to = edit.to + offset;
    const delta = edit.insert.length - (to - from);
    const next = text.slice(0, from) + edit.insert + text.slice(to);
    ranges = ranges.flatMap((range): PromptItemRange[] => {
      if (to <= range.from)
        return [{ ...range, from: range.from + delta, to: range.to + delta }];
      if (from >= range.to) return [range];
      const inside = from >= range.from && to <= range.to;
      let start = range.from,
        end = range.to;
      if (inside) end += delta;
      else if (from <= range.from && to >= range.to) return [];
      else if (from <= range.from) {
        start = from + edit.insert.length;
        end += delta;
      } else end = from;
      if (end <= start) return [];
      const content = next.slice(start, end);
      return [
        {
          from: start,
          to: end,
          item: {
            ...range.item,
            content,
            frozenContent: content,
            rehydrationMode: "frozen",
            locallyEdited: true,
          },
        },
      ];
    });
    text = next;
    offset += delta;
  }
  return itemsFromPromptRanges(text, ranges, items);
}

export function promptTextDiff(
  previous: string,
  next: string,
): PromptTextEdit[] {
  if (previous === next) return [];
  let from = 0,
    beforeEnd = previous.length,
    afterEnd = next.length;
  while (from < beforeEnd && from < afterEnd && previous[from] === next[from])
    from++;
  while (
    beforeEnd > from &&
    afterEnd > from &&
    previous[beforeEnd - 1] === next[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  return [{ from, to: beforeEnd, insert: next.slice(from, afterEnd) }];
}

export function insertPromptSnippet(
  value: string,
  items: readonly PromptItem[],
  from: number,
  to: number,
  snippet: PromptItem,
) {
  const nextValue = value.slice(0, from) + snippet.content + value.slice(to);
  const nextItems = editPromptItems(value, items, [
    { from, to, insert: snippet.content },
  ]);
  const ranges = promptItemRanges(nextValue, nextItems).filter(
    (r) => r.to <= from || r.from >= from + snippet.content.length,
  );
  ranges.push({
    from,
    to: from + snippet.content.length,
    item: {
      ...snippet,
      id: instanceId(),
      sourceId: snippet.sourceId || snippet.id,
      rehydrationMode: "live",
      frozenContent: undefined,
      locallyEdited: undefined,
    },
  });
  ranges.sort((a, b) => a.from - b.from);
  return itemsFromPromptRanges(nextValue, ranges, nextItems);
}

/** A structural move carries each piece's separators without joining words. */
export function reorderPromptItems(
  value: string,
  items: readonly PromptItem[],
  activeId: string,
  overId: string,
): PromptItem[] {
  const ranges = promptItemRanges(value, items);
  const canonical = ranges.length
    ? itemsFromPromptRanges(value, ranges, items)
    : [...items];
  const from = canonical.findIndex((item) => item.id === activeId);
  let to = canonical.findIndex((item) => item.id === overId);
  if (to < 0) {
    const originalTarget = items.findIndex((item) => item.id === overId);
    const following = items
      .slice(originalTarget + 1)
      .find((item) => canonical.some((candidate) => candidate.id === item.id));
    to = following
      ? canonical.findIndex((item) => item.id === following.id)
      : canonical.length - 1;
  }
  if (from < 0 || to < 0 || from === to) return [...items];
  const preferredSeparator =
    canonical.slice(1).find((item) => item.separatorBefore)?.separatorBefore ||
    ", ";
  const originalPrevious = new Map(
    canonical.map((item, index) => [item.id, canonical[index - 1]?.id]),
  );
  const reordered = [...canonical];
  reordered.splice(to, 0, reordered.splice(from, 1)[0]);
  return reordered.map((item, index) => {
    if (!item.content) return item;
    let separatorBefore = item.separatorBefore;
    if (index === 0) separatorBefore = canonical[0]?.separatorBefore;
    else if (
      originalPrevious.get(item.id) !== reordered[index - 1].id &&
      (item.id === canonical[0]?.id || separatorBefore === "") &&
      !/[\s,]$/u.test(reordered[index - 1].content) &&
      !/^[\s,]/u.test(item.content)
    )
      separatorBefore = preferredSeparator;
    return separatorBefore === item.separatorBefore
      ? item
      : { ...item, separatorBefore };
  });
}

/** Display status describes this prompt's wording, not its hydration policy. */
export function getPromptSnippetStatus(
  item: PromptItem,
  liveSnippet?: PromptItem,
): "edited" | "stale" | null {
  if (
    item.type !== "block" ||
    (liveSnippet && item.content === liveSnippet.content)
  )
    return null;
  if (item.locallyEdited) return "edited";
  return item.rehydrationMode === "frozen" || liveSnippet ? "stale" : null;
}
