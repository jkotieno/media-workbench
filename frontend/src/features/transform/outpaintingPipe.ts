import type { WorkflowTemplate } from "@/shared/types";

export type OutpaintingBinding = {
  imageField: string; maskField?: string; convention: "alpha" | "separate"; alignment?: number;
};

type Node = { class_type?: string; inputs?: Record<string, unknown> };
export function missingOutpaintingInputs(pipe: Pick<WorkflowTemplate, "graph_json" | "node_mapping" | "input_schema">,
  objectInfo: Record<string, unknown>): string[] {
  return Object.entries(pipe.graph_json).flatMap(([id, raw]) => {
    const node = raw as Node;
    const definition = objectInfo[node.class_type || ""] as { input?: { required?: Record<string, unknown> } } | undefined;
    return Object.keys(definition?.input?.required || {}).filter(field => !Object.prototype.hasOwnProperty.call(node.inputs || {}, field)
      && !Object.entries(pipe.node_mapping || {}).some(([key, rawMapping]) => {
        const mapping = rawMapping as { node_id?: string; field?: string };
        return String(mapping.node_id) === id && mapping.field === `inputs.${field}` && Boolean(pipe.input_schema[key]);
      })).map(field => `${node.class_type}#${id}.${field}`);
  });
}
const intensityConverters = new Set(["Image To Mask", "Image To Mask Masquerade"]);
const link = (value: unknown, id: string, slot: number) => Array.isArray(value) && value.length === 2 && String(value[0]) === id && value[1] === slot;

/** Compatibility comes from field mappings and connections, never a field's display name. */
export function outpaintingBindings(pipe: Pick<WorkflowTemplate, "graph_json" | "input_schema" | "node_mapping">): OutpaintingBinding[] {
  const graph = pipe.graph_json as Record<string, Node>;
  if (!graph || Object.values(graph).some(node => node.class_type === "ImagePadForOutpaint"
    || (node.class_type === "InpaintCropImproved" && node.inputs?.extend_for_outpainting === true))) return [];
  const saved = Object.entries(graph).filter(([, node]) => /^(SaveImage|PreviewImage|ST.*Save.*Image)$/.test(node.class_type || "")).map(([id]) => id);
  if (!saved.length) return [];
  const reachable = new Set<string>(); const pending = [...saved];
  while (pending.length) {
    const id = pending.pop()!; if (reachable.has(id)) continue; reachable.add(id);
    for (const v of Object.values(graph[id]?.inputs || {})) if (Array.isArray(v) && v.length === 2 && graph[String(v[0])]) pending.push(String(v[0]));
  }
  if (![...reachable].some(id => /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/.test(graph[id]?.class_type || ""))) return [];
  const fields = Object.entries(pipe.node_mapping || {}).flatMap(([field, raw]) => {
    const mapping = raw as { node_id?: string; field?: string };
    const id = String(mapping.node_id || ""); const spec = pipe.input_schema[field] as { type?: string } | undefined;
    return spec?.type === "string" && mapping.field === "inputs.image" && graph[id]?.class_type === "LoadImage" && reachable.has(id) ? [{ field, id }] : [];
  });
  const consumers = (id: string, slot: number) => Object.entries(graph).filter(([nodeId, node]) => reachable.has(nodeId)
    && Object.values(node.inputs || {}).some(v => link(v, id, slot)));
  const hasMaskUse = (id: string, slot: number) => consumers(id, slot).some(([, node]) => Object.entries(node.inputs || {}).some(([name, v]) => /mask/i.test(name) && link(v, id, slot)));
  const images = fields.filter(({ id }) => consumers(id, 0).some(([, node]) => node.class_type !== "ImageToMask" && !intensityConverters.has(node.class_type || "") && node.class_type !== "MaskToImage"));
  const masks = fields.filter(({ id }) => consumers(id, 0).some(([convertId, node]) =>
    ((node.class_type === "ImageToMask" && ["red", "green", "blue"].includes(String(node.inputs?.channel)))
      || (intensityConverters.has(node.class_type || "") && node.inputs?.method === "intensity")) && hasMaskUse(convertId, 0)));
  const metadata = pipe.input_schema.__outpainting as { alignment?: unknown } | undefined;
  const alignment = typeof metadata?.alignment === "number" && Number.isSafeInteger(metadata.alignment) && metadata.alignment > 0 ? metadata.alignment : undefined;
  return images.flatMap(image => [
    ...(hasMaskUse(image.id, 1) ? [{ imageField: image.field, convention: "alpha" as const, alignment }] : []),
    ...masks.filter(mask => mask.field !== image.field).map(mask => ({ imageField: image.field, maskField: mask.field, convention: "separate" as const, alignment })),
  ]);
}

export function outpaintingInputUpdates(binding: OutpaintingBinding, inputs: Partial<Record<"image" | "mask" | "alpha", string>>): Record<string, string> {
  const image = inputs[binding.convention === "alpha" ? "alpha" : "image"];
  if (!image || (binding.convention === "separate" && (!binding.maskField || !inputs.mask))) throw new Error("Both prepared inputs must be available before binding the Pipe.");
  return binding.convention === "alpha" ? { [binding.imageField]: image }
    : { [binding.imageField]: image, [binding.maskField!]: inputs.mask! };
}
