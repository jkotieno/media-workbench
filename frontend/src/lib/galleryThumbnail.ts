import { IMAGE_API_BASE } from "@/shared/api/client";

export const buildGalleryThumbnailUrl = (
    path: string,
    mtime?: string,
    mediaId?: number | null,
    maxPx: number = 256,
) => {
    const params = new URLSearchParams({
        max_px: String(maxPx),
        thumb_v: "2",
    });
    if (mtime) params.append("v", mtime);
    if (mediaId) {
        return `${IMAGE_API_BASE}/gallery/image/${mediaId}/thumbnail?${params.toString()}`;
    }
    params.append("path", path);
    return `${IMAGE_API_BASE}/gallery/image/path/thumbnail?${params.toString()}`;
};

// Larger thumbnails for Gallery (512px) vs ProjectGallery sidebar (256px) due to bigger cards
const GALLERY_THUMBNAIL_PX = 512;

export const buildThumbnailUrl = (imageId: number, mtime?: string | null, maxPx: number = GALLERY_THUMBNAIL_PX) => {
  const params = new URLSearchParams({ max_px: String(maxPx) });
  if (mtime) params.append("v", mtime);
  return `${IMAGE_API_BASE}/gallery/image/${imageId}/thumbnail?${params.toString()}`;
};
