import {create} from "zustand";
import {API_BASE, throwApiRequestError} from "./client";
import {createClientUuid} from "@/lib/clientUuid";
import {getProfileStorageScope} from "@/lib/profileStorage";

export type MediaOperation = {
  operation_id: string; state: "done" | "applying" | "needs_attention";
  revisions?: Record<string, number>;
  items?: Array<{image_id: number; cause?: string; path?: string}>;
  started?: number; scope?: string | null;
};
export const useMediaOperations = create<{items: Record<string, MediaOperation>}>()(() => ({items: {}}));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const observing = new Set<string>();

async function observe(operation: MediaOperation, scope: string | null | undefined) {
  const id = operation.operation_id;
  if (observing.has(id) || !id || operation.state === "done") return;
  observing.add(id);
  const started = Date.now();
  try {
    for (;;) {
      if (scope !== getProfileStorageScope()) return;
      useMediaOperations.setState(previous => ({items: {...previous.items, [id]: {...operation, started, scope}}}));
      await delay(1000);
      try {
        const response = await fetch(`${API_BASE}/gallery/operations/${encodeURIComponent(id)}`, {cache: "no-store"});
        if (!response.ok) continue;
        operation = await response.json();
      } catch { continue; }
      if (operation.state === "done") return;
      if (operation.state === "needs_attention") {
        useMediaOperations.setState(previous => ({items: {...previous.items, [id]: {...operation, started, scope}}}));
        return;
      }
    }
  } finally {
    observing.delete(id);
    if (operation.state !== "needs_attention" || scope !== getProfileStorageScope()) useMediaOperations.setState(previous => {
      const items = {...previous.items}; delete items[id]; return {items};
    });
  }
}

export async function retryMediaOperation(id: string) {
  const response = await fetch(`${API_BASE}/gallery/operations/${encodeURIComponent(id)}/retry`, {method: "POST"});
  if (!response.ok) await throwApiRequestError(response, "This media action could not resume");
  void observe(await response.json(), getProfileStorageScope());
}

/** Retry ambiguous transport failures with the SAME persisted request identity. */
export async function mediaMutation(url: string, init: RequestInit): Promise<Response> {
  const scope = getProfileStorageScope();
  const payload = {...JSON.parse(String(init.body || "{}")), operation_id: createClientUuid()};
  let requestUrl=url;
  const request: RequestInit = {...init, body: JSON.stringify(payload)};
  if (init.method?.toUpperCase()==="DELETE" && !init.body) {
    requestUrl=url+(url.includes("?")?"&":"?")+"operation_id="+encodeURIComponent(payload.operation_id);
    delete request.body;
  }
  let attempt = 0;
  for (;;) {
    if (scope !== getProfileStorageScope()) throw new Error("The active workspace changed");
    let response: Response | undefined;
    try { response = await fetch(requestUrl, request); }
    catch (error) { if (init.signal?.aborted) throw error; }
    if (scope !== getProfileStorageScope()) throw new DOMException("The active workspace changed", "AbortError");
    if (response) {
      // A received error is definitive. In particular a writer invariant must
      // remain visible to diagnostics instead of becoming a hidden retry loop.
      if (response.ok) {
        const operation: MediaOperation = await response.clone().json();
        if (scope === getProfileStorageScope()) void observe(operation, scope);
      }
      return response;
    }
    await delay(Math.min(2000, 100 * 2 ** Math.min(attempt++, 5)));
  }
}

/** Resume observation once when the active profile opens, including crash recovery. */
export async function resumeMediaOperations() {
  const scope = getProfileStorageScope();
  useMediaOperations.setState({items: {}});
  try {
    const response = await fetch(`${API_BASE}/gallery/operations`, {cache: "no-store"});
    if (!response.ok || scope !== getProfileStorageScope()) return;
    const operations: MediaOperation[] = await response.json();
    for (const operation of operations) void observe(operation, scope);
  } catch { /* Durable work continues on the server; reconnect will observe it. */ }
}
