import { API_BASE } from "./client";
import type {
  TransformDocument,
  TransformDocumentResponse,
  TransformExportResponse,
  TransformFontInfo,
  TransformFontsResponse,
  TransformLaunchResponse,
  TransformSaveMode,
} from "@/shared/types";

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, encoded] = dataUrl.split(",", 2);
  if (!header || !encoded) {
    throw new Error("Invalid paint layer data URL");
  }
  const mimeType = header.match(/^data:([^;]+);base64$/)?.[1] || "image/png";
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

type TransformDocumentSaveOptions = {
  paintLayerFiles?: Array<{ layerId: string; file: Blob | File }>;
  maskDraftFile?: File | null;
  maskBaseFile?: File | null;
  clearMaskDraft?: boolean;
};

export type TransformMaskApplyResponse = {
  filename: string;
  path: string;
  comfy_filename: string;
  width: number;
  height: number;
};

function buildTransformDocumentBody(
  document: TransformDocument,
  options: TransformDocumentSaveOptions = {},
): BodyInit {
  const paintLayersWithData = document.edit.paintLayers.filter((layer) => layer.dataUrl);
  const imageLayersWithData = document.edit.imageLayers.filter((layer) => layer.dataUrl);
  const paintLayerFiles = options.paintLayerFiles || [];
  if (
    !paintLayersWithData.length &&
    !imageLayersWithData.length &&
    !paintLayerFiles.length &&
    !options.maskDraftFile &&
    !options.clearMaskDraft
  ) {
    return JSON.stringify({ document });
  }

  const documentPayload: TransformDocument = JSON.parse(JSON.stringify(document));
  const formData = new FormData();
  for (const layer of documentPayload.edit.paintLayers) {
    if (!layer.dataUrl) {
      continue;
    }
    formData.append("paint_layer_id", layer.id);
    formData.append("paint_layer_file", dataUrlToBlob(layer.dataUrl), `${layer.id}.png`);
    layer.dataUrl = null;
  }
  for (const paintLayerFile of paintLayerFiles) {
    formData.append("paint_layer_id", paintLayerFile.layerId);
    formData.append("paint_layer_file", paintLayerFile.file, `${paintLayerFile.layerId}.png`);
  }
  for (const layer of documentPayload.edit.imageLayers) {
    if (!layer.dataUrl) {
      continue;
    }
    formData.append("image_layer_id", layer.id);
    formData.append("image_layer_file", dataUrlToBlob(layer.dataUrl), `${layer.id}.png`);
    layer.dataUrl = null;
  }
  if (options.maskDraftFile) {
    formData.append("mask_draft_file", options.maskDraftFile, "draft.png");
  }
  if (options.maskBaseFile) formData.append("mask_base_file", options.maskBaseFile, "base.png");
  if (options.clearMaskDraft) {
    formData.append("mask_draft_clear", "true");
  }
  formData.append("document_json", JSON.stringify(documentPayload));
  return formData;
}

export type TransformOutpaintPrepareResponse = {
  preparation_id: string; width: number; height: number;
  frame: { x: number; y: number; width: number; height: number };
  paths: Record<"image" | "mask" | "alpha", string>;
  inputs: Partial<Record<"image" | "mask" | "alpha", string>>;
};

// Serialize document writes per source. Different images remain independent.
const documentWrites = new Map<string, Promise<TransformDocumentResponse>>();
const documentVersions = new Map<string, {id: string; revision: number}>();

