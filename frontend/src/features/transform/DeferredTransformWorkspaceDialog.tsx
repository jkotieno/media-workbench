import React from "react";
import { createPortal } from "react-dom";
import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { requestCurrentMaskCoverage } from "@/features/transform/maskApplyBridge";
import type { TransformWorkspaceDialogProps } from "@/features/transform/TransformWorkspaceDialog";

const LazyTransformWorkspaceDialog = React.lazy(async () => {
  const module = await import("@/features/transform/TransformWorkspaceDialog");
  return { default: module.TransformWorkspaceDialog };
});

export function DeferredTransformWorkspaceDialog(props: TransformWorkspaceDialogProps) {
  const { t } = useTranslation("transform");
  const [maskHeaderActionsTarget, setMaskHeaderActionsTarget] = React.useState<HTMLElement | null>(null);
  const [maskReady, setMaskReady] = React.useState(false);
  const [hasExternalApply, setHasExternalApply] = React.useState(false);
  const [isApplyingMask, setIsApplyingMask] = React.useState(false);
  const applyMaskLabel = t("actions.applyMask", { defaultValue: "Apply mask" });

  React.useEffect(() => {
    if (!props.open) {
      setMaskHeaderActionsTarget(null);
      setMaskReady(false);
      setHasExternalApply(false);
      return undefined;
    }

    const syncMaskActions = () => {
      const surface = document.querySelector<HTMLElement>('[data-testid="mask-canvas-surface"]');
      const target = document.querySelector<HTMLElement>("[data-transform-header-actions]");
      const canvas = surface?.querySelector<HTMLCanvasElement>("canvas") ?? null;
      const externalApply = Boolean(
        target &&
        Array.from(target.querySelectorAll<HTMLButtonElement>("button")).some((button) => {
          if (button.dataset.transformGenericApply === "true") {
            return false;
          }
          return button.textContent?.trim() === applyMaskLabel;
        }),
      );

      const expanded = document.querySelector('[data-testid="transform-viewport"]')?.getAttribute("data-outpainting") === "true";
      setMaskHeaderActionsTarget(surface && !expanded ? target : null);
      setMaskReady(Boolean(canvas && canvas.style.pointerEvents !== "none"));
      setHasExternalApply(externalApply);
    };

    syncMaskActions();
    const observer = new MutationObserver(syncMaskActions);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "disabled", "data-outpainting"],
    });
    return () => observer.disconnect();
  }, [applyMaskLabel, props.open]);

  const handleApplyMask = React.useCallback(async () => {
    const launchPayload = props.launchPayload;
    if (!launchPayload?.imagePath || isApplyingMask || !maskReady) {
      return;
    }

    setIsApplyingMask(true);
    try {
      const coverageFile = await requestCurrentMaskCoverage();
      const result = await api.applyTransformMask({
        coverageFile,
        sourcePath: launchPayload.imagePath,
        projectSlug: launchPayload.workspaceProjectSlug ?? null,
        subfolder: launchPayload.workspaceFolder ?? null,
      });
      await props.onExported?.({
        path: result.path,
        filename: result.filename,
        project_slug: launchPayload.workspaceProjectSlug ?? null,
        folder: launchPayload.workspaceFolder ?? null,
        saved_at: new Date().toISOString(),
      });
      props.onOpenChange(false);
    } catch (error) {
      console.error("Failed to apply mask to image", error);
      window.alert(t("mask.errors.apply", { defaultValue: "Failed to apply mask to image." }));
    } finally {
      setIsApplyingMask(false);
    }
  }, [isApplyingMask, maskReady, props.launchPayload, props.onExported, props.onOpenChange, t]);

  if (!props.open) {
    return null;
  }

  return (
    <>
      <React.Suspense
        fallback={
          <div className="fixed inset-0 z-[260] flex items-center justify-center bg-slate-950/55 backdrop-blur-sm">
            <div className="rounded-2xl border border-white/15 bg-slate-950/90 px-5 py-3 text-sm font-semibold text-white shadow-2xl">
              {t("loadingTransform")}
            </div>
          </div>
        }
      >
        <LazyTransformWorkspaceDialog {...props} />
      </React.Suspense>
      {maskHeaderActionsTarget && !hasExternalApply
        ? createPortal(
          <Button
            data-transform-generic-apply="true"
            type="button"
            size="sm"
            onClick={() => void handleApplyMask()}
            disabled={!maskReady || isApplyingMask}
            className="ml-0.5 h-8 px-3 text-[11px]"
          >
            {isApplyingMask ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1 h-3.5 w-3.5" />
            )}
            {applyMaskLabel}
          </Button>,
          maskHeaderActionsTarget,
        )
        : null}
    </>
  );
}
