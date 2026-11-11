import { API_BASE } from "@/shared/api";
import type { TransformFontInfo } from "@/shared/types";
import { formatLocalizedNumber } from "@/i18n/format";

export const TRANSFORM_FONTS_UPDATED_EVENT = "sweet-tea:transform-fonts-updated";

export const BUNDLED_FONT_OPTIONS = [
  "Bangers",
  "Chewy",
  "Comic Neue",
  "Knewave",
  "Luckiest Guy",
  "Permanent Marker",
  "Reggae One",
  "RocknRoll One",
];

export const SYSTEM_FONT_OPTIONS = [
  "Arial",
  "Comic Sans MS",
  "Georgia",
  "Trebuchet MS",
];

const loadedTransformFontIds = new Set<string>();

export function uniqueFonts(fonts: string[]): string[] {
  return Array.from(new Set(fonts));
}

export function sortFontOptions(fonts: string[]): string[] {
  return uniqueFonts(fonts).sort((a, b) => a.localeCompare(b));
}

export function buildTransformFontOptions(importedFonts: TransformFontInfo[] = []): string[] {
  return sortFontOptions([
    ...BUNDLED_FONT_OPTIONS,
    ...importedFonts.map((font) => font.name),
    ...SYSTEM_FONT_OPTIONS,
  ]);
}

export function getTransformFontFileUrl(fontId: string): string {
  return `${API_BASE}/transform/fonts/${encodeURIComponent(fontId)}/file`;
}

export async function loadManagedTransformFonts(fonts: TransformFontInfo[]): Promise<string[]> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    return [];
  }

  const loadedNames: string[] = [];
  for (const font of fonts) {
    if (!font.id || !font.name) {
      continue;
    }
    if (loadedTransformFontIds.has(font.id)) {
      loadedNames.push(font.name);
      continue;
    }

    try {
      const face = new FontFace(font.name, `url("${getTransformFontFileUrl(font.id)}")`);
      await face.load();
      document.fonts.add(face);
      loadedTransformFontIds.add(font.id);
      loadedNames.push(font.name);
    } catch {
      // Imported fonts are best-effort; a broken user font should not block transform.
    }
  }

  try {
    await document.fonts.ready;
  } catch {
    // Font readiness is best-effort in test and older browser environments.
  }

  return loadedNames;
}

export function isSupportedTransformFontFile(file: File, allowedExtensions: string[]): boolean {
  const normalizedName = file.name.toLowerCase();
  return allowedExtensions.some((extension) => normalizedName.endsWith(extension.toLowerCase()));
}

export function formatFontBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 KB";
  }
  if (sizeBytes < 1024 * 1024) {
    return `${formatLocalizedNumber(Math.max(1, Math.round(sizeBytes / 1024)))} KB`;
  }
  return `${formatLocalizedNumber(sizeBytes / (1024 * 1024), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MB`;
}
