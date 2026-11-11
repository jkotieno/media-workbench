import type { FolderImage, GalleryItem, Image as ApiImage } from "@/lib/api";

export interface ProjectGalleryProvisionalImage extends FolderImage {
  projectId: string | null;
  folder: string | null;
  status: "saving" | "syncing";
  jobId?: number;
}

export interface PromptStudioProvisionalMedia
  extends ProjectGalleryProvisionalImage {
  normalizedPath: string;
  image: ApiImage;
  galleryItem: GalleryItem;
  createdAtMs: number;
}

export type PromptStudioProvisionalMediaUpsertInput = {
  jobId: number;
  image: ApiImage;
  prompt?: string | null;
  negativePrompt?: string | null;
  jobParams?: Record<string, unknown>;
  workflowTemplateId?: number;
  projectId: string | null;
  folder: string | null;
  status: ProjectGalleryProvisionalImage["status"];
};

type NormalizePath = (pathStr?: string | null) => string;

const normalizeFilename = (filename?: string | null): string =>
  String(filename || "").trim().toLowerCase();

export const buildPromptStudioProvisionalMediaEntries = (
  items: PromptStudioProvisionalMediaUpsertInput[],
  normalizePath: NormalizePath,
  nowMs: number = Date.now(),
): PromptStudioProvisionalMedia[] => {
  return items.flatMap((item) => {
    const normalizedPath = normalizePath(item.image.path);
    if (!normalizedPath) return [];

    const createdAt =
      item.image.created_at || new Date(nowMs).toISOString();
    const jobParams = item.jobParams || {};

    return [
      {
        path: item.image.path,
        filename: item.image.filename,
        mtime: createdAt,
        projectId: item.projectId,
        folder: item.folder,
        status: item.status,
        jobId: item.jobId,
        normalizedPath,
        createdAtMs: nowMs,
        image: item.image,
        galleryItem: {
          image: item.image,
          job_params: jobParams,
          prompt: item.prompt || undefined,
          negative_prompt: item.negativePrompt || undefined,
          prompt_history: [],
          workflow_template_id: item.workflowTemplateId,
          created_at: createdAt,
          project_id: item.projectId
            ? Number.parseInt(item.projectId, 10) || null
            : null,
        },
      },
    ];
  });
};

export const upsertPromptStudioProvisionalMedia = (
  existingItems: PromptStudioProvisionalMedia[],
  incomingItems: PromptStudioProvisionalMedia[],
): PromptStudioProvisionalMedia[] => {
  if (incomingItems.length === 0) return existingItems;

  const incomingPaths = new Set(
    incomingItems.map((item) => item.normalizedPath),
  );
  const dedupedExisting = existingItems.filter(
    (item) => !incomingPaths.has(item.normalizedPath),
  );

  return [...incomingItems, ...dedupedExisting];
};

export const mergeRecentGalleryItemsWithProvisional = (
  items: GalleryItem[],
  provisionalMedia: PromptStudioProvisionalMedia[],
  normalizePath: NormalizePath,
): GalleryItem[] => {
  if (provisionalMedia.length === 0) return items;

  const merged: GalleryItem[] = [];
  const seen = new Set<string>();
  const seenStableIds = new Set<string>();

  provisionalMedia.forEach((item) => {
    const filenameKey = normalizeFilename(item.image.filename);
    const stableId =
      typeof item.image.id === "number" && item.image.id > 0 && filenameKey
        ? `${item.image.id}|${filenameKey}`
        : null;
    if (!item.normalizedPath || seen.has(item.normalizedPath)) return;
    if (stableId && seenStableIds.has(stableId)) return;
    seen.add(item.normalizedPath);
    if (stableId) seenStableIds.add(stableId);
    merged.push(item.galleryItem);
  });

  items.forEach((item) => {
    const normalizedPath = normalizePath(item.image.path);
    const filenameKey = normalizeFilename(item.image.filename);
    const stableId =
      typeof item.image.id === "number" && item.image.id > 0 && filenameKey
        ? `${item.image.id}|${filenameKey}`
        : null;
    if (!normalizedPath || seen.has(normalizedPath)) return;
    if (stableId && seenStableIds.has(stableId)) return;
    seen.add(normalizedPath);
    if (stableId) seenStableIds.add(stableId);
    merged.push(item);
  });

  return merged;
};

export const mergeProjectGalleryImagesWithProvisional = (
  images: FolderImage[],
  provisionalImages: ProjectGalleryProvisionalImage[],
  normalizePath: NormalizePath,
): FolderImage[] => {
  if (provisionalImages.length === 0) return images;

  const merged: FolderImage[] = [];
  const seen = new Set<string>();
  const seenFilenames = new Set<string>();

  provisionalImages.forEach((image) => {
    const normalizedPath = normalizePath(image.path);
    const filenameKey = normalizeFilename(image.filename);
    if (!normalizedPath || seen.has(normalizedPath)) return;
    if (filenameKey && seenFilenames.has(filenameKey)) return;
    seen.add(normalizedPath);
    if (filenameKey) seenFilenames.add(filenameKey);
    merged.push(image);
  });

  images.forEach((image) => {
    const normalizedPath = normalizePath(image.path);
    const filenameKey = normalizeFilename(image.filename);
    if (!normalizedPath || seen.has(normalizedPath)) return;
    if (filenameKey && seenFilenames.has(filenameKey)) return;
    seen.add(normalizedPath);
    if (filenameKey) seenFilenames.add(filenameKey);
    merged.push(image);
  });

  return merged;
};

export const removePromptStudioProvisionalMediaByPaths = (
  items: PromptStudioProvisionalMedia[],
  paths: string[],
  normalizePath: NormalizePath,
  scope?: { projectId?: string | null; folder?: string | null },
): PromptStudioProvisionalMedia[] => {
  const normalizedPaths = new Set(
    paths.map((pathStr) => normalizePath(pathStr)).filter(Boolean),
  );
  if (normalizedPaths.size === 0) return items;

  return items.filter((item) => {
    if (!normalizedPaths.has(item.normalizedPath)) return true;
    if (
      scope?.projectId !== undefined &&
      item.projectId !== (scope.projectId ?? null)
    ) {
      return true;
    }
    if (scope?.folder !== undefined && item.folder !== (scope.folder ?? null)) {
      return true;
    }
    return false;
  });
};

export const removePromptStudioProvisionalMediaByJobId = (
  items: PromptStudioProvisionalMedia[],
  jobId: number | null | undefined,
): PromptStudioProvisionalMedia[] => {
  if (!jobId || jobId <= 0) return items;
  return items.filter((item) => item.jobId !== jobId);
};

export const syncPromptStudioProvisionalMediaImage = (
  items: PromptStudioProvisionalMedia[],
  updatedImage: ApiImage,
  normalizePath: NormalizePath,
): PromptStudioProvisionalMedia[] => {
  const normalizedPath = normalizePath(updatedImage.path);
  if (!normalizedPath) return items;

  return items.map((item) =>
    item.normalizedPath === normalizedPath
      ? {
          ...item,
          image: updatedImage,
          galleryItem: {
            ...item.galleryItem,
            image: updatedImage,
          },
        }
      : item,
  );
};

export const reapExpiredPromptStudioProvisionalMedia = (
  items: PromptStudioProvisionalMedia[],
  nowMs: number,
  ttlMs: number,
): PromptStudioProvisionalMedia[] => {
  return items.filter((item) => nowMs - item.createdAtMs < ttlMs);
};