export const transformApi = {
  transformRevisions: async (path: string, signal: AbortSignal): Promise<{items: {id: string; conflict: boolean; saved_at: string}[]}> => {
    const response = await fetch(API_BASE + "/transform/revisions?image_path=" + encodeURIComponent(path), {signal, cache: "no-store"});
    if (!response.ok) throw new Error("Edit revisions could not be loaded.");
    return response.json();
  },
  readTransformRevision: async (path: string, id: string): Promise<TransformDocumentResponse> => {
    const response = await fetch(API_BASE + "/transform/revisions/" + encodeURIComponent(id) + "?image_path=" + encodeURIComponent(path), {cache: "no-store"});
    if (!response.ok) {const error = await response.json().catch(() => ({})); throw new Error(error.detail || "This revision could not be opened.");}
    return response.json();
  },

  prepareTransformOutpaint: async (payload: {
    compositionFile: Blob; coverageFile?: File | null; document: TransformDocument;
    engineId?: number; projectSlug?: string | null; subfolder?: string | null; stageInputs?: boolean;
  }): Promise<TransformOutpaintPrepareResponse> => {
    const body = new FormData(); body.append("composition_file", payload.compositionFile, "composition.png");
    body.append("source_path", payload.document.sourceImage.path); body.append("document_json", JSON.stringify(payload.document));
    if (payload.coverageFile) body.append("coverage_file", payload.coverageFile, "coverage.png");
    if (payload.engineId != null) body.append("engine_id", String(payload.engineId));
    if (payload.projectSlug) body.append("project_slug", payload.projectSlug);
    if (payload.subfolder) body.append("subfolder", payload.subfolder);
    body.append("stage_inputs", String(Boolean(payload.stageInputs)));
    const response = await fetch(`${API_BASE}/transform/prepare-outpaint`, { method: "POST", body });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.detail || "Could not prepare the expanded image and mask."); }
    return response.json();
  },
  getTransformLaunch: async (imagePath: string): Promise<TransformLaunchResponse> => {
    const res = await fetch(
      `${API_BASE}/transform/launch?image_path=${encodeURIComponent(imagePath)}`,
    );
    if (!res.ok) {
      throw new Error("Failed to load transform launch state");
    }
    const result = await res.json() as TransformLaunchResponse;
    const key = result.resolved_source_path;
    if (!documentWrites.has(key)) {
      if (result.document) documentVersions.set(key, {id: result.document.id, revision: result.document.recipeRevision ?? 0});
      else documentVersions.delete(key);
    }
    return result;
  },

  saveTransformDocument: async (
    document: TransformDocument,
    options?: TransformDocumentSaveOptions,
  ): Promise<TransformDocumentResponse> => {
    const body = buildTransformDocumentBody(document, options);
    const headers = body instanceof FormData ? undefined : { "Content-Type": "application/json" };
    const key = document.sourceImage.path;
    const previous = documentWrites.get(key);
    const pending = (async () => {
      const prior = previous ? await previous.catch(() => undefined) : undefined;
      const known = documentVersions.get(key);
      const expected = Math.max(document.recipeRevision ?? 0,
        known?.id === document.id ? known.revision : 0,
        prior?.document.id === document.id ? prior.document.recipeRevision ?? 0 : 0);
      const requestHeaders = {...headers, "X-Studio-Recipe-Revision": String(expected)};
      const res = await fetch(`${API_BASE}/transform/documents`, { method: "POST", headers: requestHeaders, body });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.detail?.message || error.detail || "Failed to save transform document");
      }
      const result = await res.json() as TransformDocumentResponse;
      documentVersions.delete(key);
      documentVersions.set(key, {id: document.id, revision: result.document.recipeRevision ?? 0});
      if (documentVersions.size > 256) documentVersions.delete(documentVersions.keys().next().value!);
      return result;
    })();
    documentWrites.set(key, pending);
    try { return await pending; }
    finally { if (documentWrites.get(key) === pending) documentWrites.delete(key); }
  },

  exportTransformDocument: async (payload: {
    file: Blob;
    filename: string;
    document: TransformDocument;
    sourcePath: string;
    renderGeometry?: {
      width: number;
      height: number;
      offsetX: number;
      offsetY: number;
    } | null;
    saveMode?: TransformSaveMode;
    launchImagePath?: string | null;
    targetProjectSlug?: string | null;
    targetFolder?: string | null;
    requestedFilename?: string | null;
  }): Promise<TransformExportResponse> => {
    const key = payload.sourcePath;
    const previous = documentWrites.get(key);
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
    const formData = new FormData();
    formData.append("file", payload.file, payload.filename);
    const known = documentVersions.get(payload.sourcePath);
    const document = {...payload.document, recipeRevision: Math.max(payload.document.recipeRevision ?? 0,
      known?.id === payload.document.id ? known.revision : 0)};
    formData.append("document_json", JSON.stringify(document));
    formData.append("source_path", payload.sourcePath);
    if (payload.renderGeometry) {
      formData.append("render_geometry_json", JSON.stringify(payload.renderGeometry));
    }
    if (payload.saveMode) {
      formData.append("save_mode", payload.saveMode);
    }
    if (payload.launchImagePath) {
      formData.append("launch_image_path", payload.launchImagePath);
    }
    if (payload.targetProjectSlug) {
      formData.append("target_project_slug", payload.targetProjectSlug);
    }
    if (payload.targetFolder) {
      formData.append("target_folder", payload.targetFolder);
    }
    if (payload.requestedFilename) {
      formData.append("requested_filename", payload.requestedFilename);
    }

    const res = await fetch(`${API_BASE}/transform/export`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.detail?.message || error.detail || "Failed to export transform document");
    }
    const result = await res.json() as TransformExportResponse;
    if (result.source_recipe_revision != null) documentVersions.set(payload.sourcePath, {id: document.id, revision: result.source_recipe_revision});
    else documentVersions.delete(payload.sourcePath);
    return result;
    })();
    const slot = pending.then(result => ({document: {...payload.document, recipeRevision: result.source_recipe_revision ?? 0}, saved_at: result.saved_at}));
    void slot.catch(() => undefined);
    documentWrites.set(key, slot);
    try {return await pending;}
    finally {if (documentWrites.get(key) === slot) documentWrites.delete(key);}

  },

  applyTransformMask: async (payload: {
    coverageFile: File;
    sourcePath: string;
    engineId?: number | null;
    projectSlug?: string | null;
    subfolder?: string | null;
  }, init?: RequestInit): Promise<TransformMaskApplyResponse> => {
    const formData = new FormData();
    formData.append("coverage_file", payload.coverageFile, "coverage.png");
    formData.append("source_path", payload.sourcePath);
    if (payload.engineId != null) {
      formData.append("engine_id", String(payload.engineId));
    }
    if (payload.projectSlug) {
      formData.append("project_slug", payload.projectSlug);
    }
    if (payload.subfolder) {
      formData.append("subfolder", payload.subfolder);
    }
    const res = await fetch(`${API_BASE}/transform/apply-mask`, {
      ...init,
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to apply mask to image");
    }
    return res.json();
  },

  getTransformFonts: async (): Promise<TransformFontsResponse> => {
    const res = await fetch(`${API_BASE}/transform/fonts`);
    if (!res.ok) {
      throw new Error("Failed to load transform fonts");
    }
    return res.json();
  },

  uploadTransformFont: async (file: File): Promise<TransformFontInfo> => {
    const formData = new FormData();
    formData.append("file", file, file.name);
    const res = await fetch(`${API_BASE}/transform/fonts`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to import transform font");
    }
    return res.json();
  },

  deleteTransformFont: async (fontId: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/transform/fonts/${encodeURIComponent(fontId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.detail || "Failed to delete transform font");
    }
  },
};
