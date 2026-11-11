import { storageApi } from "./storage.api";

const pending = new Map<number, Promise<boolean>>();

/** True means verified original bytes are local; false means no original is mapped. */
export function makeMediaOriginalAvailable(imageId: number): Promise<boolean> {
  const existing = pending.get(imageId);
  if (existing) return existing;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 120_000);
  const task = (async () => {
    let availability = await storageApi.availability(imageId, controller.signal);
    if (availability.state === "available") return true;
    // Unmapped local images use the filesystem-backed replica state.
    if (availability.state === "local") return availability.replicas?.studio === "available";
    if (!availability.project_placement && !availability.storage_asset_id) return false;
    // This endpoint selects the existing placement/cache owner and deduplicates transfer intent.
    await storageApi.downloadImage(imageId, controller.signal);
    while (!controller.signal.aborted) {
      availability = await storageApi.availability(imageId, controller.signal);
      if (availability.state === "available") return true;
      if (["failed", "interrupted", "cancelled"].includes(availability.transfer?.state ?? "")) {
        throw new Error("The original could not be downloaded. Retry the download.");
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error("Original download timed out. Retry.")); };
        const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 1_000);
        controller.signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("Original download timed out. Retry.");
  })().finally(() => {
    clearTimeout(deadline);
    pending.delete(imageId);
  });
  pending.set(imageId, task);
  return task;
}
