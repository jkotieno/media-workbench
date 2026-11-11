import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { TransformExpansion } from "@/shared/types";
import { expansionFrame, normalizeTransformExpansion } from "./expansion";

export function ExpansionControls({ value, onChange, onMask }: {
  value: TransformExpansion; onChange: (next: TransformExpansion | null) => Promise<void>; onMask: () => void;
}) {
  const { t } = useTranslation("transform");
  const [error, setError] = React.useState<string | null>(null);
  const [anchor, setAnchor] = React.useState("1,1");
  const frame = expansionFrame(value);
  const commit = async (next: TransformExpansion | null) => {
    try { normalizeTransformExpansion(next); await onChange(next); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const dimension = (axis: "width" | "height", total: number) => {
    const padding = Math.max(0, total - value.base[axis]);
    const position = Number(anchor.split(",")[axis === "width" ? 0 : 1]);
    const before = Math.round(padding * position / 2);
    void commit(axis === "width" ? { ...value, left: before, right: padding - before }
      : { ...value, top: before, bottom: padding - before });
  };
  return <section className="space-y-3 border-b border-border p-3" data-testid="expansion-controls">
    <div className="flex items-center justify-between"><strong className="text-xs">{t("expand.title")}</strong>
      <span className="text-xs text-muted-foreground">{frame.width} × {frame.height}</span></div>
    <div className="grid grid-cols-2 gap-2">
      {(["left", "right", "top", "bottom", "transition"] as const).map(key => <label key={key} className="text-xs">
        {t(`expand.${key}`)}<input key={`${key}:${value[key]}`} aria-label={t(`expand.${key}`)} type="number" min="0" step="1"
          defaultValue={value[key]} className="mt-1 h-8 w-full rounded border border-border bg-surface px-2"
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
          onBlur={e => { const v = Number(e.currentTarget.value); if (v !== value[key]) void commit({ ...value, [key]: v }); }} /></label>)}
      <label className="text-xs">{t("expand.anchor")}<select aria-label={t("expand.anchor")} value={anchor} onChange={e => setAnchor(e.target.value)} className="mt-1 h-8 w-full rounded border border-border bg-surface px-1">
        {[0, 1, 2].flatMap(y => [0, 1, 2].map(x => <option key={`${x},${y}`} value={`${x},${y}`}>{t((["expand.anchor0", "expand.anchor1", "expand.anchor2", "expand.anchor3", "expand.anchor4", "expand.anchor5", "expand.anchor6", "expand.anchor7", "expand.anchor8"] as const)[y * 3 + x]!)}</option>))}</select></label>
      {(["width", "height"] as const).map(axis => <label key={axis} className="text-xs">{t(`crop.${axis}`)}
        <input key={`${axis}:${frame[axis]}`} type="number" aria-label={t(`expand.${axis}`)} min={value.base[axis]} step="1" defaultValue={frame[axis]}
          className="mt-1 h-8 w-full rounded border border-border bg-surface px-2"
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} onBlur={e => dimension(axis, Number(e.currentTarget.value))} /></label>)}
    </div>
    <div className="flex flex-wrap gap-1">{["1:1", "4:3", "16:9", "9:16"].map(ratio => <Button key={ratio} variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => {
      const [a, b] = ratio.split(":").map(Number); const r = a! / b!;
      const w = Math.max(frame.width, Math.ceil(frame.height * r)), h = Math.max(frame.height, Math.ceil(frame.width / r));
      const [x, y] = anchor.split(",").map(Number);
      const left = Math.round((w - value.base.width) * x! / 2), top = Math.round((h - value.base.height) * y! / 2);
      void commit({ ...value, left, right: w - value.base.width - left, top, bottom: h - value.base.height - top });
    }}>{ratio}</Button>)}</div>
    <p className="text-xs text-muted-foreground">{t("expand.description")}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" onClick={onMask}>{t("expand.editMask")}</Button>
      <Button size="sm" variant="ghost" onClick={() => void commit(null)}>{t("expand.cancel")}</Button></div>
  </section>;
}

/** Dragging changes only a CSS outline. Raster allocation and history happen once on release. */
export function ExpansionHandles({ value, scale, onChange }: {
  value: TransformExpansion; scale: number; onChange: (next: TransformExpansion) => Promise<void>;
}) {
  const { t } = useTranslation("transform");
  const outline = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ x: number; y: number; sides: string; value: TransformExpansion } | null>(null);
  const nextFor = (e: React.PointerEvent) => {
    const d = drag.current!; const dx = Math.round((e.clientX - d.x) / scale), dy = Math.round((e.clientY - d.y) / scale);
    return { ...d.value, left: Math.max(0, d.value.left - (d.sides.includes("l") ? dx : 0)),
      right: Math.max(0, d.value.right + (d.sides.includes("r") ? dx : 0)),
      top: Math.max(0, d.value.top - (d.sides.includes("t") ? dy : 0)),
      bottom: Math.max(0, d.value.bottom + (d.sides.includes("b") ? dy : 0)) };
  };
  return <div ref={outline} className="pointer-events-none absolute inset-0 border-2 border-sky-400" data-testid="expansion-frame">
    <div className="absolute left-0 top-0 bg-cyan-500/30" style={{ width: value.left, height: "100%" }} />
    <div className="absolute right-0 top-0 bg-cyan-500/30" style={{ width: value.right, height: "100%" }} />
    <div className="absolute top-0 bg-cyan-500/30" style={{ left: value.left, right: value.right, height: value.top }} />
    <div className="absolute bottom-0 bg-cyan-500/30" style={{ left: value.left, right: value.right, height: value.bottom }} />
    {[["l", "0%", "50%"], ["r", "100%", "50%"], ["t", "50%", "0%"], ["b", "50%", "100%"],
      ["lt", "0%", "0%"], ["rt", "100%", "0%"], ["lb", "0%", "100%"], ["rb", "100%", "100%"]].map(([sides, left, top]) => <button
        key={sides} aria-label={t("expand.drag", { edge: sides })} data-expand-edge={sides}
        className="pointer-events-auto absolute rounded-sm border border-white bg-sky-400"
        style={{ left, top, width: 12 / scale, height: 12 / scale, transform: "translate(-50%, -50%)", touchAction: "none", cursor: "move" }}
        onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, sides: sides!, value }; }}
        onPointerMove={e => {
          if (!drag.current || !outline.current) return;
          e.stopPropagation(); const next = nextFor(e);
          outline.current.style.inset = `${value.top - next.top}px ${value.right - next.right}px ${value.bottom - next.bottom}px ${value.left - next.left}px`;
        }}
        onPointerUp={e => { if (!drag.current) return; e.stopPropagation(); const next = nextFor(e); drag.current = null;
          if (outline.current) outline.current.style.inset = "0"; void onChange(next); }}
        onPointerCancel={() => { drag.current = null; if (outline.current) outline.current.style.inset = "0"; }} />)}
  </div>;
}
