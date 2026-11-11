import type { PromptItem } from "@/lib/types";

const LABEL_WS_RE = /\s+/g;

export function sanitizeSnippetLabel(label: string): string {
  return label.trim().replace(LABEL_WS_RE, " ");
}

export function normalizeSnippetLabel(label: string): string {
  return sanitizeSnippetLabel(label).toLowerCase();
}

function makeUniqueLabel(base: string, used: Set<string>): string {
  const sanitizedBase = sanitizeSnippetLabel(base) || "Untitled";
  let candidate = sanitizedBase;
  let normalized = normalizeSnippetLabel(candidate);
  let suffix = 2;

  while (used.has(normalized)) {
    candidate = `${sanitizedBase} (${suffix})`;
    normalized = normalizeSnippetLabel(candidate);
    suffix += 1;
  }

  used.add(normalized);
  return candidate;
}

// Ensures all block snippet labels are:
// - present (defaults to "Untitled")
// - trimmed
// - unique (case-insensitive)
export function ensureUniqueSnippetLabels(snippets: PromptItem[]): PromptItem[] {
  const used = new Set<string>();
  let mutated = false;

  const next = snippets.map((snippet) => {
    if (snippet.type !== "block") return snippet;
    const rawLabel = typeof snippet.label === "string" ? snippet.label : "";
    const label = makeUniqueLabel(rawLabel, used);
    if (label === rawLabel) return snippet;
    mutated = true;
    return { ...snippet, label };
  });

  return mutated ? next : snippets;
}

