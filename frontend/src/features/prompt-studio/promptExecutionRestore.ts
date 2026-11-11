import type { ImageSourceExecution } from "@/shared/types/gallery.types";
import type {
  WorkflowGraph,
  WorkflowInputField,
  WorkflowInputSchema,
  WorkflowNodeMapping,
} from "@/shared/types/workflow.types";
import { getWorkflowGraphNodeEntries, getWorkflowInputFieldEntries } from "@/shared/workflow/workflowStructure";
import { isRandomSeedPlaceholder } from "@/lib/metadataSeed";
import { remapParamsToSchemaKeys } from "./promptStudioUtils";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const hasValue = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
const escapePointer = (token: string) => token.replace(/~/g, "~0").replace(/\//g, "~1");
const pointerTokens = (pointer: string) =>
  pointer.slice(1).split("/").map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));

const mappingPointers = (value: unknown): string[] => {
  const mapping = asRecord(value);
  if (!mapping) return [];
  if (Array.isArray(mapping.targets)) return mapping.targets.flatMap(mappingPointers);
  if (typeof mapping.json_pointer === "string") return [mapping.json_pointer];
  if (mapping.node_id === undefined || typeof mapping.field !== "string") return [];
  return ["/" + [String(mapping.node_id), ...mapping.field.split(".")].map(escapePointer).join("/")];
};

export const fieldPointers = (
  key: string,
  field: WorkflowInputField,
  mapping: WorkflowNodeMapping | null | undefined,
): string[] => {
  const mapped = mappingPointers(mapping?.[key]);
  if (mapped.length) return [...new Set(mapped)].sort();
  if (Array.isArray(field.x_tea_targets)) {
    const pointers = field.x_tea_targets.filter((value): value is string =>
      typeof value === "string" && value.startsWith("/"));
    if (pointers.length) return [...new Set(pointers)].sort();
  }
  const token = key.split(".")[0];
  // Older images stored ClassType_nodeId keys without a schema snapshot.
  // Decode their numeric node suffix just as precisely as newer #node keys.
  const nodeId = field.x_node_id ?? token.match(/(?:#|_(?=[0-9]+$))([^.#]+)$/)?.[1] ?? (/^\d+$/.test(token) ? token : null);
  if (nodeId === null) return [];
  const inputName = typeof field.mock_field === "string" && field.mock_field.trim()
    ? field.mock_field.trim()
    : key.split(".").slice(-1)[0].replace(/__(?:omega|alpha)(?:_\d+)?$/i, "");
  return ["/" + [String(nodeId), "inputs", inputName].map(escapePointer).join("/")];
};

const pointerValue = (graph: WorkflowGraph | null | undefined, pointer: string): unknown => {
  let value: unknown = graph;
  for (const token of pointerTokens(pointer)) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, token)) return undefined;
    value = (value as Record<string, unknown>)[token];
  }
  return value;
};

const isGraphLink = (value: unknown, graph: WorkflowGraph | null | undefined, field: WorkflowInputField) =>
  field.x_sts_literal_input !== true && Array.isArray(value) && value.length === 2 &&
  (typeof value[0] === "string" || typeof value[0] === "number") &&
  typeof value[1] === "number" && Boolean(asRecord(graph?.[String(value[0])]));

/** Historical inspection may recover an unambiguous submitted literal, never a current/schema default. */
export const readSavedExecutionControl = (key: string, field: WorkflowInputField, mapping: WorkflowNodeMapping | null | undefined, graph: WorkflowGraph | null | undefined): unknown => {
  const value = readGraphField(graph, fieldPointers(key, field, mapping), field);
  return isGraphLink(value, graph, field) ? undefined : value;
};

const readGraphField = (
  graph: WorkflowGraph | null | undefined,
  pointers: string[],
  field: WorkflowInputField,
): unknown => {
  if (!graph || !pointers.length) return undefined;
  const values = pointers.map((pointer) => pointerValue(graph, pointer));
  if (values.some((value) => value === undefined)) return undefined;
  if (!values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))) return undefined;
  const value = values[0];
  if (field.x_sts_codec?.transport === "json-string" && typeof value === "string") {
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
  }
  return value;
};

