import type { FolderImage } from "@/lib/types";

type NormalizePath = (pathStr?: string | null) => string;

const mergeFolderImageFields = (
  currentImage: FolderImage,
  refreshedImage: FolderImage,
): FolderImage => ({
  ...currentImage,
  ...refreshedImage,
  width: refreshedImage.width ?? currentImage.width,
  height: refreshedImage.height ?? currentImage.height,
});

export function reconcileFolderImagesUsingRefreshedOrder(
  currentImages: FolderImage[],
  refreshedImages: FolderImage[],
  normalizePath: NormalizePath,
): FolderImage[] {
  const currentByPath = new Map<string, FolderImage>();
  currentImages.forEach((image) => {
    const normalizedPath = normalizePath(image.path);
    if (!normalizedPath || currentByPath.has(normalizedPath)) return;
    currentByPath.set(normalizedPath, image);
  });

  const seenPaths = new Set<string>();
  return refreshedImages.flatMap((image) => {
    const normalizedPath = normalizePath(image.path);
    if (!normalizedPath) {
      return [image];
    }
    if (seenPaths.has(normalizedPath)) {
      return [];
    }
    seenPaths.add(normalizedPath);
    const currentImage = currentByPath.get(normalizedPath);
    return [currentImage ? mergeFolderImageFields(currentImage, image) : image];
  });
}
