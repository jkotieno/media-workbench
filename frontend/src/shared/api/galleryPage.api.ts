import { buildThumbnailUrl } from "@/lib/galleryThumbnail";
import { isAudioFile, isVideoFile } from "@/lib/media";
import { getProfileStorageScope, profileStorage } from "@/lib/profileStorage";
import type { GalleryItem } from "@/shared/types";
import { API_BASE, throwApiRequestError } from "./client";

export const FIRST_GLOBAL_PAGE_SIZE = 32;
type GlobalGalleryPage = { items: GalleryItem[]; next_skip: number; has_more: boolean };

async function requestGlobalPage(skip: number, limit: number, signal?: AbortSignal): Promise<GlobalGalleryPage> {
    const params = new URLSearchParams({
        skip: String(skip),
        limit: String(limit),
        include_thumbnails: "false",
    });
    const response = await fetch(API_BASE + "/gallery/page?" + params.toString(), {
        cache: "no-store",
        signal,
    });
    if (!response.ok) await throwApiRequestError(response, "Failed to fetch all projects gallery");
    return response.json();
}

const STARTUP_PAGE_TIMEOUT_MS = 8_000;
let startupPage: {
    scope: string;
    expiresAt: number;
    request: Promise<GlobalGalleryPage | null>;
} | undefined;

function preloadFirstThumbnail(page: GlobalGalleryPage, scope: string): void {
    const image = page.items[0]?.image;
    if (!image || image.original_available !== true || image.cloud_reference ||
        scope !== getProfileStorageScope() || typeof document === "undefined" ||
        isAudioFile(image.path, image.filename) || isVideoFile(image.path, image.filename)) return;

    // Request exactly the same thumbnail the first card will render, before
    // the rest of the app's startup requests occupy the browser's connections.
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = buildThumbnailUrl(image.id, image.mtime);
    link.fetchPriority = "high";
    document.head.append(link);
}

/** Called after profile preferences and instance access are ready. */
export function primeStartupGalleryPage(): void {
    const scope = getProfileStorageScope();
    const { pathname, search, hash } = window.location;
    if (!scope || pathname.replace(/\/+$/, "").toLowerCase() !== "/gallery" ||
        search || hash || window.history.state?.usr != null) return;

    // Honor the persisted view. A filtered/deep-linked view owns its own request.
    try {
        const saved = JSON.parse(profileStorage.getItem("ds_page_gallery") ?? "null")?.state;
        if (saved && (saved.selectedProjectId != null || saved.search?.trim() || saved.cleanupMode)) return;
    } catch {
        return;
    }

    startupPage = {
        scope,
        expiresAt: Date.now() + STARTUP_PAGE_TIMEOUT_MS,
        request: requestGlobalPage(0, FIRST_GLOBAL_PAGE_SIZE, AbortSignal.timeout(STARTUP_PAGE_TIMEOUT_MS))
            .then(page => {
                preloadFirstThumbnail(page, scope);
                return page;
            })
            .catch(() => null),
    };
}

export async function getGlobalGalleryPage(skip: number, limit: number): Promise<GlobalGalleryPage> {
    if (skip === 0 && limit === FIRST_GLOBAL_PAGE_SIZE) {
        const initial = startupPage;
        startupPage = undefined;
        if (initial && initial.scope === getProfileStorageScope() && Date.now() < initial.expiresAt) {
            const page = await initial.request;
            if (page && initial.scope === getProfileStorageScope()) return page;
        }
    }
    return requestGlobalPage(skip, limit);
}
