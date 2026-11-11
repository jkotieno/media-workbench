import React from "react";

import type { TransformDocument } from "@/shared/types";

export type TransformCompositePreviewOptions = {
  updateLayouts?: boolean;
  compositeOnly?: boolean;
  dirtySourceBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type RenderCompositePreviewRef = React.MutableRefObject<
  (options?: TransformCompositePreviewOptions) => void
>;

export function useTransformInteractionPreview(renderCompositePreviewRef: RenderCompositePreviewRef) {
  const interactionDraftDocumentRef = React.useRef<TransformDocument | null>(null);
  const previewFrameRef = React.useRef<number | null>(null);
  const pendingPreviewOptionsRef = React.useRef<TransformCompositePreviewOptions | null>(null);

  React.useEffect(
    () => () => {
      if (previewFrameRef.current != null) {
        window.cancelAnimationFrame(previewFrameRef.current);
      }
    },
    [],
  );

  const scheduleCompositePreview = React.useCallback((options?: TransformCompositePreviewOptions) => {
    const pending = pendingPreviewOptionsRef.current;
    const updateLayouts = Boolean(pending?.updateLayouts || options?.updateLayouts);
    const incomingIsFull = !options?.compositeOnly && !options?.dirtySourceBounds;
    const pendingIsFull = Boolean(
      pending &&
      !pending.compositeOnly &&
      !pending.dirtySourceBounds,
    );
    if (incomingIsFull || pendingIsFull) {
      pendingPreviewOptionsRef.current = { updateLayouts };
    } else if (pending?.dirtySourceBounds || options?.dirtySourceBounds) {
      const first = pending?.dirtySourceBounds;
      const second = options?.dirtySourceBounds;
      const dirtySourceBounds = first && second
        ? {
          x: Math.min(first.x, second.x),
          y: Math.min(first.y, second.y),
          width:
            Math.max(first.x + first.width, second.x + second.width) -
            Math.min(first.x, second.x),
          height:
            Math.max(first.y + first.height, second.y + second.height) -
            Math.min(first.y, second.y),
        }
        : first ?? second;
      pendingPreviewOptionsRef.current = {
        updateLayouts,
        dirtySourceBounds,
      };
    } else {
      pendingPreviewOptionsRef.current = {
        updateLayouts,
        compositeOnly: true,
      };
    }
    if (previewFrameRef.current != null) {
      return;
    }
    previewFrameRef.current = window.requestAnimationFrame(() => {
      const pendingOptions = pendingPreviewOptionsRef.current ?? { updateLayouts: false };
      pendingPreviewOptionsRef.current = null;
      previewFrameRef.current = null;
      renderCompositePreviewRef.current(pendingOptions);
    });
  }, [renderCompositePreviewRef]);

  return {
    interactionDraftDocumentRef,
    scheduleCompositePreview,
  };
}