const graphFieldDisagrees = (graph: WorkflowGraph | null | undefined, pointers: string[]) => {
  const values = pointers.map((pointer) => pointerValue(graph, pointer)).filter((value) => value !== undefined);
  return values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]));
};

export const isExecutionSeedField = (key: string, field: WorkflowInputField, pointers: string[] = []) => {
  const keyLeaf = key.split(".").slice(-1)[0].toLowerCase();
  const leaf = String(typeof field.mock_field === "string" ? field.mock_field : keyLeaf).toLowerCase();
  return keyLeaf === "seed" || keyLeaf === "noise_seed" || leaf === "seed" || leaf === "noise_seed" || pointers.some((pointer) => {
    const inputName = pointerTokens(pointer).slice(-1)[0].toLowerCase();
    return inputName === "seed" || inputName === "noise_seed";
  });
};

export class IncompleteExecutionStateError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`This image is missing recorded execution values for: ${fields.join(", ")}. Regeneration cannot substitute the Pipe's current defaults.`);
    this.name = "IncompleteExecutionStateError";
    this.fields = fields;
  }
}

export const restorePromptExecutionValues = ({
  schema,
  graph,
  nodeMapping,
  sourceExecution,
  parameterSources,
  randomizeSeed = false,
}: {
  schema: WorkflowInputSchema;
  graph: WorkflowGraph;
  nodeMapping?: WorkflowNodeMapping | null;
  sourceExecution?: ImageSourceExecution | null;
  parameterSources: Array<Record<string, unknown> | null | undefined>;
  randomizeSeed?: boolean;
}): Record<string, unknown> => {
  const fields = getWorkflowInputFieldEntries(schema);
  const sources = [sourceExecution?.parameters, ...parameterSources].filter(
    (value): value is Record<string, unknown> => Boolean(asRecord(value)),
  );
  // A Pipe editor may remove a bypass toggle without removing its underlying
  // node. Recorded effective bypass remains execution state in that case.
  const fieldKeys = new Set(fields.map(([key]) => key));
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("__bypass_") && typeof value === "boolean" &&
          asRecord(graph[key.slice("__bypass_".length)]) && !fieldKeys.has(key)) {
        fields.push([key, { type: "boolean", x_node_id: key.slice("__bypass_".length) }]);
        fieldKeys.add(key);
      }
    }
  }
  const remapped = sources.map((source) => remapParamsToSchemaKeys(schema, source));
  const sourceFields = getWorkflowInputFieldEntries(sourceExecution?.input_schema);
  const restored: Record<string, unknown> = {};
  const missing: string[] = [];
  const seedFields = fields.filter(([key, field]) => isExecutionSeedField(key, field, fieldPointers(key, field, nodeMapping)));

  for (const [key, field] of fields) {
    if (field.x_skip_runtime_mapping === true && !key.startsWith("__bypass_")) continue;
    const pointers = fieldPointers(key, field, nodeMapping);
    const seedField = isExecutionSeedField(key, field, pointers);
    if (seedField && randomizeSeed) { restored[key] = -1; continue; }
    const usable = (value: unknown) => value !== undefined &&
      (!seedField || (value !== null && value !== "" && !isRandomSeedPlaceholder(value)));
    let value: unknown;
    // Match recorded fields by execution bindings, never by their editable labels.
    const recordedKeys = sourceFields.filter(([sourceKey, sourceField]) =>
      pointers.length > 0 && JSON.stringify(fieldPointers(sourceKey, sourceField, sourceExecution?.node_mapping)) === JSON.stringify(pointers),
    ).map(([sourceKey]) => sourceKey);
    for (const source of sources) {
      for (const sourceKey of recordedKeys) {
        if (hasValue(source, sourceKey) && usable(source[sourceKey])) { value = source[sourceKey]; break; }
      }
      if (usable(value)) break;
      const recordedField = sourceFields.find(([sourceKey]) => sourceKey === key);
      const keyStillBound = key.startsWith("__bypass_") || Boolean(recordedField &&
        JSON.stringify(fieldPointers(key, recordedField[1], sourceExecution?.node_mapping)) === JSON.stringify(pointers));
      if (keyStillBound && hasValue(source, key) && usable(source[key])) { value = source[key]; break; }
    }
    if (!usable(value) && graphFieldDisagrees(sourceExecution?.execution_graph, pointers)) { missing.push(key); continue; }
    if (!usable(value)) value = readGraphField(sourceExecution?.execution_graph, pointers, field);
    if (!usable(value) && key.startsWith("__bypass_")) {
      const nodeId = key.slice("__bypass_".length);
      const historicalField = asRecord(sourceExecution?.input_schema?.[key]);
      const originalNode = asRecord(sourceExecution?.graph_json?.[nodeId]);
      if (sourceExecution?.execution_graph && originalNode) value = !asRecord(sourceExecution.execution_graph[nodeId]);
      else if (originalNode?.mode === 4) value = true;
      else if (historicalField && typeof historicalField.default === "boolean") value = historicalField.default;
    }
    if (!usable(value)) {
      const isBypassed = pointers.length > 0 && pointers.every((pointer) => {
        const nodeId = pointerTokens(pointer)[0];
        return sources.some((source) => source[`__bypass_${nodeId}`] === true) ||
          asRecord(sourceExecution?.graph_json?.[nodeId])?.mode === 4 ||
          Boolean(sourceExecution?.execution_graph && asRecord(sourceExecution.graph_json?.[nodeId]) && !asRecord(sourceExecution.execution_graph[nodeId]));
      });
      if (!sourceExecution?.execution_graph || isBypassed) {
        if (graphFieldDisagrees(sourceExecution?.graph_json, pointers)) { missing.push(key); continue; }
        value = readGraphField(sourceExecution?.graph_json, pointers, field);
      }
    }
    if (usable(value)) { restored[key] = value; continue; }
    // Legacy local jobs can verify numeric/#node keys without a recorded
    // schema. Summary aliases such as seed/steps do not identify a node.
    if (!usable(value)) {
      const scopedKeys = sources.flatMap((source) => Object.keys(source)).filter((sourceKey) => {
        const recordedField = sourceFields.find(([recordedKey]) => recordedKey === sourceKey);
        return pointers.length > 0 && JSON.stringify(fieldPointers(
          sourceKey, recordedField?.[1] || {}, sourceExecution?.node_mapping,
        )) === JSON.stringify(pointers);
      });
      value = sources.flatMap((source) => scopedKeys.map((sourceKey) => source[sourceKey])).find(usable);
    }
    if (usable(value)) { restored[key] = value; continue; }
    const inputName = pointers.length === 1 ? pointerTokens(pointers[0]).slice(-1)[0] : null;
    const matchingTargets = new Set(fields.flatMap(([otherKey, otherField]) => {
      const otherPointers = fieldPointers(otherKey, otherField, nodeMapping);
      return seedField
        ? isExecutionSeedField(otherKey, otherField, otherPointers) ? otherPointers : []
        : otherPointers.filter((pointer) => pointerTokens(pointer).slice(-1)[0] === inputName);
    }));
    for (const candidateGraph of [graph, sourceExecution?.graph_json, sourceExecution?.execution_graph]) {
      for (const [nodeId, node] of getWorkflowGraphNodeEntries(candidateGraph)) {
        for (const name of Object.keys(node.inputs || {})) {
          if (seedField ? name === "seed" || name === "noise_seed" : inputName && name === inputName) {
            matchingTargets.add("/" + [nodeId, "inputs", name].map(escapePointer).join("/"));
          }
        }
      }
    }
    const aliasIsUnambiguous = pointers.length === 1 && matchingTargets.size === 1 && (!seedField || seedFields.length === 1);
    if (!usable(value) && sourceFields.length === 0 && aliasIsUnambiguous) {
      value = remapped.map((source) => source[key]).find(usable);
    }
    if (!usable(value) && seedField && aliasIsUnambiguous) {
      value = sources.flatMap((source) => [source.seed, source.noise_seed]).find(usable);
    }
    if (usable(value)) { restored[key] = value; continue; }
    const linked = pointers.length > 0 && pointers.every((pointer) =>
      isGraphLink(pointerValue(graph, pointer), graph, field));
    // Keep structural connections in form state too, so a later Generate does
    // not fill this socket with the current scalar/widget default.
    if (linked) { restored[key] = readGraphField(graph, pointers, field); continue; }
    // Legacy recipes omitted controls on nodes that were not executed.
    // Preserve their recorded bypass instead of demanding unused widget values.
    // Mixed bindings still require a value for every active target.
    const allTargetsBypassed = pointers.length > 0 && pointers.every((pointer) => {
      const nodeId = pointerTokens(pointer)[0];
      const bypassKey = `__bypass_${nodeId}`;
      for (const source of sources) {
        if (typeof source[bypassKey] === "boolean") return source[bypassKey] === true;
      }
      const originalNode = asRecord(sourceExecution?.graph_json?.[nodeId]);
      if (sourceExecution?.execution_graph && originalNode) {
        return !asRecord(sourceExecution.execution_graph[nodeId]);
      }
      return originalNode?.mode === 4;
    });
    if (allTargetsBypassed) continue;
    if (!pointers.length && !key.startsWith("__bypass_")) continue;
    missing.push(key);
  }
  if (missing.length) throw new IncompleteExecutionStateError(missing);

  const historicalGraph = sourceExecution?.execution_graph || sourceExecution?.graph_json;
  if (historicalGraph) {
    const bindings = fields.filter(([key, field]) => !key.startsWith("__bypass_") && field.x_skip_runtime_mapping !== true)
      .flatMap(([key, field]) => fieldPointers(key, field, nodeMapping));
    const unexposed: string[] = [];
    const compareUnbound = (pointer: string, current: unknown, historical: unknown) => {
      if (bindings.some((binding) => pointer === binding || pointer.startsWith(binding + "/"))) return;
      if (JSON.stringify(current) === JSON.stringify(historical)) return;
      const currentObject = asRecord(current);
      const historicalObject = asRecord(historical);
      if (currentObject && historicalObject && bindings.some((binding) => binding.startsWith(pointer + "/"))) {
        for (const key of new Set([...Object.keys(currentObject), ...Object.keys(historicalObject)])) {
          compareUnbound(pointer + "/" + escapePointer(key), currentObject[key], historicalObject[key]);
        }
        return;
      }
      unexposed.push(pointerTokens(pointer).filter((_, index) => index !== 1).join("."));
    };
    const outputNodes = new Set(["SaveImage", "SaveAnimatedPNG", "SaveAnimatedWEBP", "SaveVideo", "SaveAudio", "SaveAudioMP3", "SaveAudioOpus", "PreviewImage", "PreviewAudio"]);
    for (const [nodeId, node] of getWorkflowGraphNodeEntries(graph)) {
      if (restored[`__bypass_${nodeId}`] === true) continue;
      const historicalNode = asRecord(historicalGraph[nodeId]);
      const historicalInputs = asRecord(historicalNode?.inputs);
      if (!historicalInputs) continue;
      for (const [name, historicalValue] of Object.entries(historicalInputs)) {
        const currentValue = node.inputs?.[name];
        if (isGraphLink(currentValue, graph, {}) || isGraphLink(historicalValue, historicalGraph, {})) continue;
        // Studio owns output routing; this operational prefix does not change
        // model pixels. No unknown node or sampler/model socket is exempt.
        if (name === "filename_prefix" && outputNodes.has(String(node.class_type)) &&
            (!historicalNode?.class_type || historicalNode.class_type === node.class_type)) continue;
        compareUnbound("/" + [nodeId, "inputs", name].map(escapePointer).join("/"), currentValue, historicalValue);
      }
    }
    if (unexposed.length) {
      throw new Error(`This Pipe cannot restore unexposed execution values: ${unexposed.join(", ")}. Expose those inputs before regenerating this image.`);
    }
  }
  return restored;
};
