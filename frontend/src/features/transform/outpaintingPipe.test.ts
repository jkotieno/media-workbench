import { describe, it, expect, vi } from "vitest";
import { missingOutpaintingInputs, outpaintingBindings, outpaintingInputUpdates } from "./outpaintingPipe";
import { processPromptPendingImageInject } from "../prompt-studio/promptPendingImageInject";
import type { WorkflowTemplate } from "@/shared/types";
import starter from "../../../../backend/app/db/starter_pipes/sts_outpainter_pipe.json";
import historical from "../../../../backend/app/db/starter_pipes/sts_inpainter_pipe.json";

const fixture = (separate = false) => ({
  graph_json: {
    "1": { class_type: "LoadImage", inputs: { image: "" } },
    ...(separate ? { "2": { class_type: "LoadImage", inputs: { image: "" } }, "3": { class_type: "Image To Mask", inputs: { image: ["2", 0], method: "intensity" } } } : {}),
    "4": { class_type: "VAEEncodeForInpaint", inputs: { pixels: ["1", 0], mask: [separate ? "3" : "1", separate ? 0 : 1] } },
    "5": { class_type: "KSampler", inputs: { latent_image: ["4", 0] } },
    "6": { class_type: "SaveImage", inputs: { images: ["5", 0] } },
  },
  input_schema: { photo: { type: "string" }, ...(separate ? { coverage: { type: "string" } } : {}) },
  node_mapping: { photo: { node_id: "1", field: "inputs.image" }, ...(separate ? { coverage: { node_id: "2", field: "inputs.image" } } : {}) },
}) as unknown as WorkflowTemplate;

describe("outpainting Pipe handoff", () => {
  it("uses the shipped graphs' real fields and final masked output", () => {
    const pipe = (bundle: typeof starter) => ({ graph_json: bundle.workflow, ...bundle._sweet_tea }) as unknown as WorkflowTemplate;
    expect(outpaintingBindings(pipe(starter))).toEqual([{ imageField: "LoadImage#2.image", convention: "alpha", alignment: 8 }]);
    const legacy = outpaintingBindings(pipe(historical as unknown as typeof starter));
    expect(legacy.some(binding => binding.convention === "separate" && binding.imageField.includes("1029") && binding.maskField?.includes("1030"))).toBe(true);
    expect(starter.workflow["8"].inputs).toMatchObject({ destination: ["2", 0], mask: ["2", 1], resize_source: false });
    expect(starter._sweet_tea.input_schema.__outpainting.preserve_protected_pixels).toBe(true);
    expect(starter._sweet_tea.input_schema.__outputs.items[0]).toMatchObject({ source_node_id: "8", source_slot: 0 });
  });
  it("recognizes both real graph conventions, rejects ignored masks and internal padding", () => {
    expect(outpaintingBindings(fixture())).toEqual([{ imageField: "photo", convention: "alpha", alignment: undefined }]);
    expect(outpaintingBindings(fixture(true))).toEqual([{ imageField: "photo", maskField: "coverage", convention: "separate", alignment: undefined }]);
    const renamed = fixture(true); (renamed.graph_json["3"] as { class_type: string }).class_type = "Image To Mask Masquerade";
    expect(outpaintingBindings(renamed)).toHaveLength(1);
    const ignoresMask = fixture(); delete (ignoresMask.graph_json["4"] as { inputs: Record<string, unknown> }).inputs.mask;
    expect(outpaintingBindings(ignoresMask)).toEqual([]);
    const padded = fixture(); padded.graph_json["pad"] = { class_type: "ImagePadForOutpaint", inputs: {} };
    expect(outpaintingBindings(padded)).toEqual([]);
    expect(() => outpaintingInputUpdates(outpaintingBindings(fixture(true))[0]!, { image: "new.png" })).toThrow();
  });
  it("reports node-version input incompatibility while allowing mapped Pipe controls", () => {
    const pipe = { graph_json: historical.workflow, ...historical._sweet_tea } as unknown as WorkflowTemplate;
    expect(missingOutpaintingInputs(pipe, { InpaintCropImproved: { input: { required: { device_mode: ["STRING"] } } } }))
      .toEqual(["InpaintCropImproved#151.device_mode"]);
    expect(missingOutpaintingInputs(pipe, { InpaintCropImproved: { input: { required: { output_target_width: ["INT"] } } } }))
      .toEqual([]);
  });
  it("applies a complete prepared pair once, preserves settings, fences engine changes and retains failed transfers", async () => {
    const pending = JSON.stringify({ workflowId: "8", engineId: "2", preparedInputs: { photo: "new.png", coverage: "mask.png" } });
    let data: Record<string, unknown> = { prompt: "keep prompt", seed: 42, photo: "old.png" };
    const remove = vi.fn(), persist = vi.fn();
    const args = { pendingValue: pending, selectedWorkflowId: "8", engineId: 2, removePendingValue: remove,
      getCurrentFormData: () => data, setFormData: (next: Record<string, unknown>) => { data = next; }, persistPipeParams: persist,
      recordTransferDiag: vi.fn(), toReusableInputMediaPath: (p: string) => p, buildViewerApiPath: (p: string) => p,
      extractRawViewerPath: (p?: string | null) => p || "", fetchImpl: vi.fn(), uploadFile: vi.fn() };
    expect((await processPromptPendingImageInject({ ...args, engineId: 3 })).status).toBe("engine_mismatch");
    expect(remove).not.toHaveBeenCalled();
    await processPromptPendingImageInject(args);
    expect(data).toEqual({ prompt: "keep prompt", seed: 42, photo: "new.png", coverage: "mask.png" });
    expect(persist).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
    remove.mockClear();
    await expect(processPromptPendingImageInject({ ...args, persistPipeParams: () => { throw new Error("interrupted save"); } })).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
});
