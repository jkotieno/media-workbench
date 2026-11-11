import { IMAGE_API_BASE } from "@/lib/api";
import type { TransformImageLayer, TransformPaintLayer, TransformSourceImage } from "@/shared/types";

export function buildImageUrl(path: string, version?: string | number | null): string {
  const params = new URLSearchParams({ path });
  if (version !== undefined && version !== null && `${version}`.length > 0) {
    params.set("v", `${version}`);
  }
  return `${IMAGE_API_BASE}/gallery/image/path?${params.toString()}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to create export blob"));
        return;
      }
      resolve(blob);
    }, mimeType, mimeType === "image/jpeg" ? 0.95 : 0.98);
  });
}

function loadImageSource(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load transform layer image"));
    image.src = src;
  });
}

export async function createImageElementFromTransformLayer(
  layer: TransformImageLayer,
): Promise<HTMLImageElement | null> {
  const source = layer.dataUrl || (layer.assetPath ? buildImageUrl(layer.assetPath) : null);
  return source ? loadImageSource(source) : null;
}

export function readImageBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/")) {
        resolve(reader.result);
      } else {
        reject(new Error("The selected file is not a readable image."));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read image."));
    reader.readAsDataURL(blob);
  });
}

export async function getImageDimensionsFromDataUrl(
  dataUrl: string,
): Promise<{ width: number; height: number }> {
  const image = await loadImageSource(dataUrl);
  return {
    width: Math.max(1, image.naturalWidth || image.width),
    height: Math.max(1, image.naturalHeight || image.height),
  };
}

export async function createCanvasFromPaintLayer(
  layer: TransformPaintLayer,
  sourceImage: Pick<TransformSourceImage, "width" | "height">,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const source = layer.dataUrl || (layer.assetPath ? buildImageUrl(layer.assetPath) : null);
  if (source) {
    const image = await loadImageSource(source);
    context?.drawImage(image, 0, 0, sourceImage.width, sourceImage.height);
  }
  return canvas;
}

export function cloneCanvas(
  sourceCanvas: HTMLCanvasElement,
  sourceImage: Pick<TransformSourceImage, "width" | "height">,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context?.drawImage(sourceCanvas, 0, 0, sourceImage.width, sourceImage.height);
  return canvas;
}

export async function createCanvasFromBlob(
  blob: Blob,
  sourceImage: Pick<TransformSourceImage, "width" | "height">,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.width;
  canvas.height = sourceImage.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (typeof URL.createObjectURL !== "function") {
    return canvas;
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImageSource(objectUrl);
    context?.drawImage(image, 0, 0, sourceImage.width, sourceImage.height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return canvas;
}
