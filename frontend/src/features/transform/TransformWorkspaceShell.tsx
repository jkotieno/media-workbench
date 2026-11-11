import React from "react";
import {
  Blend,
  Brush,
  Crop,
  Droplets,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  Hand,
  History,
  Image as ImageIcon,
  Lasso,
  Layers3,
  Lock,
  MousePointer2,
  PaintBucket,
  Pencil,
  Pipette,
  Plus,
  ScanLine,
  Sparkles,
  SquareDashed,
  Trash2,
  Type,
  Unlock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  getTransformTools,
  type TransformToolDefinition,
  type TransformToolIcon,
  type TransformToolId,
} from "@/features/transform/transformTools";
import type { TransformHistoryEntry } from "@/features/transform/useTransformHistory";
import type { TransformDocument, TransformLayer, TransformMode } from "@/shared/types";

type ShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInteractionChange?: (active: boolean) => void;
  title: string;
  header: React.ReactNode;
  contextBar: React.ReactNode;
  toolDock: React.ReactNode;
  canvas: React.ReactNode;
  rightDock: React.ReactNode;
  status?: React.ReactNode;
  rightDockOpen?: boolean;
};

export function TransformWorkspaceShell({
  open,
  onOpenChange,
  onInteractionChange,
  title,
  header,
  contextBar,
  toolDock,
  canvas,
  rightDock,
  status,
  rightDockOpen = true,
}: ShellProps) {
  React.useEffect(() => {
    if (!open) {
      return undefined;
    }
    const body = document.body;
    const previousValue = body.dataset.transformWorkspaceOpen;
    body.dataset.transformWorkspaceOpen = "true";
    return () => {
      if (previousValue == null) {
        delete body.dataset.transformWorkspaceOpen;
      } else {
        body.dataset.transformWorkspaceOpen = previousValue;
      }
    };
  }, [open]);

  React.useEffect(() => {
    if (!open || !onInteractionChange) {
      return undefined;
    }
    const finishInteraction = () => onInteractionChange(false);
    window.addEventListener("pointerup", finishInteraction, true);
    window.addEventListener("pointercancel", finishInteraction, true);
    return () => {
      window.removeEventListener("pointerup", finishInteraction, true);
      window.removeEventListener("pointercancel", finishInteraction, true);
      finishInteraction();
    };
  }, [onInteractionChange, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownCapture={() => onInteractionChange?.(true)}
        surface="solid"
        overlayBlur={false}
        overlayClassName="bg-black/60"
        className="grid h-[min(94dvh,980px)] max-h-[calc(100dvh-1rem)] w-[min(98vw,1580px)] max-w-none grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-[1.5rem] border border-border bg-surface p-0 text-foreground shadow-[0_24px_90px_rgba(15,23,42,0.24)] dark:shadow-[0_24px_90px_rgba(0,0,0,0.5)] sm:rounded-[1.5rem]"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {header}
        {contextBar}
        <div className="relative grid min-h-0 min-w-0 grid-cols-[48px_minmax(0,1fr)] overflow-hidden bg-background lg:grid-cols-[48px_minmax(0,1fr)_300px]">
          {toolDock}
          <main className="relative min-h-0 min-w-0 overflow-hidden border-l border-border lg:border-r">
            {canvas}
            {status && (
              <div className="pointer-events-none absolute bottom-3 left-3 z-30 max-w-[70%] truncate rounded-md border border-border/80 bg-surface px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
                {status}
              </div>
            )}
          </main>
          <aside
            className={cn(
              "min-h-0 min-w-0 overflow-hidden bg-surface lg:relative lg:inset-auto lg:block lg:w-auto",
              rightDockOpen
                ? "absolute inset-y-0 right-0 z-40 block w-[min(82vw,320px)] border-l border-border shadow-2xl lg:shadow-none"
                : "hidden",
            )}
          >
            {rightDock}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type TransformHeaderProps = {
  filename: string;
  saveState: React.ReactNode;
  saveStateTitle: string;
  help: React.ReactNode;
  modeControl: React.ReactNode;
  actions: React.ReactNode;
};

export function TransformHeader({
  filename,
  saveState,
  saveStateTitle,
  help,
  modeControl,
  actions,
}: TransformHeaderProps) {
  return (
    <DialogHeader className="border-b border-border bg-surface-raised/95 px-3 py-2 pr-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <div className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-[260px] truncate text-xs font-medium text-foreground" title={filename}>
            {filename}
          </span>
          <span
            className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
            title={saveStateTitle}
          >
            {saveState}
          </span>
          {help}
        </div>
        <div className="justify-self-center">{modeControl}</div>
        <div data-transform-header-actions className="flex min-w-0 items-center justify-end gap-0.5">{actions}</div>
      </div>
    </DialogHeader>
  );
}

export function TransformContextBar({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-11 overflow-x-auto border-b border-border bg-surface/95 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex min-w-max items-center gap-2">{children}</div>
    </div>
  );
}

function ToolIcon({ icon, className = "h-4 w-4" }: { icon: TransformToolIcon; className?: string }) {
  switch (icon) {
    case "select":
      return <MousePointer2 className={className} />;
    case "hand":
      return <Hand className={className} />;
    case "lettering":
      return <Type className={className} />;
    case "pencil":
      return <Pencil className={className} />;
    case "brush":
      return <Brush className={className} />;
    case "eraser":
    case "subtract":
      return <Eraser className={className} />;
    case "fill":
      return <PaintBucket className={className} />;
    case "eyedropper":
      return <Pipette className={className} />;
    case "smudge":
      return <Droplets className={className} />;
    case "pixelate":
      return <ScanLine className={className} />;
    case "crop":
      return <Crop className={className} />;
    case "rectangle":
      return <SquareDashed className={className} />;
    case "lasso":
      return <Lasso className={className} />;
  }
}

type TransformToolDockProps = {
  mode: TransformMode;
  activeTool: TransformToolId;
  ariaLabel: string;
  getLabel: (tool: TransformToolDefinition) => string;
  onSelect: (tool: TransformToolDefinition) => void;
};

export function TransformToolDock({
  mode,
  activeTool,
  ariaLabel,
  getLabel,
  onSelect,
}: TransformToolDockProps) {
  const tools = getTransformTools(mode);
  return (
    <nav
      aria-label={ariaLabel}
      className="z-20 flex min-h-0 flex-col items-center gap-1 overflow-y-auto bg-surface-raised/90 px-1 py-2"
    >
      {tools.map((tool, index) => {
        const separated =
          index > 0 &&
          tools[index - 1]?.group !== tool.group;
        const label = getLabel(tool);
        return (
          <React.Fragment key={`${tool.mode}-${tool.id}`}>
            {separated && <div aria-hidden="true" className="my-0.5 h-px w-6 bg-border" />}
            <Button
              type="button"
              variant={activeTool === tool.id ? "default" : "ghost"}
              size="sm"
              aria-label={`${label} (${tool.shortcut})`}
              aria-pressed={activeTool === tool.id}
              title={`${label} · ${tool.shortcut}`}
              onClick={() => onSelect(tool)}
              className="h-9 w-9 shrink-0 p-0"
            >
              <ToolIcon icon={tool.icon} />
            </Button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export type TransformRightDockTab = "inspector" | "layers" | "history" | "mask";

type TransformRightDockProps = {
  mode: TransformMode;
  activeTab: TransformRightDockTab;
  onTabChange: (tab: TransformRightDockTab) => void;
  inspector: React.ReactNode;
  layers: React.ReactNode;
  history: React.ReactNode;
  mask: React.ReactNode;
  labels: {
    inspector: string;
    layers: string;
    history: string;
    mask: string;
  };
};

export function TransformRightDock({
  mode,
  activeTab,
  onTabChange,
  inspector,
  layers,
  history,
  mask,
  labels,
}: TransformRightDockProps) {
  const tabs: Array<{ id: TransformRightDockTab; label: string; icon: React.ReactNode }> =
    mode === "edit"
      ? [
        { id: "inspector", label: labels.inspector, icon: <Blend className="h-3.5 w-3.5" /> },
        { id: "layers", label: labels.layers, icon: <Layers3 className="h-3.5 w-3.5" /> },
        { id: "history", label: labels.history, icon: <History className="h-3.5 w-3.5" /> },
      ]
      : [
        { id: "mask", label: labels.mask, icon: <Sparkles className="h-3.5 w-3.5" /> },
        { id: "history", label: labels.history, icon: <History className="h-3.5 w-3.5" /> },
      ];
  const validActiveTab = tabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : tabs[0].id;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div role="tablist" className="grid grid-flow-col auto-cols-fr border-b border-border p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={validActiveTab === tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              validActiveTab === tab.id
                ? "bg-primary/12 font-medium text-foreground"
                : "text-muted-foreground hover:bg-surface-raised hover:text-foreground",
            )}
          >
            {tab.icon}
            <span className="truncate">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-y-auto overflow-x-hidden p-3">
        {validActiveTab === "inspector"
          ? inspector
          : validActiveTab === "layers"
            ? layers
            : validActiveTab === "mask"
              ? mask
              : history}
      </div>
    </div>
  );
}

type TransformLayersPanelProps = {
  document: TransformDocument | null;
  selectedLayerId: string | null;
  onSelect: (layer: TransformLayer) => void;
  onToggleVisible: (layer: TransformLayer) => void;
  onToggleLock: (layer: TransformLayer) => void;
  onRename: (layer: TransformLayer, name: string) => void;
  onDropLayer: (draggedLayerId: string, targetLayerId: string) => void;
  onCreateLayer: () => void;
  onImportImage: () => void;
  onDeleteLayer: (layer: TransformLayer) => void;
  labels: {
    count: (count: number) => string;
    select: (name: string) => string;
    nameAria: string;
    background: string;
    newLayer: string;
    importImage: string;
    empty: string;
    hide: string;
    show: string;
    lock: string;
    unlock: string;
    delete: string;
  };
};

function LayerThumbnail({ layer }: { layer: TransformLayer }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-[linear-gradient(135deg,var(--color-surface),var(--color-surface-raised))]">
      {layer.kind === "text_object"
        ? <FileText className="h-4 w-4 text-muted-foreground" />
        : layer.kind === "image_layer"
          ? <ImageIcon className="h-4 w-4 text-muted-foreground" />
          : <Brush className="h-4 w-4 text-muted-foreground" />}
    </span>
  );
}

export function TransformLayersPanel({
  document,
  selectedLayerId,
  onSelect,
  onToggleVisible,
  onToggleLock,
  onRename,
  onDropLayer,
  onCreateLayer,
  onImportImage,
  onDeleteLayer,
  labels,
}: TransformLayersPanelProps) {
  const [draggedLayerId, setDraggedLayerId] = React.useState<string | null>(null);
  const layers = document ? [...document.edit.layers].reverse() : [];
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {labels.count(layers.length + 1)}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button type="button" size="sm" variant="outline" onClick={onImportImage} className="h-7 min-w-0 px-2 text-[11px]">
            <ImageIcon className="mr-1 h-3.5 w-3.5" />
            {labels.importImage}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onCreateLayer} className="h-7 min-w-0 px-2 text-[11px]">
            <Plus className="mr-1 h-3.5 w-3.5" />
            {labels.newLayer}
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        {layers.map((layer) => (
          <div
            key={layer.id}
            draggable
            onDragStart={(event) => {
              setDraggedLayerId(layer.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", layer.id);
            }}
            onDragEnd={() => setDraggedLayerId(null)}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = draggedLayerId || event.dataTransfer.getData("text/plain");
              if (sourceId && sourceId !== layer.id) {
                onDropLayer(sourceId, layer.id);
              }
              setDraggedLayerId(null);
            }}
            className={cn(
              "group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border p-1.5 transition",
              selectedLayerId === layer.id
                ? "border-primary/60 bg-primary/10"
                : "border-border bg-surface hover:border-primary/30",
              draggedLayerId === layer.id && "opacity-45",
            )}
          >
            <button
              type="button"
              aria-label={labels.select(layer.name)}
              onClick={() => onSelect(layer)}
              className="cursor-grab rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing"
            >
              <LayerThumbnail layer={layer} />
            </button>
            <Input
              aria-label={labels.nameAria}
              value={layer.name}
              onFocus={() => onSelect(layer)}
              onChange={(event) => onRename(layer, event.target.value)}
              className="h-8 min-w-0 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-1"
            />
            <div className="flex items-center">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={layer.visible ? labels.hide : labels.show}
                onClick={() => onToggleVisible(layer)}
                className="h-7 w-7 p-0"
              >
                {layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={layer.locked ? labels.unlock : labels.lock}
                onClick={() => onToggleLock(layer)}
                className="h-7 w-7 p-0"
              >
                {layer.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={labels.delete}
                onClick={() => onDeleteLayer(layer)}
                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {!layers.length && (
          <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            {labels.empty}
          </div>
        )}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-border bg-surface/70 p-1.5 opacity-80">
          <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface-raised">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          </span>
          <span className="truncate px-1 text-xs">{labels.background}</span>
          <Lock className="mr-2 h-3.5 w-3.5 text-muted-foreground" aria-label={labels.lock} />
        </div>
      </div>
    </div>
  );
}

export function TransformHistoryPanel({
  entries,
  index,
  commandsLabel,
  memoryLabel,
  emptyLabel,
}: {
  entries: TransformHistoryEntry[];
  index: number;
  commandsLabel: string;
  memoryLabel: string;
  emptyLabel: string;
}) {
  const activeEntries = entries.slice(0, index).reverse();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <span>{commandsLabel}</span>
        <span>{memoryLabel}</span>
      </div>
      {activeEntries.length ? activeEntries.map((entry, reverseIndex) => (
        <div
          key={`${entry.timestamp}-${reverseIndex}`}
          className={cn(
            "rounded-lg border border-border bg-surface px-3 py-2 text-xs",
            reverseIndex === 0 && "border-primary/40 bg-primary/8",
          )}
        >
          <div className="font-medium text-foreground">{entry.label}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {new Date(entry.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </div>
        </div>
      )) : (
        <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}

export function TransformSheet({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  destructive = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
  destructive?: boolean;
}) {
  if (!open) {
    return null;
  }
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/55 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "w-full max-w-md rounded-2xl border bg-surface-raised p-4 shadow-2xl",
          destructive ? "border-destructive/35" : "border-border",
        )}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        <div className="mt-4 space-y-3">{children}</div>
        <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>
      </section>
    </div>
  );
}
