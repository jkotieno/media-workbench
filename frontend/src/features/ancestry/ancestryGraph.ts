import type { AncestryEdge, AncestryNode, AncestryReadResponse } from "@/shared/api/ancestry.api";

export interface AncestryGraph {
    rootId: string;
    nodes: Map<string, AncestryNode>;
    edges: Map<string, AncestryEdge>;
    pages: Map<string, string>;
    authorityChanged: boolean;
}

export const emptyAncestryGraph = (): AncestryGraph => ({ rootId: "", nodes: new Map(), edges: new Map(), pages: new Map(), authorityChanged: false });

export function mergeAncestryPage(graph: AncestryGraph, page: AncestryReadResponse, owner: string): AncestryGraph {
    if (graph.authorityChanged) return graph;
    const restricted = new Set(page.nodes.filter(node => node.state === "restricted").map(node => node.id));
    const knownSourceRestricted = page.nodes.some(node => restricted.has(node.id) && graph.nodes.has(node.id) && graph.nodes.get(node.id)?.state !== "restricted");
    const knownBindingRestricted = page.edges.some(edge => {
        const previous = graph.edges.get(edge.id);
        return restricted.has(edge.source) && previous && graph.nodes.has(previous.source) && graph.nodes.get(previous.source)?.state !== "restricted";
    });
    const rootRestricted = restricted.has(page.root_id) && graph.nodes.has(graph.rootId) && graph.nodes.get(graph.rootId)?.state !== "restricted";
    if (knownSourceRestricted || knownBindingRestricted || rootRestricted) {
        // Drop the whole session before rendering a selected descendant. A
        // later in-flight page cannot repopulate an already revoked session.
        return { ...emptyAncestryGraph(), authorityChanged: true };
    }
    const nodes = new Map(graph.nodes);
    const edges = new Map(graph.edges);
    const pages = new Map(graph.pages);
    for (const node of page.nodes) {
        if (node.state === "restricted") {
            nodes.set(node.id, { id: node.id, kind: "diagnostic", state: "restricted", label: "Source unavailable", expandable: false,
                continuation: null, details: null, actions: { use_in_pipe: false, regenerate: false, reasons: [] } });
            continue;
        }
        const previous = nodes.get(node.id);
        let details = node.details ? { ...previous?.details, ...node.details } : previous?.details;
        if (node.kind === "step" && details) {
            // Output bytes belong to the artifact occurrence, even when two
            // output-specific pages share the same canonical execution.
            details = { ...details };
            for (const key of ["media", "output", "sha256", "content_revision"]) delete details[key];
        }
        nodes.set(node.id, { ...previous, ...node, continuation: previous?.continuation ?? node.continuation, details });
    }
    for (const edge of page.edges) edges.set(edge.id, edge);
    if (page.continuation) pages.set(owner, page.continuation); else pages.delete(owner);
    return { rootId: page.root_id, nodes, edges, pages, authorityChanged: false };
}

/** A snapshot of related outputs cannot bypass an authored edit's owner. */
export function canAttachRetainedOutput(graph: AncestryGraph, step: AncestryNode, output: AncestryNode): boolean {
    if (step.kind !== "step" || ["edited", "restricted"].includes(step.state) || output.kind !== "artifact" || ["edited", "restricted", "revision_mismatch", "circular"].includes(output.state)) return false;
    const produced = [...graph.edges.values()].filter(edge => edge.attribution === "produced");
    if (produced.some(edge => edge.target === output.id && edge.source !== step.id)) return false;
    return produced.some(edge => edge.source === step.id && graph.nodes.get(edge.target)?.kind === "artifact" && graph.nodes.get(edge.target)?.state !== "edited");
}

/** Only selected detail reads reveal sibling cards; their inputs remain lazy. */
export function withRetainedOutputs(page: AncestryReadResponse, previous: AncestryGraph): AncestryReadResponse {
    const nodes = new Map(page.nodes.map(node => [node.id, node]));
    const edges = new Map(page.edges.map(edge => [edge.id, edge]));
    const context: AncestryGraph = { ...previous, nodes: new Map([...previous.nodes, ...nodes]), edges: new Map([...previous.edges, ...edges]) };
    for (const step of page.nodes) {
        if (step.kind !== "step" || !Array.isArray(step.details?.outputs)) continue;
        for (const value of step.details.outputs.slice(0, 33)) {
            if (!value || typeof value !== "object" || !("id" in value) || !("kind" in value) || value.kind !== "artifact") continue;
            const output = value as AncestryNode;
            if (typeof output.id !== "string" || !canAttachRetainedOutput(context, step, output)) continue;
            if (!nodes.has(output.id)) nodes.set(output.id, output);
            if (![...context.edges.values()].some(edge => edge.source === step.id && edge.target === output.id && edge.attribution === "produced")) {
                const id = `selected-output:${step.id}:${output.id}`;
                edges.set(id, { id, source: step.id, target: output.id, role: output.channel || "output", attribution: "produced", state: output.state });
            }
        }
    }
    return { ...page, nodes: [...nodes.values()], edges: [...edges.values()] };
}

