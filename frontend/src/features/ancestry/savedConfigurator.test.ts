import { describe, expect, it } from "vitest";
import { savedConfigurator, savedControlMedia, type SavedControl } from "./savedConfigurator";
import { emptyAncestryGraph } from "./ancestryGraph";

describe("historical Configurator projection", () => {
    it("retains authored groups, whole-node Core promotion, bypasses and exact saved values without current defaults", () => {
        const result = savedConfigurator({ configuration: {
            original_graph: { "4": {}, "6": {}, "10": {} },
            input_schema: {
                "4.image": { type: "string", widget: "media_upload", title: "Scene image", x_node_id: "4", x_node_alias: "Scene references", x_core: true, x_form: { section: "inputs", groupId: "default", groupTitle: "default", order: 1 } },
                "4.mask": { type: "string", widget: "media_upload", title: "Mask", x_node_id: "4", x_core: false, x_form: { section: "inputs", order: 2 } },
                "6.text": { type: "string", widget: "textarea", title: "Prompt", x_node_id: "6", x_class_type: "CLIPTextEncode" },
                "10.seed": { type: "integer", title: "Seed", x_node_id: "10", x_form: { section: "nodes", groupId: "sampling", groupTitle: "Sampling", order: 20 }, default: 42 },
                "10.steps": { type: "integer", title: "Steps", x_node_id: "10", x_form: { section: "nodes", groupId: "sampling", groupTitle: "Sampling", order: 21 }, default: 999 },
                __bypass_10: { type: "boolean", widget: "toggle", title: "Bypass sampler", x_node_id: "10", x_form: { section: "nodes", groupId: "sampling", groupTitle: "Sampling", order: 22 } },
            },
            effective_parameters: { "4.image": "historic.png", "4.mask": "mask.png", "6.text": "A calm lake", "10.seed": "18446744073709551615", __bypass_10: true },
        } });
        expect(result.groups[0]).toMatchObject({ id: "4", title: "Scene references", core: true });
        expect(result.groups[0].controls.map(field => field.key)).toEqual(["4.image", "4.mask"]);
        expect(result.groups.find(group => group.id === "6")?.core).toBe(true);
        const sampler = result.groups.find(group => group.title === "Sampling")!;
        expect(sampler.core).toBe(false);
        expect(sampler.controls.find(field => field.key === "10.seed")?.value).toBe("18446744073709551615");
        expect(sampler.controls.find(field => field.key === "10.steps")).toMatchObject({ recorded: false, value: undefined });
        expect(sampler.controls.find(field => field.key === "__bypass_10")?.value).toBe(true);
    });
    it("keeps missing layout honest and retains effective hidden values without editable state or inventory", () => {
        expect(savedConfigurator({ parameters: { prompt: "Only rendered text survived" } })).toMatchObject({ schemaMissing: true, parameters: { prompt: "Only rendered text survived" } });
        const result = savedConfigurator({ source_execution: { input_schema: { hidden: { title: "Recorded hidden control", type: "string", __hidden: true } }, parameters: { hidden: "retained" } } });
        expect(result.groups[0].controls[0]).toMatchObject({ value: "retained", recorded: true, field: { __hidden: true } });
    });
    it("joins legacy target pointers to the exact media revision rather than another field with the same role", () => {
        const graph = emptyAncestryGraph();
        for (const [id, uuid, hash] of [["old", "scene", "a".repeat(64)], ["edited", "scene", "b".repeat(64)], ["voice", "voice", "a".repeat(64)]]) {
            graph.nodes.set(id, { id, kind: "artifact", label: id, media_uuid: uuid, state: "known_import", expandable: false, details: { expected_sha256: hash }, actions: { use_in_pipe: true, regenerate: false, reasons: [] } });
            graph.edges.set(id, { id, source: id, target: "step", field: "image", role: "image", attribution: "branch", state: "known" });
        }
        const control: SavedControl = { key: "LoadImage#4.image", label: "Scene image", field: { type: "string", widget: "media_upload", x_node_id: "4" }, value: "old.png", recorded: true, order: 0 };
        expect(savedControlMedia(control, { input_bindings: [{ field: "image", node_id: "4", input_name: "image", media_uuid: "scene", sha256: "a".repeat(64) }] }, graph, "step").map(node => node.id)).toEqual(["old"]);
    });
    it("recovers absent values only from unambiguous frozen submitted literals", () => {
        const result = savedConfigurator({ configuration: {
            input_schema: { seed: { title: "Seed", type: "integer", default: 99 }, steps: { title: "Steps", type: "integer", default: 88 } },
            node_mapping: { seed: { node_id: "4", field: "inputs.seed" }, steps: { targets: [{ node_id: "4", field: "inputs.steps" }, { node_id: "5", field: "inputs.steps" }] } },
            submitted_graph: { "4": { class_type: "Sampler", inputs: { seed: "18446744073709551615", steps: 20 } }, "5": { class_type: "Sampler", inputs: { steps: 30 } } },
            effective_parameters: {},
        } });
        const fields = result.groups.flatMap(group => group.controls);
        expect(fields.find(field => field.key === "seed")).toMatchObject({ recorded: true, value: "18446744073709551615" });
        expect(fields.find(field => field.key === "steps")).toMatchObject({ recorded: false, value: undefined });
    });
});
