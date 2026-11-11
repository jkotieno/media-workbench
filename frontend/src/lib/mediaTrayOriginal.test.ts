import {afterEach, describe, expect, it, vi} from "vitest";
const {getGallery, acquire} = vi.hoisted(() => ({getGallery: vi.fn(), acquire: vi.fn()}));
vi.mock("@/lib/api", () => ({api: {getGallery}}));
vi.mock("@/shared/api/mediaOriginal", () => ({makeMediaOriginalAvailable: acquire}));
import {resolveMediaTrayOriginal} from "./mediaTrayOriginal";
afterEach(() => vi.resetAllMocks());
describe("catalog original to media tray/input", () => {
  it("resolves the current verified path instead of retaining another machine's path", async () => {
    acquire.mockResolvedValue(true);
    getGallery.mockResolvedValue([{image: {id: 42, path: "/cache/verified.png", filename: "photo.png", continuity_media_uuid: "owned", cloud_reference: true}}]);
    expect(await resolveMediaTrayOriginal({imageId: 42, mediaUuid: "owned"})).toEqual({imageId: 42, mediaUuid: "owned", path: "/cache/verified.png", filename: "photo.png"});
    expect(getGallery).toHaveBeenCalledWith({imageIds: [42], includeThumbnails: false});
  });
  it("does not substitute a retained preview or a replaced identity", async () => {
    getGallery.mockResolvedValue([{image: {id: 42, cloud_reference: true}}]);
    acquire.mockResolvedValue(false);
    await expect(resolveMediaTrayOriginal({imageId: 42})).rejects.toThrow("original is unavailable");
    acquire.mockResolvedValue(true);
    getGallery.mockResolvedValue([{image: {id: 42, path: "/different.png", continuity_media_uuid: "other"}}]);
    await expect(resolveMediaTrayOriginal({imageId: 42, mediaUuid: "owned"})).rejects.toThrow("changed or was removed");
  });
  it("keeps ordinary local originals usable without a storage asset", async () => {
    getGallery.mockResolvedValue([{image: {id: 7, path: "/local/photo.png", filename: "photo.png", file_exists: true}}]);
    expect((await resolveMediaTrayOriginal({imageId: 7})).path).toBe("/local/photo.png");
    expect(acquire).not.toHaveBeenCalled();
  });
  it("allows a shared download to finish but prevents a cancelled input from continuing", async () => {
    getGallery.mockResolvedValue([{image: {id: 42, cloud_reference: true}}]);
    const controller = new AbortController();
    acquire.mockImplementation(async () => {controller.abort(); return true;});
    await expect(resolveMediaTrayOriginal({imageId: 42}, controller.signal)).rejects.toThrow();
    expect(getGallery).toHaveBeenCalledTimes(1);
  });
});