export interface AncestryRow {
    key: string;
    node: AncestryNode;
    edge?: AncestryEdge;
    depth: number;
    path: string[];
    circular: boolean;
    sharedWith?: string;
}

/** Occurrences retain their consuming field; shared data is expanded only once. */
export function ancestryRows(graph: AncestryGraph, expanded: ReadonlySet<string>): AncestryRow[] {
    const incoming = new Map<string, AncestryEdge[]>();
    for (const edge of graph.edges.values()) {
        const list = incoming.get(edge.target) ?? [];
        list.push(edge);
        incoming.set(edge.target, list);
    }
    const root = graph.nodes.get(graph.rootId);
    if (!root) return [];
    const first = new Map<string, string>();
    const rows: AncestryRow[] = [];
    const visibleIds = new Set<string>();
    const pending: Array<{ node: AncestryNode; edge?: AncestryEdge; depth: number; path: string[]; key: string; outputContext?: string }> = [
        { node: root, depth: 0, path: [], key: root.id },
    ];
    do {
    while (pending.length) {
        const next = pending.pop()!;
        const circular = next.path.includes(next.node.id) || next.node.state === "circular";
        const outputContext = next.node.kind === "step" ? next.outputContext ?? (next.edge?.attribution === "produced" ? next.edge.target : undefined) : undefined;
        const visitKey = outputContext ? `${next.node.id}@${outputContext}` : next.node.id;
        const sharedWith = !circular ? first.get(visitKey) : undefined;
        rows.push({ ...next, circular, sharedWith });
        visibleIds.add(next.node.id);
        if (circular || sharedWith || next.node.state === "restricted") continue;
        first.set(visitKey, next.key);
        if (next.node.kind !== "step" && !expanded.has(next.node.id)) continue;
        const links = (incoming.get(next.node.id) ?? []).filter(edge => !outputContext || !edge.for_output || edge.for_output === outputContext);
        for (let i = links.length - 1; i >= 0; i--) {
            const edge = links[i];
            const node = graph.nodes.get(edge.source);
            if (node) pending.push({ node, edge, depth: next.depth + 1, path: [...next.path, next.node.id], key: `${next.key}/${edge.id}`, outputContext: node.kind === "step" ? outputContext : undefined });
        }
    }
    // Retained siblings are revealed by an explicit detail selection. They are
    // independent expansion roots, with the same canonical producing junction.
    for (const edge of graph.edges.values()) {
        if (edge.attribution !== "produced" || !visibleIds.has(edge.source) || visibleIds.has(edge.target)) continue;
        const node = graph.nodes.get(edge.target);
        if (node?.kind === "artifact" && node.state !== "restricted") {
            visibleIds.add(node.id);
            pending.push({ node, key: `output:${node.id}`, depth: 0, path: [] });
        }
    }
    } while (pending.length);
    return rows;
}

export const ancestryStateLabel = (state: string): string => ({
    known_import: "Imported source", recipe_only: "Recipe saved in this file", unknown: "Earlier source not recorded",
    ambiguous: "More than one source matches", missing: "Original unavailable here", deleted: "Source was deleted",
    unexpanded: "Show earlier steps", truncated: "Recipe too large for this view", restricted: "Source unavailable",
    circular: "Circular source reference", revision_mismatch: "Recorded revision unavailable", edited: "Authored edit",
}[state] ?? "");

/** A coalescing, abortable two-slot queue shared by branches and detail reads. */
export class AncestryRequestQueue {
    private tasks = new Map<string, { controller: AbortController; run: (signal: AbortSignal) => Promise<void>; active: boolean }>();
    private active = 0;

    enqueue(key: string, run: (signal: AbortSignal) => Promise<void>) {
        if (this.tasks.has(key)) return;
        this.tasks.set(key, { controller: new AbortController(), run, active: false });
        this.pump();
    }

    cancel(key?: string) {
        for (const [id, task] of this.tasks) {
            if (key !== undefined && id !== key) continue;
            task.controller.abort();
            this.tasks.delete(id);
        }
    }

    private pump() {
        for (const [key, task] of this.tasks) {
            if (this.active >= 2) break;
            if (task.active || task.controller.signal.aborted) continue;
            task.active = true;
            this.active++;
            void task.run(task.controller.signal).catch(() => { /* owners display errors */ }).finally(() => {
                if (this.tasks.get(key) === task) this.tasks.delete(key);
                this.active--;
                this.pump();
            });
        }
    }
}
