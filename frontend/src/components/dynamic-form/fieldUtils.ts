// Helper utilities for DynamicForm field rendering and grouping.

import { isPromptSchemaField } from "@/lib/promptUtils";

import type { DynamicFormField, DynamicFormFieldAnnotation, FormSection } from "./types";

export const resolveMediaKind = (
  fieldKey: string,
  field: DynamicFormField,
): "image" | "video" | "audio" => {
  const explicit = typeof field.x_media_kind === "string" ? field.x_media_kind.toLowerCase() : null;
  if (explicit === "image" || explicit === "video" || explicit === "audio") {
    return explicit;
  }

  const key = fieldKey.toLowerCase();
  const classType = String(field.x_class_type || "").toLowerCase();
  if (key.endsWith(".video") && classType.includes("loadvideo")) {
    return "video";
  }
  if (key.endsWith(".audio") && (classType.includes("loadaudio") || classType.includes("recordaudio"))) {
    return "audio";
  }
  return "image";
};

export const resolveNodeTitle = (field: DynamicFormField, fallback = "Configuration") => {
  const alias = typeof field.x_node_alias === "string" ? field.x_node_alias.trim() : "";
  if (alias) return alias;

  const explicit = typeof field.x_title === "string" ? field.x_title.trim() : "";
  if (explicit) return explicit;

  const title = String(field.title || "").trim();
  const match = title.match(/\(([^)]+)\)\s*$/);
  if (match && match[1]) return match[1];

  const classType = String(field.x_class_type || "").trim();
  if (classType) return classType;

  return title || fallback;
};

export const resolveParamTitle = (fieldKey: string, field: DynamicFormField) => {
  const raw = String(field.title || fieldKey).trim();
  const match = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return raw;
  const base = (match[1] || "").trim();
  return base || raw;
};

export const resolveParamTooltip = (field: DynamicFormField) => {
  const pick = (value: unknown) => {
    if (typeof value !== "string") return null;
    const cleaned = value.trim();
    return cleaned ? cleaned : null;
  };

  return (
    pick(field.x_tooltip) ||
    pick(field.tooltip) ||
    pick(field.description) ||
    pick(field["x_description"]) ||
    pick(field["help"]) ||
    pick(field["x_help"]) ||
    ""
  );
};

export const isMediaUploadField = (fieldKey: string, field: DynamicFormField) => {
  const key = fieldKey.toLowerCase();
  const title = String(field.title || "").toLowerCase();
  const classType = String(field.x_class_type || "").toLowerCase();
  const isExplicit =
    field.widget === "media_upload" ||
    field.widget === "image_upload" ||
    (field.widget === "upload" && resolveMediaKind(fieldKey, field) === "image");
  const isLoadImage = title.includes("loadimage");
  const isVideoInput = key.endsWith(".video") && classType.includes("loadvideo");
  const isAudioInput = key.endsWith(".audio") && (classType.includes("loadaudio") || classType.includes("recordaudio"));
  const isStringLike = field.type === "string" || Array.isArray(field.enum);

  return (isExplicit || isLoadImage || isVideoInput || isAudioInput) && isStringLike;
};

export const resolveFieldSection = (
  key: string,
  field: DynamicFormField,
  annotation?: DynamicFormFieldAnnotation,
): { section: FormSection; reason: string } => {
  if (isPromptSchemaField(key, field)) {
    return { section: "prompts", reason: "prompt_field" };
  }
  if (annotation?.section) {
    const normalizedSection = annotation.section === "inputs" ? "nodes" : annotation.section;
    const annotationIsGenericDefault =
      String(annotation.groupId || "").trim().toLowerCase() === "default" &&
      String(annotation.groupTitle || "").trim().toLowerCase() === "default";
    return {
      section: normalizedSection,
      reason: annotationIsGenericDefault ? "repaired_default_annotation" : "explicit_annotation",
    };
  }
  if (isMediaUploadField(key, field)) {
    return { section: "nodes", reason: "media_upload" };
  }
  if (
    field.x_class_type === "LoraLoader" ||
    (field.title != null && field.title.includes("LoraLoader"))
  ) {
    return { section: "loras", reason: "lora_loader" };
  }
  return { section: "nodes", reason: "fallback_configuration" };
};
