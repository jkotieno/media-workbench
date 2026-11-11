import { isPromptSchemaField } from "@/lib/promptUtils";
import { getWorkflowGraphNodeIds, getWorkflowInputFieldEntries } from "@/shared/workflow/workflowStructure";
import { isMediaUploadField, resolveNodeTitle, resolveParamTitle } from "@/components/dynamic-form/fieldUtils";
import type { WorkflowInputField } from "@/shared/types/workflow.types";
import { fieldPointers, readSavedExecutionControl } from "@/features/prompt-studio/promptExecutionRestore";
import type { AncestryNode } from "@/shared/api/ancestry.api";
import type { AncestryGraph } from "./ancestryGraph";

export const savedRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface SavedControl { key: string; field: WorkflowInputField; label: string; value: unknown; recorded: boolean; order: number; }
export interface SavedControlGroup { id: string; title: string; controls: SavedControl[]; order: number; core: boolean; }

/** Join captured bindings by stable source and target pointers, never by a first matching label. */
export function savedControlMedia(control: SavedControl, details: Record<string, unknown>, graph: AncestryGraph, stepId: string): AncestryNode[] {
    const config = savedRecord(details.configuration), source = savedRecord(details.source_execution);
    const pointers = fieldPointers(control.key, control.field, savedRecord(config.node_mapping ?? source.node_mapping));
    const escape = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
    const bindings = (Array.isArray(details.input_bindings) ? details.input_bindings.map(savedRecord) : []).filter(binding => binding.field === control.key || (binding.node_id != null && typeof binding.input_name === "string" && pointers.includes(`/${escape(String(binding.node_id))}/inputs/${escape(binding.input_name)}`)));
    const edges = [...graph.edges.values()].filter(edge => edge.target === stepId && edge.attribution !== "produced");
    const linked = edges.map(edge => graph.nodes.get(edge.source)).filter((node): node is AncestryNode => Boolean(node));
    if (bindings.length) {
        const found: AncestryNode[] = [];
        for (const binding of bindings) {
            const snapshot = savedRecord(binding.artifact);
            const snapshotAction = savedRecord(snapshot.actions);
            const snapshotNodes: AncestryNode[] = snapshot.kind === "artifact" && typeof snapshot.id === "string" && typeof snapshot.label === "string" && Array.isArray(snapshotAction.reasons) ? [snapshot as unknown as AncestryNode] : [];
            const matches = [...linked, ...snapshotNodes].filter(node => node.media_uuid === binding.media_uuid && (!binding.sha256 || !node.details?.expected_sha256 || node.details.expected_sha256 === binding.sha256));
            const exact = typeof binding.sha256 === "string" ? matches.filter(node => node.details?.expected_sha256 === binding.sha256 || node.details?.sha256 === binding.sha256 || node.id.endsWith(`:sha256:${binding.sha256}`)) : [];
            const candidates = [...new Map((exact.length ? exact : matches).map(node => [node.id, node])).values()];
            if (candidates.length === 1) found.push(candidates[0]);
        }
        return [...new Map(found.map(node => [node.id, node])).values()];
    }
    return [...new Map(edges.filter(edge => edge.field === control.key || edge.field === control.label || edge.role === control.label).map(edge => graph.nodes.get(edge.source)).filter((node): node is AncestryNode => Boolean(node)).map(node => [node.id, node])).values()];
}

/** A read-only projection. Never consult installed Pipes, defaults, form stores or engine inventory. */
export function savedConfigurator(details: Record<string, unknown>) {
    const config = savedRecord(details.configuration);
    const source = savedRecord(details.source_execution);
    const schema = savedRecord(config.input_schema ?? source.input_schema);
    const entries = getWorkflowInputFieldEntries(savedRecord(schema.properties ?? schema));
    const savedValues = config.effective_parameters ?? source.parameters ?? config.parameters ?? details.parameters;
    const parameters = savedValues !== undefined ? { ...savedRecord(savedValues) } : entries.length === 0
        ? Object.fromEntries(Object.entries(config).filter(([key, value]) => !["workflow_name", "pipe_identity", "version", "name", "saved_at"].includes(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))) : {};
    const execution = savedRecord(config.submitted_graph ?? source.execution_graph);
    for (const [key, field] of entries) {
        if (Object.prototype.hasOwnProperty.call(parameters, key)) continue;
        const value = readSavedExecutionControl(key, field, savedRecord(config.node_mapping ?? source.node_mapping), execution);
        if (value !== undefined) parameters[key] = value;
    }
    const nodeOrder = getWorkflowGraphNodeIds(savedRecord(config.original_graph ?? source.graph_json));
    const prompts = entries.filter(([key, field]) => isPromptSchemaField(key, field)).slice(0, 2);
    const coreKeys = new Set(entries.filter(([, field]) => field.x_core === true).map(([key]) => key));
    prompts.forEach(([key, field]) => { if (field.x_core !== false) coreKeys.add(key); });
    const placements = entries.map(([key, field], index) => {
        const annotation = field.x_form;
        const prompt = isPromptSchemaField(key, field);
        const generic = annotation?.groupId?.toLowerCase() === "default" && annotation?.groupTitle?.toLowerCase() === "default";
        const id = prompt ? String(field.x_node_id || "prompt")
            : annotation?.section ? String(annotation.section === "inputs" || (generic && field.x_node_id) ? field.x_node_id || annotation.groupId || "media" : annotation.groupId || annotation.section)
                : String(field.x_node_id || (isMediaUploadField(key, field) ? "media" : "default"));
        const nodeId = String(field.x_node_id || id);
        const title = prompt ? resolveNodeTitle(field, "Prompt")
            : field.x_node_alias || (generic ? resolveNodeTitle(field) : annotation?.groupTitle) || resolveNodeTitle(field, isMediaUploadField(key, field) ? "Media input" : "Configuration");
        const graphIndex = nodeOrder.indexOf(nodeId);
        const order = graphIndex >= 0 ? graphIndex : typeof annotation?.order === "number" ? annotation.order : Number.isFinite(Number(field.x_node_id)) ? Number(field.x_node_id) : index;
        return { key, field, index, id, nodeId, title, order };
    });
    // Configurator promotes the whole node containing an explicit Core field or an eligible prompt.
    const coreNodes = new Set(placements.filter(item => coreKeys.has(item.key)).map(item => item.nodeId));
    const groups = new Map<string, SavedControlGroup>();
    for (const item of placements) {
        const core = coreNodes.has(item.nodeId);
        const id = core ? item.nodeId : item.id;
        const group = groups.get(id) ?? { id, title: item.title, controls: [], order: item.order, core };
        group.core ||= core;
        group.order = Math.min(group.order, item.order);
        if (group.title.startsWith("Bypass") && !item.title.startsWith("Bypass")) group.title = item.title;
        group.controls.push({ key: item.key, field: item.field, label: resolveParamTitle(item.key, item.field), value: parameters[item.key], recorded: Object.prototype.hasOwnProperty.call(parameters, item.key), order: item.field.x_form?.order ?? item.index });
        groups.set(id, group);
    }
    const ordered = [...groups.values()].sort((a, b) => a.order - b.order);
    ordered.forEach(group => group.controls.sort((a, b) => a.order - b.order));
    return { groups: ordered, schemaMissing: entries.length === 0, parameters };
}
