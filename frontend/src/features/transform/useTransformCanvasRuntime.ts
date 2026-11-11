import React from "react";

import {
  createCanvasFromPaintLayer,
  createImageElementFromTransformLayer,
  buildImageUrl,
  clamp,
} from "@/features/transform/transformCanvasUtils";
import type { TransformCompositePreviewOptions } from "@/features/transform/useTransformInteractionPreview";
import type { TransformObjectLayout as CanvasObjectLayout } from "@/features/transform/render";
import type { TransformDocument } from "@/shared/types";

type UseTransformCanvasRuntimeArgs = {
  open: boolean;
  documentState: TransformDocument | null;
  surfaceGeometry: {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  } | null;
  renderCompositePreviewRef: React.MutableRefObject<
    (options?: TransformCompositePreviewOptions) => void
  >;
};

function resolveStateUpdate<T>(update: React.SetStateAction<T>, current: T): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export function useTransformCanvasRuntime({
  open,
  documentState,
  surfaceGeometry,
  renderCompositePreviewRef,
}: UseTransformCanvasRuntimeArgs) {
  const surfaceWidth = surfaceGeometry?.width ?? null;
  const surfaceHeight = surfaceGeometry?.height ?? null;
  const surfaceOffsetX = surfaceGeometry?.offsetX ?? null;
  const surfaceOffsetY = surfaceGeometry?.offsetY ?? null;
  const [sourceLoadRevision, setSourceLoadRevision] = React.useState(0);
  const [sourceElement, setSourceElement] = React.useState<HTMLImageElement | null>(null);
  const [layouts, setLayouts] = React.useState<CanvasObjectLayout[]>([]);
  const [fitScale, setFitScaleState] = React.useState(1);
  const [fitReady, setFitReady] = React.useState(false);
  const [fitRevision, setFitRevisionState] = React.useState(0);
  const [zoom, setZoomState] = React.useState(1);
  const [pan, setPanState] = React.useState({ x: 0, y: 0 });

  const fitScaleRef = React.useRef(1);
  const zoomRef = React.useRef(1);
  const panRef = React.useRef({ x: 0, y: 0 });
  const suppressViewportModeUpdateRef = React.useRef(false);
  const pendingFittedViewportResetRef = React.useRef(false);
  const paintCanvasCacheRef = React.useRef<Map<string, HTMLCanvasElement>>(new Map());
  const imageLayerImageCacheRef = React.useRef<Map<string, HTMLImageElement>>(new Map());
  const pendingPaintLayerFilesRef = React.useRef<Map<string, Blob | File>>(new Map());
  const dirtyPaintLayerIdsRef = React.useRef<Set<string>>(new Set());
  const viewportModeRef = React.useRef<"fitted" | "manual">("fitted");
  const lastFitRevisionRef = React.useRef(0);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = React.useState<HTMLDivElement | null>(null);
  const transformedSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const sourceImage = documentState?.sourceImage ?? null;
  const sourceImageHash = sourceImage?.hash ?? null;
  const sourceImagePath = sourceImage?.path ?? null;
  const paintLayers = documentState?.edit.paintLayers ?? null;
  const imageLayers = documentState?.edit.imageLayers ?? null;
  const surfaceScale = fitScale * zoom;
  const zoomLabel = `${Math.round(surfaceScale * 100)}%`;

  const updateFitScale = React.useCallback<React.Dispatch<React.SetStateAction<number>>>((update) => {
    const nextFitScale = resolveStateUpdate(update, fitScaleRef.current);
    fitScaleRef.current = nextFitScale;
    setFitScaleState(nextFitScale);
  }, []);

  const updateFitRevision = React.useCallback<React.Dispatch<React.SetStateAction<number>>>((update) => {
    pendingFittedViewportResetRef.current = true;
    viewportModeRef.current = "fitted";
    setFitRevisionState(update);
  }, []);

  const updateZoom = React.useCallback<React.Dispatch<React.SetStateAction<number>>>((update) => {
    const currentZoom = zoomRef.current;
    const nextZoom = resolveStateUpdate(update, currentZoom);
    if (
      !suppressViewportModeUpdateRef.current &&
      !pendingFittedViewportResetRef.current &&
      !Object.is(nextZoom, currentZoom)
    ) {
      viewportModeRef.current = "manual";
    }
    zoomRef.current = nextZoom;
    setZoomState(nextZoom);
  }, []);

  const updatePan = React.useCallback<React.Dispatch<React.SetStateAction<{ x: number; y: number }>>>((update) => {
    const currentPan = panRef.current;
    const nextPan = resolveStateUpdate(update, currentPan);
    if (
      !suppressViewportModeUpdateRef.current &&
      !pendingFittedViewportResetRef.current &&
      (!Object.is(nextPan.x, currentPan.x) || !Object.is(nextPan.y, currentPan.y))
    ) {
      viewportModeRef.current = "manual";
    }
    panRef.current = nextPan;
    setPanState(nextPan);
  }, []);

  const setViewportNode = React.useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setViewportElement(node);
  }, []);

  const setViewportModeManual = React.useCallback(() => {
    viewportModeRef.current = "manual";
  }, []);

  const setViewportModeFitted = React.useCallback(() => {
    viewportModeRef.current = "fitted";
  }, []);

  const calculateFitScale = React.useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !surfaceWidth || !surfaceHeight) {
      return 1;
    }
    const rect = viewport.getBoundingClientRect();
    const padding = 48;
    const availableWidth = Math.max(rect.width - padding, 1);
    const availableHeight = Math.max(rect.height - padding, 1);
    const nextFit = Math.min(
      availableWidth / surfaceWidth,
      availableHeight / surfaceHeight,
      1,
    );
    return Number.isFinite(nextFit) && nextFit > 0 ? nextFit : 1;
  }, [surfaceHeight, surfaceWidth]);

  const refreshViewportLayout = React.useCallback(() => {
    if (!viewportRef.current || !surfaceWidth || !surfaceHeight) {
      setFitReady(false);
      return false;
    }

    const previousSurfaceScale = Math.max(fitScaleRef.current * zoomRef.current, 0.0001);
    const nextFitScale = calculateFitScale();
    updateFitScale(nextFitScale);
    suppressViewportModeUpdateRef.current = true;
    try {
      if (viewportModeRef.current === "fitted") {
        updateZoom(1);
        updatePan({ x: 0, y: 0 });
      } else {
        updateZoom(clamp(previousSurfaceScale / Math.max(nextFitScale, 0.0001), 0.4, 4));
      }
    } finally {
      suppressViewportModeUpdateRef.current = false;
    }
    setFitReady(true);
    return true;
  }, [calculateFitScale, surfaceHeight, surfaceWidth, updateFitScale, updatePan, updateZoom]);

  const handleFitToViewport = React.useCallback(() => {
    viewportModeRef.current = "fitted";
    refreshViewportLayout();
  }, [refreshViewportLayout]);

  const resetViewportState = React.useCallback(() => {
    viewportModeRef.current = "fitted";
    pendingFittedViewportResetRef.current = false;
    suppressViewportModeUpdateRef.current = true;
    try {
      updateFitScale(1);
      updateZoom(1);
      updatePan({ x: 0, y: 0 });
    } finally {
      suppressViewportModeUpdateRef.current = false;
    }
  }, [updateFitScale, updatePan, updateZoom]);

  const convertPointerToSource = React.useCallback(
    (
      event: PointerEvent | React.PointerEvent | React.MouseEvent,
      options?: { clampToSource?: boolean },
    ) => {
      const transformedSurface = transformedSurfaceRef.current;
      if (!transformedSurface || !documentState) {
        return null;
      }
      const rect = transformedSurface.getBoundingClientRect();
      const nextScale = Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1;
      if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top)
      ) {
        return null;
      }
      const eventClientX = Number(event.clientX);
      const eventClientY = Number(event.clientY);
      const clientX = Number.isFinite(eventClientX) ? eventClientX : rect.left;
      const clientY = Number.isFinite(eventClientY) ? eventClientY : rect.top;
      const x = (clientX - rect.left) / nextScale;
      const y = (clientY - rect.top) / nextScale;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      if (options?.clampToSource === false) {
        return {
          x: x - (surfaceOffsetX ?? 0),
          y: y - (surfaceOffsetY ?? 0),
        };
      }
      return {
        x: clamp(x - (surfaceOffsetX ?? 0), 0, documentState.sourceImage.width),
        y: clamp(y - (surfaceOffsetY ?? 0), 0, documentState.sourceImage.height),
      };
    },
    [documentState, surfaceOffsetX, surfaceOffsetY, surfaceScale],
  );

  React.useEffect(() => {
    if (!open || !sourceImagePath) {
      setSourceElement(null);
      return;
    }
    let cancelled = false;
    const image = new window.Image();
    image.onload = () => {
      if (!cancelled) {
        setSourceElement(image);
      }
    };
    image.src = buildImageUrl(
      sourceImagePath,
      `${sourceImageHash || ""}:${sourceLoadRevision}`,
    );
    return () => {
      cancelled = true;
    };
  }, [sourceImageHash, sourceImagePath, open, sourceLoadRevision]);

  React.useEffect(() => {
    const viewport = viewportElement;
    if (!open || !viewport || !sourceElement) {
      return undefined;
    }
    let frame: number | null = null;
    const redrawMountedEditCanvas = () => {
      if (!canvasRef.current) {
        return;
      }
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (canvasRef.current) {
          renderCompositePreviewRef.current();
        }
      });
    };
    const observer = new MutationObserver(redrawMountedEditCanvas);
    observer.observe(viewport, { childList: true, subtree: true });
    redrawMountedEditCanvas();
    return () => {
      observer.disconnect();
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [open, renderCompositePreviewRef, sourceElement, viewportElement]);

  React.useEffect(() => {
    if (!open || !paintLayers || !sourceImage) {
      paintCanvasCacheRef.current.clear();
      return;
    }
    let cancelled = false;
    const hydrate = async () => {
      let cacheChanged = false;
      for (const layer of paintLayers) {
        let canvas = paintCanvasCacheRef.current.get(layer.id);
        if (!canvas || canvas.width !== sourceImage.width || canvas.height !== sourceImage.height) {
          canvas = await createCanvasFromPaintLayer(layer, sourceImage);
          paintCanvasCacheRef.current.set(layer.id, canvas);
          cacheChanged = true;
        }
      }
      for (const layerId of [...paintCanvasCacheRef.current.keys()]) {
        if (!paintLayers.some((layer) => layer.id === layerId)) {
          paintCanvasCacheRef.current.delete(layerId);
          cacheChanged = true;
        }
      }
      if (!cancelled && cacheChanged) {
        renderCompositePreviewRef.current();
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    paintLayers,
    renderCompositePreviewRef,
    sourceImage,
  ]);

  React.useEffect(() => {
    if (!open || !imageLayers) {
      imageLayerImageCacheRef.current.clear();
      return;
    }
    let cancelled = false;
    const hydrate = async () => {
      let cacheChanged = false;
      for (const layer of imageLayers) {
        const source = layer.dataUrl || layer.assetPath || "";
        const cached = imageLayerImageCacheRef.current.get(layer.id);
        if (cached?.dataset.transformSource === source) {
          continue;
        }
        const image = await createImageElementFromTransformLayer(layer);
        if (cancelled) {
          return;
        }
        if (image) {
          image.dataset.transformSource = source;
          imageLayerImageCacheRef.current.set(layer.id, image);
          cacheChanged = true;
        }
      }
      for (const layerId of [...imageLayerImageCacheRef.current.keys()]) {
        if (!imageLayers.some((layer) => layer.id === layerId)) {
          imageLayerImageCacheRef.current.delete(layerId);
          cacheChanged = true;
        }
      }
      if (!cancelled && cacheChanged) {
        renderCompositePreviewRef.current();
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [imageLayers, open, renderCompositePreviewRef]);

  React.useEffect(() => {
    const viewport = viewportElement;
    if (!open || !viewport || !sourceImagePath || !surfaceWidth || !surfaceHeight) {
      setFitReady(false);
      return;
    }

    if (lastFitRevisionRef.current !== fitRevision) {
      lastFitRevisionRef.current = fitRevision;
      viewportModeRef.current = "fitted";
      pendingFittedViewportResetRef.current = false;
    }

    const frame = window.requestAnimationFrame(refreshViewportLayout);
    const observer = new ResizeObserver(refreshViewportLayout);
    observer.observe(viewport);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    fitRevision,
    open,
    refreshViewportLayout,
    surfaceHeight,
    surfaceOffsetX,
    surfaceOffsetY,
    surfaceWidth,
    sourceImagePath,
    viewportElement,
  ]);

  return {
    sourceElement,
    setSourceElement,
    layouts,
    setLayouts,
    fitScale,
    setFitScale: updateFitScale,
    fitReady,
    setFitReady,
    setFitRevision: updateFitRevision,
    sourceLoadRevision,
    setSourceLoadRevision,
    zoom,
    setZoom: updateZoom,
    pan,
    setPan: updatePan,
    surfaceScale,
    zoomLabel,
    paintCanvasCacheRef,
    imageLayerImageCacheRef,
    pendingPaintLayerFilesRef,
    dirtyPaintLayerIdsRef,
    viewportRef,
    setViewportNode,
    setViewportModeManual,
    setViewportModeFitted,
    transformedSurfaceRef,
    canvasRef,
    refreshViewportLayout,
    resetViewportState,
    handleFitToViewport,
    convertPointerToSource,
  };
}
