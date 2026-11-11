import { IMAGE_API_BASE } from "@/lib/api";

export const SWEET_TEA_CATALOG_DRAG_MIME = "application/x-sweet-tea-catalog-image";

export const SWEET_TEA_IMAGE_DRAG_MIME = "application/x-sweet-tea-image";

export function buildSweetTeaImageDragUrl(path: string): string {
  const params = new URLSearchParams({ path });
  return `${IMAGE_API_BASE}/gallery/image/path?${params.toString()}`;
}

export function writeSweetTeaImageDragData(
  dataTransfer: DataTransfer,
  rawPath: string | null | undefined,
  fallbackUrl?: string | null,
  catalog?: { imageId?: number; mediaUuid?: string | null },
): boolean {
  const path = String(rawPath || "").trim();
  if (!path) return false;

  const url = String(fallbackUrl || "").trim() || buildSweetTeaImageDragUrl(path);
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(SWEET_TEA_IMAGE_DRAG_MIME, path);
  if (catalog?.imageId) dataTransfer.setData(SWEET_TEA_CATALOG_DRAG_MIME, JSON.stringify(catalog));
  dataTransfer.setData("text/plain", url);
  dataTransfer.setData("text/uri-list", url);
  return true;
}
