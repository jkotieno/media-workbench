import type { FolderImage } from "@/lib/types";
import { getBasename } from "@/lib/pathUtils";
import type { TransformExportResponse } from "@/shared/types";

type NormalizePath = (pathStr?: string | null) => string;
type TrackedFolderImage = FolderImage & { image_id?: number | null };

export function buildTransformExportedFolderImage(
  response: TransformExportResponse,
  existing?: FolderImage,
): FolderImage {
  const trackedExisting = existing as TrackedFolderImage | undefined;
  return {
    ...existing,
    image_id: response.id ?? trackedExisting?.image_id ?? null,
    path: response.path,
    filename: getBasename(response.path, response.filename || "transform.png"),
    mtime: response.mtime || response.saved_at,
  } as TrackedFolderImage;
}

export function mergeTransformExportedFolderImage(
  images: FolderImage[],
  response: TransformExportResponse,
  normalizePath: NormalizePath,
): FolderImage[] {
  const exportedPath = normalizePath(response.path);
  const existingIndex = exportedPath
    ? images.findIndex((image) => normalizePath(image.path) === exportedPath)
    : -1;
  const existing = existingIndex >= 0 ? images[existingIndex] : undefined;
  const exportedImage = buildTransformExportedFolderImage(response, existing);

  if (!exportedPath) {
    return [exportedImage, ...images];
  }

  if (response.save_mode === "overwrite_current" && existingIndex >= 0) {
    const nextImages = [...images];
    nextImages[existingIndex] = exportedImage;
    return nextImages;
  }

  return [
    exportedImage,
    ...images.filter((image) => normalizePath(image.path) !== exportedPath),
  ];
}
