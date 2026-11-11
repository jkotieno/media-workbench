import { previewOnly } from "@/features/gallery/utils";
import { api } from "@/lib/api";
import { makeMediaOriginalAvailable } from "@/shared/api/mediaOriginal";

export type CatalogTraySource = { imageId: number; mediaUuid?: string | null };

/** Re-resolve the catalog identity after acquisition: its old machine/cache path
 * may have changed. The caller still stages these bytes to its selected engine. */
export async function resolveMediaTrayOriginal(source: CatalogTraySource, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Number.isInteger(source.imageId) || source.imageId <= 0) throw new Error("This media identity is invalid. Select it again.");
  const readImage = async () => {
    const items = await api.getGallery({ imageIds: [source.imageId], includeThumbnails: false });
    signal?.throwIfAborted();
    const image = items.find(item => item.image.id === source.imageId)?.image;
    if (!image || image.is_deleted || (source.mediaUuid && image.continuity_media_uuid !== source.mediaUuid)) {
      throw new Error("This media changed or was removed. Select it again before using it.");
    }
    return image;
  };
  let image = await readImage();
  // Ordinary local files have no storage asset; their availability is `local`.
  if (previewOnly(image)) {
    if (!await makeMediaOriginalAvailable(source.imageId)) throw new Error("The original is unavailable. Reconnect its source and retry.");
    signal?.throwIfAborted();
    image = await readImage();
  }
  return { path: image.path, filename: image.filename, imageId: image.id, mediaUuid: image.continuity_media_uuid };
}
