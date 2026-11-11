import { afterEach, describe, expect, it, vi } from "vitest";
import { storageApi } from "./storage.api";
import { makeMediaOriginalAvailable } from "./mediaOriginal";
vi.mock("./storage.api", () => ({storageApi: {availability: vi.fn(), downloadImage: vi.fn()}}));
const remote = {state: "remote", storage_asset_id: null, project_placement: {id: "p", project_id: 1, state: "linked", error_code: null}};
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
describe("original-dependent media actions", () => {
  it("acquires a linked original and shares concurrent consumer requests", async () => {
    vi.mocked(storageApi.availability).mockResolvedValueOnce(remote).mockResolvedValueOnce({...remote,state: "downloading"}).mockResolvedValue({...remote,state: "available"});
    vi.mocked(storageApi.downloadImage).mockResolvedValue({state:"available",image_id:42});
    vi.useFakeTimers();
    const first = makeMediaOriginalAvailable(42);
    expect(makeMediaOriginalAvailable(42)).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(true);
    expect(storageApi.downloadImage).toHaveBeenCalledTimes(1);
  });
  it("does not request bytes for an available original or invent one for preview-only media", async () => {
    vi.mocked(storageApi.availability).mockResolvedValueOnce({...remote,state:"available"}).mockResolvedValueOnce({state:"remote",storage_asset_id:null});
    await expect(makeMediaOriginalAvailable(43)).resolves.toBe(true);
    await expect(makeMediaOriginalAvailable(44)).resolves.toBe(false);
    expect(storageApi.downloadImage).not.toHaveBeenCalled();
  });
  it.each([
    ["available", true],
    ["missing", false],
  ])("checks the filesystem-backed Studio replica for a local-only original (%s)", async (studio, expected) => {
    vi.mocked(storageApi.availability).mockResolvedValue({
      state: "local", storage_asset_id: null, replicas: {studio, machine: "unavailable", storage: "unconfigured"},
    });
    await expect(makeMediaOriginalAvailable(46)).resolves.toBe(expected);
    expect(storageApi.downloadImage).not.toHaveBeenCalled();
  });
  it("retains a failed original as an error, releases the request and allows an explicit retry", async () => {
    vi.mocked(storageApi.availability).mockResolvedValueOnce(remote).mockResolvedValueOnce({...remote,transfer:{state:"failed"} as never});
    await expect(makeMediaOriginalAvailable(45)).rejects.toThrow("original could not");
    vi.mocked(storageApi.availability).mockResolvedValueOnce(remote).mockResolvedValueOnce({...remote,state:"available"});
    await expect(makeMediaOriginalAvailable(45)).resolves.toBe(true);
    expect(storageApi.downloadImage).toHaveBeenCalledTimes(2);
  });
});
