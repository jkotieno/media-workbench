import { afterEach, beforeEach, expect, it, vi } from "vitest";

const profile = vi.hoisted(() => ({ scope: "profile-a", saved: null as string | null }));
vi.mock("@/lib/profileStorage", () => ({
    getProfileStorageScope: () => profile.scope,
    profileStorage: { getItem: () => profile.saved },
}));

const response = (nextSkip: number) =>
    new Response(JSON.stringify({ items: [], next_skip: nextSkip, has_more: true }));
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.resetModules();
    profile.scope = "profile-a";
    profile.saved = null;
    fetcher = vi.fn(async () => response(32));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("window", {
        location: { pathname: "/gallery", search: "", hash: "" },
        history: { state: null },
    });
});

afterEach(() => vi.unstubAllGlobals());

it("consumes the in-flight startup request once and keeps the server's continuation offset", async () => {
    const { primeStartupGalleryPage, getGlobalGalleryPage } = await import("./galleryPage.api");
    primeStartupGalleryPage();
    const page = await getGlobalGalleryPage(0, 32);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await getGlobalGalleryPage(page.next_skip, 80);
    expect(fetcher.mock.calls[1][0]).toContain("skip=32&limit=80");
    await getGlobalGalleryPage(0, 32);
    expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([{ selectedProjectId: 4 }, { search: "portrait" }, { cleanupMode: true }])(
    "leaves a saved scoped view to its normal loader (%o)", async (state) => {
        profile.saved = JSON.stringify({ state });
        const { primeStartupGalleryPage } = await import("./galleryPage.api");
        primeStartupGalleryPage();
        expect(fetcher).not.toHaveBeenCalled();
    },
);

it("never reuses the startup page across profile changes", async () => {
    fetcher.mockResolvedValueOnce(response(12));
    const { primeStartupGalleryPage, getGlobalGalleryPage } = await import("./galleryPage.api");
    primeStartupGalleryPage();
    profile.scope = "profile-b";
    expect((await getGlobalGalleryPage(0, 32)).next_skip).toBe(32);
    expect(fetcher).toHaveBeenCalledTimes(2);
});

it("falls back to the ordinary loader when the startup request fails", async () => {
    fetcher.mockRejectedValueOnce(new TypeError("Connection reset"));
    const { primeStartupGalleryPage, getGlobalGalleryPage } = await import("./galleryPage.api");
    primeStartupGalleryPage();
    expect((await getGlobalGalleryPage(0, 32)).next_skip).toBe(32);
    expect(fetcher).toHaveBeenCalledTimes(2);
});
