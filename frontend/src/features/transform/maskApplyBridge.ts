import { createClientUuid } from "@/lib/clientUuid";

export const MASK_APPLY_REQUEST_EVENT = "sweet-tea:mask-apply-request";
export const MASK_APPLY_READY_EVENT = "sweet-tea:mask-apply-ready";

export type MaskApplyRequestDetail = { requestId: string };
export type MaskApplyReadyDetail = { requestId: string; coverageFile: File };

export function requestCurrentMaskCoverage(signal?: AbortSignal): Promise<File> {
  const requestId = createClientUuid();
  return new Promise<File>((resolve, reject) => {
    let interval = 0, timeout = 0;
    const cleanup = () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      window.removeEventListener(MASK_APPLY_READY_EVENT, handleReady as EventListener);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Input changed.", "AbortError"));
    };
    const handleReady = (event: Event) => {
      const detail = (event as CustomEvent<MaskApplyReadyDetail>).detail;
      if (!detail || detail.requestId !== requestId) return;
      cleanup();
      resolve(detail.coverageFile);
    };
    const dispatchRequest = () => window.dispatchEvent(new CustomEvent<MaskApplyRequestDetail>(
      MASK_APPLY_REQUEST_EVENT, {detail: {requestId}},
    ));
    if (signal?.aborted) {onAbort(); return;}
    window.addEventListener(MASK_APPLY_READY_EVENT, handleReady as EventListener);
    signal?.addEventListener("abort", onAbort, {once: true});
    interval = window.setInterval(dispatchRequest, 150);
    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Mask editor did not return coverage."));
    }, 10000);
    dispatchRequest();
  });
}
