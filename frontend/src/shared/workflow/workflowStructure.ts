import type {
  WorkflowGraph,
  WorkflowGraphNode,
  WorkflowInputField,
  WorkflowInputSchema,
} from "@/shared/types/workflow.types";

export const isWorkflowInputField = (value: unknown): value is WorkflowInputField =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isWorkflowInternalSchemaKey = (key: string) =>
  key.startsWith("__") && !key.startsWith("__bypass_");

export const getWorkflowInputFieldEntries = (
  schema: WorkflowInputSchema | null | undefined,
): Array<[string, WorkflowInputField]> => {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  return Object.entries(schema).filter(
    ([key, value]) =>
      !isWorkflowInternalSchemaKey(key) && isWorkflowInputField(value),
  ) as Array<[string, WorkflowInputField]>;
};

export const getWorkflowInputField = (
  schema: WorkflowInputSchema | null | undefined,
  key: string,
): WorkflowInputField | null => {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const value = schema[key];
  return isWorkflowInputField(value) ? value : null;
};

export const buildWorkflowNodeAliasMap = (
  schema: WorkflowInputSchema | null | undefined,
): Record<string, string> => {
  const aliasMap: Record<string, string> = {};

  getWorkflowInputFieldEntries(schema).forEach(([_, field]) => {
    const nodeId = field.x_node_id;
    if (nodeId === undefined || nodeId === null) {
      return;
    }

    const alias =
      typeof field.x_node_alias === "string" ? field.x_node_alias.trim() : "";
    if (!alias) {
      return;
    }

    const id = String(nodeId);
    if (!aliasMap[id]) {
      aliasMap[id] = alias;
    }
  });

  return aliasMap;
};

const isWorkflowGraphNodeEntry = (key: string, value: unknown): value is WorkflowGraphNode => {
  if (key === "nodes" || key === "links") {
    return false;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return /^\d+$/.test(key) || "class_type" in value || "inputs" in value || "_meta" in value;
};

const getWorkflowGraphNodeEntriesRaw = (
  graph: WorkflowGraph | null | undefined,
): Array<[string, WorkflowGraphNode]> => {
  if (!graph || typeof graph !== "object") {
    return [];
  }

  return Object.entries(graph).filter(([key, value]) =>
    isWorkflowGraphNodeEntry(key, value),
  ) as Array<[string, WorkflowGraphNode]>;
};

export const isWorkflowGraphUiFormat = (
  graph: WorkflowGraph | null | undefined,
): graph is WorkflowGraph & {
  nodes: NonNullable<WorkflowGraph["nodes"]>;
  links: NonNullable<WorkflowGraph["links"]>;
} =>
  Boolean(
    graph &&
      typeof graph === "object" &&
      Array.isArray(graph.nodes) &&
      Array.isArray(graph.links) &&
      getWorkflowGraphNodeEntriesRaw(graph).length === 0,
  );

export const getWorkflowGraphNodeEntries = (
  graph: WorkflowGraph | null | undefined,
): Array<[string, WorkflowGraphNode]> => {
  if (!graph || typeof graph !== "object" || isWorkflowGraphUiFormat(graph)) {
    return [];
  }

  return getWorkflowGraphNodeEntriesRaw(graph);
};

export const getWorkflowGraphNodeIds = (
  graph: WorkflowGraph | null | undefined,
): string[] => {
  if (!graph) {
    return [];
  }

  if (isWorkflowGraphUiFormat(graph)) {
    return graph.nodes.map((node) => String(node.id));
  }

  return getWorkflowGraphNodeEntries(graph).map(([id]) => id);
};

export const compareWorkflowNodeIds = (a: string, b: string) => {
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = Number.isFinite(aNum);
  const bIsNum = Number.isFinite(bNum);

  if (aIsNum && bIsNum) {
    return aNum - bNum;
  }
  if (aIsNum && !bIsNum) {
    return -1;
  }
  if (!aIsNum && bIsNum) {
    return 1;
  }

  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
};
