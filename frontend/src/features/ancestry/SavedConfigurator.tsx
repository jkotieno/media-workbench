import { useMemo, useState } from "react";
import { isMediaUploadField } from "@/components/dynamic-form/fieldUtils";
import { isPromptSchemaField } from "@/lib/promptUtils";
import type { AncestryNode } from "@/shared/api/ancestry.api";
import { ancestryMediaUrl } from "@/shared/api/ancestry.api";
import { savedConfigurator, savedControlMedia, savedRecord, type SavedControl } from "./savedConfigurator";
import type { AncestryGraph } from "./ancestryGraph";

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
    if (value === null) return <span className="text-muted-foreground">None</span>;
    if (typeof value !== "object") return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
    if (depth > 5) return <span>Further structure in the technical record</span>;
    if (Array.isArray(value)) return <ol className="space-y-2">{value.slice(0, 100).map((entry, index) => <li key={index} className="rounded bg-muted/40 p-2"><Value value={entry} depth={depth + 1} /></li>)}{value.length > 100 && <li>More entries in the technical record</li>}</ol>;
    return <dl className="space-y-2">{Object.entries(savedRecord(value)).slice(0, 100).map(([key, entry]) => <div key={key}><dt className="text-xs text-muted-foreground">{key}</dt><dd><Value value={entry} depth={depth + 1} /></dd></div>)}</dl>;
}

function Control({ control, details, graph, stepId, select }: { control: SavedControl; details: Record<string, unknown>; graph: AncestryGraph; stepId: string; select: (node: AncestryNode) => void }) {
    const { key, field, label, value, recorded } = control;
    const media = isMediaUploadField(key, field);
    const inputs = media ? savedControlMedia(control, details, graph, stepId) : [];
    const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    const tooltip = String(field.x_tooltip || field.tooltip || field.description || "");
    return <div data-saved-control={key} className="min-w-0 space-y-2">
        <p className="text-sm font-medium" title={tooltip}>{label}{field.__hidden ? <span className="ml-2 text-xs font-normal text-muted-foreground">Hidden control</span> : null}</p>
        {!recorded ? <p className="rounded border border-dashed border-border p-3 text-sm text-muted-foreground">Value not recorded</p>
            : media ? <div className="space-y-2">{(inputs.length ? inputs : [undefined]).map((input, index) => {
                const preview = input && !["restricted", "deleted", "revision_mismatch"].includes(input.state) ? ancestryMediaUrl(input.preview_url) : undefined;
                return <button key={input?.id || index} type="button" className="flex min-h-16 w-full items-center gap-3 rounded-md border border-border bg-muted/20 p-2 text-left text-sm disabled:cursor-default" disabled={!input || input.state === "restricted"} onClick={() => input && select(input)}>
                    {preview ? <img src={preview} alt="" className="h-12 w-16 rounded object-cover" /> : <span aria-hidden="true" className="flex h-12 w-16 items-center justify-center rounded bg-muted text-xs text-muted-foreground">{String(field.x_media_kind || "Media")}</span>}
                    <span className="min-w-0 break-words">{input?.state === "restricted" ? "Source unavailable" : input?.label || text.split(/[\\/]/).pop() || "Recorded media reference"}{!input && <span className="block text-xs text-muted-foreground">Earlier source not identified</span>}</span>
                </button>;
            })}</div>
                : isPromptSchemaField(key, field) || field.widget === "textarea" ? <textarea aria-label={label} readOnly value={text} rows={3} className="w-full resize-y rounded-md border border-border bg-muted/20 p-3 text-sm leading-relaxed" />
                    : field.widget === "json" ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/20 p-3 text-sm">{JSON.stringify(value, null, 2)}</pre>
                        : typeof value === "boolean" ? <div className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-muted/20 px-3 text-sm"><span aria-hidden="true" className={`h-4 w-7 rounded-full ${value ? "bg-primary" : "bg-muted-foreground/30"}`} /><span>{value ? "On" : "Off"}</span></div>
                            : field.enum ? <select disabled aria-label={label} value={text} className="min-h-11 w-full rounded-md border border-border bg-muted/20 px-3 text-sm opacity-100"><option value={text}>{text}</option></select>
                                : typeof value === "string" || typeof value === "number" ? <input aria-label={label} readOnly value={text} className="min-h-11 w-full rounded-md border border-border bg-muted/20 px-3 text-sm" />
                                    : <div className="min-h-11 rounded-md border border-border bg-muted/20 p-3 text-sm"><Value value={value} /></div>}
    </div>;
}

export function SavedConfigurator({ details, graph, stepId, select }: { details: Record<string, unknown>; graph: AncestryGraph; stepId: string; select: (node: AncestryNode) => void }) {
    const model = useMemo(() => savedConfigurator(details), [details]);
    const [tab, setTab] = useState<"core" | "expanded">("core");
    const hasCore = model.groups.some(group => group.core);
    const chosen = hasCore ? tab : "expanded";
    const groups = model.groups.filter(group => group.core === (chosen === "core"));
    if (model.schemaMissing) return <div className="space-y-4" data-testid="saved-configurator-missing">
        <p className="text-sm text-muted-foreground">Original control layout not recorded. These are the available saved values.</p>
        {Object.entries(model.parameters).length ? <Value value={model.parameters} /> : <p className="text-sm text-muted-foreground">No creative control values were recorded.</p>}
    </div>;
    return <div data-testid="saved-configurator" className="space-y-5">
        <div role="tablist" aria-label="Saved Configurator controls" className="flex gap-5 border-b border-border">
            <button type="button" role="tab" aria-selected={chosen === "core"} disabled={!hasCore} className={`min-h-11 border-b-2 text-sm disabled:opacity-50 ${chosen === "core" ? "border-primary text-primary" : "border-transparent"}`} onClick={() => setTab("core")}>Core</button>
            <button type="button" role="tab" aria-selected={chosen === "expanded"} className={`min-h-11 border-b-2 text-sm ${chosen === "expanded" ? "border-primary text-primary" : "border-transparent"}`} onClick={() => setTab("expanded")}>Expanded controls</button>
        </div>
        <p className="text-xs text-muted-foreground">Saved controls · read-only</p>
        <div role="tabpanel" aria-label={chosen === "core" ? "Core" : "Expanded controls"} className="space-y-6">
            {groups.map(group => <section key={group.id} className="space-y-4" aria-label={group.title}><h4 className="text-sm font-semibold">{group.title}</h4>{group.controls.map(control => <Control key={control.key} control={control} details={details} graph={graph} stepId={stepId} select={select} />)}</section>)}
            {!groups.length && <p className="text-sm text-muted-foreground">No additional controls were recorded.</p>}
        </div>
    </div>;
}
