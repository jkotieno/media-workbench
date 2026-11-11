import { describe, expect, it } from "vitest";
import { AncestryRequestQueue, ancestryRows, emptyAncestryGraph, mergeAncestryPage, withRetainedOutputs, canAttachRetainedOutput } from "./ancestryGraph";
import { layoutAncestry, projectAncestry } from "./ancestryLayout";
import type { AncestryNode, AncestryReadResponse } from "@/shared/api/ancestry.api";

const node = (id: string, kind: AncestryNode["kind"] = "artifact"): AncestryNode => ({ id, kind, state: "known", label: id, expandable: true, continuation: id, actions: { use_in_pipe: false, regenerate: false, reasons: [] } });
const page = (nodes: AncestryNode[], edges: Array<[string, string, string]>): AncestryReadResponse => ({ root_id: "root", nodes, edges: edges.map(([id, source, target]) => ({ id, source, target, field: id, role: "reference", attribution: source.startsWith("step") ? "produced" : "branch", state: "known" })), digest: "revision", truncated: false, limits: {} });

describe("Ancestry incremental graph", () => {
    it("retains every field of a diamond, preserves route tokens, and detects cycles added by later pages", () => {
        let graph = mergeAncestryPage(emptyAncestryGraph(), page([node("root"), node("step-final", "step"), node("left"), node("right")], [["out", "step-final", "root"], ["scene", "left", "step-final"], ["motion", "right", "step-final"]]), "root");
        graph = mergeAncestryPage(graph, page([node("step-left", "step"), node("shared")], [["left-out", "step-left", "left"], ["image", "shared", "step-left"], ["mask", "shared", "step-left"]]), "left");
        graph = mergeAncestryPage(graph, page([node("step-right", "step"), { ...node("shared"), continuation: "different-route" }], [["right-out", "step-right", "right"], ["reference", "shared", "step-right"]]), "right");
        const initialProjection = projectAncestry(graph, new Set(["root"]));
        const initialLayout = layoutAncestry(initialProjection, graph.rootId);
        const expanded = new Set(["root", "left", "right", "shared"]);
        const projection = projectAncestry(graph, expanded);
        expect(projection.nodes.filter(item => item.id === "shared")).toHaveLength(1);
        expect(projection.edges.filter(item => item.source === "shared").map(item => item.edge.field)).toEqual(["image", "mask", "reference"]);
        const incrementalLayout = layoutAncestry(projection, graph.rootId, initialLayout);
        for (const [id, position] of initialLayout) expect(incrementalLayout.get(id)).toEqual(position);
        expect(new Set([...incrementalLayout.values()].map(point => `${point.x}:${point.y}`)).size).toBe(incrementalLayout.size);
        let rows = ancestryRows(graph, expanded);
        expect(rows.filter(row => row.node.id === "shared")).toHaveLength(3);
        expect(rows.filter(row => row.sharedWith)).toHaveLength(2);
        expect(rows.some(row => row.circular)).toBe(false);
        expect(graph.nodes.get("shared")?.continuation).toBe("shared");
        graph = mergeAncestryPage(graph, page([node("step-shared", "step")], [["shared-out", "step-shared", "shared"], ["malformed", "left", "step-shared"]]), "shared");
        rows = ancestryRows(graph, expanded);
        expect(rows.filter(row => row.circular).map(row => row.edge?.id)).toEqual(["malformed"]);
        expect(projectAncestry(graph, expanded).nodes.filter(item => item.node.state === "circular").map(item => item.node.kind)).toEqual(["diagnostic"]);
        expect(rows.filter(row => row.node.id === "right")).toHaveLength(1);
        expect(ancestryRows(graph, new Set(["root"])).map(row => row.node.id)).toEqual(["root", "step-final", "left", "right"]);
    });

    it("stops a self reference without treating an ordinary import as missing", () => {
        const graph = mergeAncestryPage(emptyAncestryGraph(), page([node("root"), node("step", "step"), { ...node("import"), state: "known_import", expandable: false }], [["out", "step", "root"], ["self", "root", "step"], ["input", "import", "step"]]), "root");
        const rows = ancestryRows(graph, new Set(["root"]));
        expect(rows.find(row => row.edge?.id === "self")?.circular).toBe(true);
        expect(rows.find(row => row.node.id === "import")?.circular).toBe(false);
    });

    it("keeps one execution's distinct output branches scoped when both lazy pages merge", () => {
        let graph = mergeAncestryPage(emptyAncestryGraph(), page([node("root"), node("step-final", "step"), node("left"), node("right")], [["out", "step-final", "root"], ["a", "left", "step-final"], ["b", "right", "step-final"]]), "root");
        for (const output of ["left", "right"]) {
            const result = page([node("step-shared", "step"), node(`${output}-exclusive`)], [[`${output}-out`, "step-shared", output], [`${output}-input`, `${output}-exclusive`, "step-shared"]]);
            result.nodes[0].details = output === "left"
                ? {configuration:{seed:"18446744073709551615"},saved_at:"2026-10-31",media:{id:1},output:{channel:"left"}}
                : {saved_at:"2026-10-31"};
            result.edges[1].for_output = output;
            graph = mergeAncestryPage(graph, result, output);
        }
        const oneExpanded = projectAncestry(graph, new Set(["root", "left"]));
        expect(oneExpanded.edges.filter(edge => edge.source === "step-shared").map(edge => edge.target)).toEqual(["left", "right"]);
        const rows = ancestryRows(graph, new Set(["root", "left", "right"]));
        expect(rows.filter(row => row.node.id === "step-shared")).toHaveLength(2);
        const projection = projectAncestry(graph, new Set(["root", "left", "right"]));
        expect(projection.nodes.filter(item => item.id === "step-shared")).toHaveLength(1);
        expect(projection.edges.filter(item => item.target === "step-shared").map(item => item.edge.for_output)).toEqual(["left", "right"]);
        expect(rows.find(row => row.node.id === "left-exclusive")?.path).toContain("left");
        expect(rows.find(row => row.node.id === "left-exclusive")?.path).not.toContain("right");
        expect(rows.find(row => row.node.id === "right-exclusive")?.path).toContain("right");
        expect(rows.filter(row => row.sharedWith)).toHaveLength(0);
        expect(graph.nodes.get("step-shared")?.details?.configuration).toEqual({seed:"18446744073709551615"});
        expect(graph.nodes.get("step-shared")?.details?.media).toBeUndefined();
        expect(graph.nodes.get("step-shared")?.details?.output).toBeUndefined();
        graph = mergeAncestryPage(graph,page([{...node("step-shared","step"),state:"restricted",details:null}],[]),"restricted");
        expect(graph.authorityChanged).toBe(true);
        expect(graph.nodes.size).toBe(0);
        expect(graph.edges.size).toBe(0);
        expect(ancestryRows(graph,new Set(["root","left","right"])).some(row=>row.node.id.endsWith("-exclusive"))).toBe(false);
        expect(mergeAncestryPage(graph,page([node("late-private-source")],[]),"late").nodes.size).toBe(0);
        const initialRestricted=mergeAncestryPage(emptyAncestryGraph(),page([node("root"),{...node("placeholder"),state:"restricted",label:"Private title",media_uuid:"private",image_id:7,media_url:"/private",preview_url:"/private-preview",details:{prompt:"private prompt"},actions:{use_in_pipe:true,regenerate:true,reasons:["private"]}}],[["hidden","placeholder","root"]]),"root");
        expect(initialRestricted.authorityChanged).toBe(false);
        expect(initialRestricted.nodes.has("root")).toBe(true);
        expect(initialRestricted.nodes.get("placeholder")).toEqual({id:"placeholder",kind:"diagnostic",state:"restricted",label:"Source unavailable",expandable:false,continuation:null,details:null,actions:{use_in_pipe:false,regenerate:false,reasons:[]}});
        const identified=mergeAncestryPage(emptyAncestryGraph(),page([node("root"),node("private-source")],[["saved-binding","private-source","root"]]),"root");
        const opaqueRestriction=mergeAncestryPage(identified,page([{...node("opaque-placeholder"),state:"restricted"}],[["saved-binding","opaque-placeholder","root"]]),"root");
        expect(opaqueRestriction.authorityChanged).toBe(true);
        expect(opaqueRestriction.nodes.size).toBe(0);
    });

    it("does not merge two revisions of the same media identity or their action decisions", () => {
        const current = { ...node("media:source:current"), media_uuid: "source", state: "known" as const, actions: {use_in_pipe: true, regenerate: false, reasons: []} };
        const consumed = { ...node("media:source:old-digest"), media_uuid: "source", state: "revision_mismatch" as const, actions: {use_in_pipe: false, regenerate: false, reasons: ["source_revision_unavailable"]} };
        const graph = mergeAncestryPage(emptyAncestryGraph(), page([node("root"), node("step", "step"), current, consumed], [["out", "step", "root"], ["current", current.id, "step"], ["historical", consumed.id, "step"]]), "root");
        const rows = ancestryRows(graph, new Set(["root"]));
        expect(rows.filter(row => row.node.media_uuid === "source")).toHaveLength(2);
        expect(rows.filter(row => row.sharedWith)).toHaveLength(0);
        expect(graph.nodes.get(consumed.id)?.actions.use_in_pipe).toBe(false);
        expect(graph.nodes.get(current.id)?.actions.use_in_pipe).toBe(true);
        expect(projectAncestry(graph, new Set(["root"])).nodes.filter(item => item.node.media_uuid === "source")).toHaveLength(2);
    });

    it("carries output scope through an authored edit's saved generation context", () => {
        const result = page([node("root"), {...node("step-edit", "step"),state:"edited"}, node("step-generation", "step"), node("original-source"), node("sibling-source")], [["edited-out","step-edit","root"], ["original-context","step-generation","step-edit"], ["original-input","original-source","step-generation"], ["sibling-input","sibling-source","step-generation"]]);
        result.edges[1].attribution = "run_context";
        result.edges[2].for_output = "root";
        result.edges[3].for_output = "sibling-output";
        const graph = mergeAncestryPage(emptyAncestryGraph(), result, "root");
        expect(ancestryRows(graph,new Set(["root"])).map(row=>row.node.id)).toEqual(["root","step-edit","step-generation","original-source"]);
        const edited = { ...node("root"), state: "edited" as const };
        result.nodes.find(item => item.id === "step-generation")!.details = { outputs: [edited] };
        const enriched = withRetainedOutputs(result, emptyAncestryGraph());
        expect(enriched.edges.some(edge => edge.source === "step-generation" && edge.target === "root")).toBe(false);
        expect(canAttachRetainedOutput(graph, graph.nodes.get("step-generation")!, edited)).toBe(false);
        const ordinary = page([node("root"), node("step-shared", "step"), node("sibling")], [["shared-root", "step-shared", "root"]]);
        ordinary.nodes[1].details = { outputs: [ordinary.nodes[0], ordinary.nodes[2]] };
        const siblings = withRetainedOutputs(ordinary, emptyAncestryGraph());
        expect(siblings.edges.filter(edge => edge.source === "step-shared").map(edge => edge.target)).toEqual(["root", "sibling"]);
    });

    it("coalesces requests into two slots and cancels queued and active branches", async () => {
        const queue = new AncestryRequestQueue();
        const releases: Array<() => void> = [];
        const signals: AbortSignal[] = [];
        let active = 0;
        let maximum = 0;
        const run = async (signal: AbortSignal) => {
            signals.push(signal); active++; maximum = Math.max(maximum, active);
            await new Promise<void>(resolve => releases.push(resolve)); active--;
        };
        queue.enqueue("a", run); queue.enqueue("a", run); queue.enqueue("b", run); queue.enqueue("c", run);
        expect(signals).toHaveLength(2);
        queue.cancel("c"); queue.cancel("a");
        expect(signals[0].aborted).toBe(true);
        releases.splice(0).forEach(release => release());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(signals).toHaveLength(2);
        queue.enqueue("a", run);
        expect(signals).toHaveLength(3);
        queue.cancel(); releases.splice(0).forEach(release => release());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(maximum).toBe(2);
        expect(signals[2].aborted).toBe(true);
    });
});
