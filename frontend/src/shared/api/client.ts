/**
 * API Client Base
 *
 * Shared HTTP infrastructure for all API modules.
 * Provides the base URL, helper functions, and common exports.
 */

// Detect if running behind nginx at /studio/ path - use /sts-api prefix
// Otherwise (local dev), use /api directly. Allow runtime overrides via a
// global injected by the hosting environment (e.g., window.__STS_API_BASE__)
// so deployments can point the frontend at a different backend host.

export const isStudioPath = typeof window !== 'undefined' && window.location.pathname.startsWith('/studio');
const DEFAULT_API_BASE = "/api/v1";
const STUDIO_API_BASE = "/sts-api/api/v1";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RUNTIME_API_BASE = (typeof window !== 'undefined' && (window as any).__STS_API_BASE__) || null;
export const API_BASE = RUNTIME_API_BASE || (isStudioPath ? STUDIO_API_BASE : DEFAULT_API_BASE);

/** Export the API base for use in image URLs throughout the app. */
export const IMAGE_API_BASE = API_BASE;

/** Utility function to get the API base path - use this in components. */
export const getApiBase = () => API_BASE;

/** Build a WebSocket URL for the sync client stream endpoint. */
export const getSyncClientStreamUrl = (): string => {
    const normalizedBase = `${API_BASE.replace(/\/+$/, "")}/`;
    const hasAbsoluteScheme = /^(https?|wss?):\/\//i.test(normalizedBase);
    const absoluteBase = hasAbsoluteScheme
        ? new URL(normalizedBase)
        : new URL(normalizedBase, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (absoluteBase.protocol === "http:") {
        absoluteBase.protocol = "ws:";
    } else if (absoluteBase.protocol === "https:") {
        absoluteBase.protocol = "wss:";
    }
    return new URL("sync/client/stream", absoluteBase).toString();
};

/** Build a WebSocket URL for the Studio-wide Agent Access event stream. */
export const getAgentEventStreamUrl = (): string => {
    const normalizedBase = `${API_BASE.replace(/\/+$/, "")}/`;
    const hasAbsoluteScheme = /^(https?|wss?):\/\//i.test(normalizedBase);
    const absoluteBase = hasAbsoluteScheme
        ? new URL(normalizedBase)
        : new URL(normalizedBase, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (absoluteBase.protocol === "http:") {
        absoluteBase.protocol = "ws:";
    } else if (absoluteBase.protocol === "https:") {
        absoluteBase.protocol = "wss:";
    }
    return new URL("agent/events", absoluteBase).toString();
};

type ApiErrorPayload = {
    detail?: unknown;
    error?: string;
    error_code?: string;
    code?: string;
};

export class ApiRequestError extends Error {
    readonly status: number;
    readonly code: string | null;
    readonly detail: string | null;
    readonly detailPayload: unknown;

    constructor(message: string, status: number, options?: { code?: string | null; detail?: string | null; detailPayload?: unknown }) {
        super(message);
        this.name = "ApiRequestError";
        this.status = status;
        this.code = options?.code ?? null;
        this.detail = options?.detail ?? null;
        this.detailPayload = options?.detailPayload ?? null;
    }
}

function apiDetailMessage(detail: unknown): string | null {
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        const message = (detail as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) return message.trim();
    }
    return null;
}

function apiDetailCode(payload: ApiErrorPayload): string | null {
    const detail = payload.detail;
    const detailCode = detail && typeof detail === "object" && !Array.isArray(detail)
        ? (detail as { code?: unknown }).code
        : null;
    const codeCandidate = payload.error_code ?? payload.code ?? detailCode;
    return typeof codeCandidate === "string" && codeCandidate.trim() ? codeCandidate.trim() : null;
}

export const throwApiRequestError = async (response: Response, fallbackMessage: string): Promise<never> => {
    const payload = await response.json().catch(() => ({})) as ApiErrorPayload;
    const detail = apiDetailMessage(payload.detail);
    const error = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
    const code = apiDetailCode(payload);
    throw new ApiRequestError(detail || error || fallbackMessage, response.status, {
        code,
        detail,
        detailPayload: payload.detail ?? null,
    });
};

/**
 * Fetch helper that throws on non-OK responses with the server's detail message.
 * Returns the parsed JSON body.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
        return throwApiRequestError(res, `Request failed: ${res.status}`);
    }
    return res.json();
}

/**
 * Fetch helper for void responses (DELETE, etc.) that throws on non-OK.
 */
export async function fetchVoid(url: string, init?: RequestInit): Promise<void> {
    const res = await fetch(url, init);
    if (!res.ok) {
        return throwApiRequestError(res, `Request failed: ${res.status}`);
    }
}

/**
 * POST JSON helper - sends a JSON body and returns parsed response.
 */
export async function postJson<T>(url: string, data: unknown, init?: RequestInit): Promise<T> {
    return fetchJson<T>(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...init?.headers },
        body: JSON.stringify(data),
        ...init,
    });
}

/**
 * PUT JSON helper - sends a JSON body and returns parsed response.
 */
export async function putJson<T>(url: string, data: unknown, init?: RequestInit): Promise<T> {
    return fetchJson<T>(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...init?.headers },
        body: JSON.stringify(data),
        ...init,
    });
}

/**
 * PATCH JSON helper - sends a JSON body and returns parsed response.
 */
export async function patchJson<T>(url: string, data: unknown, init?: RequestInit): Promise<T> {
    return fetchJson<T>(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...init?.headers },
        body: JSON.stringify(data),
        ...init,
    });
}
