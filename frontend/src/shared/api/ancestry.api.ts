import { API_BASE, postJson } from "./client";

export type AncestryState = "known" | "known_import" | "recipe_only" | "unknown" | "ambiguous" | "missing" | "deleted" | "unexpanded" | "truncated" | "restricted" | "circular" | "revision_mismatch" | "edited";

export interface AncestryNode {
    id: string;
    kind: "artifact" | "step" | "diagnostic";
    state: AncestryState;
    label: string;
    media_uuid?: string | null;
    image_id?: number | null;
    media_kind?: string | null;
    availability?: string | null;
    expandable: boolean;
    continuation?: string | null;
    attempt_id?: string | null;
    channel?: string | null;
    preview_url?: string | null;
    media_url?: string | null;
    details?: Record<string, unknown> | null;
    actions: { use_in_pipe: boolean; regenerate: boolean; reasons: string[] };
}

export interface AncestryEdge {
    id: string;
    source: string;
    target: string;
    role: string;
    field?: string | null;
    attribution: "branch" | "run_context" | "produced";
    state: string;
    continuation?: string | null;
    for_output?: string | null;
}

export interface AncestryReadResponse {
    root_id: string;
    nodes: AncestryNode[];
    edges: AncestryEdge[];
    continuation?: string | null;
    truncated: boolean;
    digest: string;
    limits: Record<string, number>;
}

export interface AncestryReadRequest {
    root_media_uuid?: string;
    root_image_id?: number;
    continuation?: string;
    detail?: boolean;
}

export const readAncestry = (request: AncestryReadRequest, signal?: AbortSignal) =>
    postJson<AncestryReadResponse>(`${API_BASE}/gallery/ancestry/read`, request, { signal });

/** Only existing authorized Gallery delivery routes may be used for previews. */
export function ancestryMediaUrl(value?: string | null): string | undefined {
    if (!value) return undefined;
    const route = value.replace(/^\/api\/v1/, "");
    if (!/^\/gallery\/image\/\d+(?:\/(?:preview|thumbnail))?(?:\?[^#]*)?$/.test(route)) return undefined;
    return `${API_BASE}${route}`;
}
