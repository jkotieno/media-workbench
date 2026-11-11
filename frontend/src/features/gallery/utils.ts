import { IMAGE_API_BASE } from "@/shared/api/client";

export { buildThumbnailUrl } from "@/lib/galleryThumbnail";

export const buildMediaUrl = (imageId: number, mtime?: string | null) => {
  const params = new URLSearchParams();
  if (mtime) params.append("v", mtime);
  const query = params.toString();
  return `${IMAGE_API_BASE}/gallery/image/${imageId}${query ? `?${query}` : ""}`;
};


// A retained catalog record remains useful even while its original is offline.
export const previewOnly = (image: {
  cloud_reference?: boolean;
  file_exists?: boolean | null;
  original_available?: boolean | null;
  original_pending?: boolean;
  availability?: "original" | "preview_only" | "unavailable";
}) => {
  if (image.cloud_reference) return true;
  if (image.original_available != null) return !image.original_available;
  if (image.availability != null) return image.availability !== "original";
  if (image.original_pending) return false;
  return image.file_exists === false;
};
