import type {StorageAvailability} from "@/shared/api/storage.api";

/** Source association is independent of whether original bytes are local. */
export function studioPreviewOriginalStatus(value: StorageAvailability | null, failed = false) {
  const known = Boolean(value?.storage_asset_id || value?.original_source_known);
  const local = known && value?.state === "available";
  const transfer = value?.transfer?.state;
  const pending = known && ["queued", "running"].includes(transfer ?? "");
  const downloadFailed = known && ["failed", "interrupted", "cancelled"].includes(transfer ?? "");
  const label = failed ? known ? "Cloud original · Status unavailable" : "Original status unavailable"
    : local ? value?.pinned ? "Kept on this device" : "Downloaded"
    : pending ? "Downloading original…"
    : downloadFailed ? "Cloud original · Download failed"
    : known ? "Cloud original" : value ? "Preview only" : "Checking original…";
  return {known, local, label};
}
