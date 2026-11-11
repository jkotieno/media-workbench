import React from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { compatibleEngines, resolveEngineSelection, workflowRuntime } from "@/lib/engineSelection";
import { useStudioSessionStore } from "@/lib/stores/studioSessionStore";
import { PROMPT_PENDING_IMAGE_INJECT_KEY } from "@/features/prompt-studio/promptPendingImageInject";
import { TransformSheet } from "./TransformWorkspaceShell";
import { Button } from "@/components/ui/button";
import type { Engine, WorkflowTemplate } from "@/shared/types";
import type { TransformOutpaintPrepareResponse } from "@/shared/api/transform.api";
import { missingOutpaintingInputs, outpaintingBindings, outpaintingInputUpdates } from "./outpaintingPipe";

export function OutpaintingPipeSheet({ open, onClose, onDelivered, width, height, projectId,
  prepare, onAlign }: { open: boolean; onClose: () => void; onDelivered: () => void;
    width: number; height: number; projectId?: number | null;
    prepare: (options: { engineId?: number; stageInputs?: boolean }) => Promise<TransformOutpaintPrepareResponse>;
    onAlign: (alignment: number) => Promise<void>;
  }) {
  const { t } = useTranslation("transform"); const navigate = useNavigate();
  const [pipes, setPipes] = React.useState<WorkflowTemplate[]>([]), [engines, setEngines] = React.useState<Engine[]>([]);
  const [pipeId, setPipeId] = React.useState(""), [engineId, setEngineId] = React.useState("");
  const [bindingIndex, setBindingIndex] = React.useState(0), [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
  const [nodeClasses, setNodeClasses] = React.useState<Set<string> | null>(null);
  const [objectInfo, setObjectInfo] = React.useState<Record<string, unknown> | null>(null);
  const deliveryEpoch = React.useRef(0);
  React.useEffect(() => { deliveryEpoch.current += 1; }, [open, pipeId, engineId, bindingIndex]);
  const close = () => { deliveryEpoch.current += 1; onClose(); };
  const pipe = pipes.find(p => String(p.id) === pipeId), bindings = pipe ? outpaintingBindings(pipe) : [];
  const binding = bindings[bindingIndex];
  const aligned = !binding?.alignment || (width % binding.alignment === 0 && height % binding.alignment === 0);
  React.useEffect(() => {
    if (!open) return; let cancelled = false; setError(null);
    void Promise.all([api.getWorkflows(), api.getEngines()]).then(([allPipes, allEngines]) => {
      if (cancelled) return;
      const compatible = allPipes.filter(p => workflowRuntime(p) === "comfyui" && outpaintingBindings(p).length);
      setPipes(compatible); setEngines(compatibleEngines(allEngines, "comfyui"));
      const session = useStudioSessionStore.getState();
      setPipeId(compatible.some(p => String(p.id) === session.selectedWorkflowId) ? session.selectedWorkflowId : String(compatible[0]?.id || ""));
      const selected = resolveEngineSelection(allEngines, "comfyui", session.selectedEngineUuidsByRuntime.comfyui, session.selectedEngineId);
      setEngineId(selected ? String(selected.id) : ""); setBindingIndex(0);
    }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [open]);
  React.useEffect(() => {
    if (!open || !engineId) return;
    let cancelled = false; setNodeClasses(null); setObjectInfo(null); setError(null);
    void api.getEngineObjectInfo(Number(engineId)).then(info => {
      if (!cancelled) { setNodeClasses(new Set(Object.keys(info))); setObjectInfo(info); }
    }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [open, engineId]);
  const missingNodes = pipe && nodeClasses ? [...new Set(Object.values(pipe.graph_json)
    .map(node => (node as { class_type?: string }).class_type).filter((name): name is string => Boolean(name && !nodeClasses.has(name))))] : [];
  const missingInputs = pipe && objectInfo ? missingOutpaintingInputs(pipe, objectInfo) : [];
  const nodesReady = Boolean(nodeClasses && !missingNodes.length && !missingInputs.length);
  const deliver = async () => {
    if (!pipe || !binding || !engineId || !aligned || !nodesReady) return;
    setBusy(true); setError(null);
    const target = { pipeId, engineId, binding, epoch: deliveryEpoch.current };
    try {
      const prepared = await prepare({ engineId: Number(target.engineId), stageInputs: true });
      if (target.epoch !== deliveryEpoch.current) return;
      const updates = outpaintingInputUpdates(target.binding, prepared.inputs);
      // One pending transfer contains the entire pair; Prompt Studio owns the atomic form write.
      sessionStorage.setItem(PROMPT_PENDING_IMAGE_INJECT_KEY, JSON.stringify({ workflowId: target.pipeId,
        engineId: target.engineId, preparedInputs: updates, preparationId: prepared.preparation_id }));
      const session = useStudioSessionStore.getState();
      const selected = engines.find(engine => String(engine.id) === target.engineId);
      if (selected) session.chooseEngine(selected);
      session.setSelectedWorkflowId(target.pipeId);
      if (projectId) session.setSelectedProjectId(String(projectId));
      window.dispatchEvent(new Event("sweet-tea:prepared-inputs-ready"));
      onDelivered(); navigate("/");
    } catch (error) { if (target.epoch === deliveryEpoch.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <TransformSheet open={open} title={t("expand.usePipe")} description="Choose a Pipe that uses a generation mask. Generation controls remain in the Pipe." onClose={close} footer={<Button variant="outline" onClick={close}>{t("actions.cancel")}</Button>}>
    <div className="space-y-3 p-4 text-sm">
      <label className="block">Pipe<select aria-label="Outpainting Pipe" disabled={busy} value={pipeId} onChange={e => { setPipeId(e.target.value); setBindingIndex(0); }} className="mt-1 block h-9 w-full rounded border border-border bg-surface px-2">
        {pipes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="block">Engine<select aria-label="Outpainting engine" disabled={busy} value={engineId} onChange={e => setEngineId(e.target.value)} className="mt-1 block h-9 w-full rounded border border-border bg-surface px-2">
        {engines.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      {bindings.length > 1 && <label className="block">Inputs<select aria-label="Outpainting inputs" disabled={busy} value={bindingIndex} onChange={e => setBindingIndex(Number(e.target.value))} className="mt-1 block h-9 w-full rounded border border-border bg-surface px-2">
        {bindings.map((b, i) => <option key={i} value={i}>{b.imageField}{b.maskField ? ` + ${b.maskField}` : " (image + alpha mask)"}</option>)}</select></label>}
      <p className="text-xs text-muted-foreground">{width} × {height}{binding?.alignment ? ` · ${binding.alignment} px alignment` : ""}</p>
      {!aligned && <div className="space-y-2"><p role="alert">Add padding to make both dimensions multiples of {binding?.alignment}. The image will retain its size.</p>
        <Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void onAlign(binding!.alignment!).catch(error => setError(String(error))).finally(() => setBusy(false)); }}>Add required padding</Button></div>}
      {!pipes.length && <p>No compatible local Pipe is available. Import a masked generation workflow or export the prepared image and mask.</p>}
      {missingNodes.length > 0 && <p role="alert">This engine needs the Pipe’s nodes: {missingNodes.join(", ")}. Install its dependencies before using the prepared inputs.</p>}
      {missingInputs.length > 0 && <p role="alert">The engine requires inputs missing from this Pipe: {missingInputs.join(", ")}. Update the Pipe or use a compatible node version.</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button disabled={busy || !pipe || !binding || !engineId || !aligned || !nodesReady} onClick={() => void deliver()}>{busy ? t("expand.preparing") : t("expand.usePipe")}</Button>
    </div>
  </TransformSheet>;
}
