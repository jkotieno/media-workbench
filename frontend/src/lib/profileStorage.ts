import { API_BASE, fetchJson } from "@/shared/api/client";

import type { components } from "@/shared/api/generated/openapi.generated";

type Snapshot = components["schemas"]["FrontendStateRead"];
type Changes = Record<string, string | null>;
export const PROFILE_STORAGE_SCOPE_KEY = "sts.profile-preferences.scope";
const SCOPE_KEY = PROFILE_STORAGE_SCOPE_KEY;
let snapshot: Snapshot | null = null;
let pending: Changes = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
const unreliableCacheKeys = new Set<string>();
const endpoint = () => `${API_BASE}/settings/frontend-state`;
const outboxKey = (scope: string) => `sts.profile-preferences.pending:${scope}`;
const browser = () => localStorage;
const allowed = (key: string) => Boolean(snapshot && (snapshot.keys.includes(key) || snapshot.prefixes.some(prefix => key.startsWith(prefix))));
type Intent = {storageKey: string; key: string; value: string | null; order: number};
function readIntents(scope: string): Intent[] {
  const prefix = outboxKey(scope) + ":";
  const intents: Intent[] = [];
  for (let i = 0; i < browser().length; i++) {
    const storageKey = browser().key(i);
    if (!storageKey?.startsWith(prefix)) continue;
    const intent = JSON.parse(browser().getItem(storageKey) || "null");
    if (intent && allowed(intent.key) && Number.isFinite(intent.order) &&
        (typeof intent.value === "string" || intent.value === null)) {
      intents.push({...intent, storageKey});
    }
  }
  return intents.sort((a, b) => a.order - b.order || a.storageKey.localeCompare(b.storageKey));
}
const intentValues = (intents: Intent[]): Changes => Object.fromEntries(intents.map(({key, value}) => [key, value]));
const readPending = (scope: string): Changes => intentValues(readIntents(scope));
const acknowledge = (intents: Intent[]) => { for (const intent of intents) browser().removeItem(intent.storageKey); };

async function write(values: Changes, bootstrap = false): Promise<Snapshot> {
  return fetchJson<Snapshot>(endpoint(), {
    method: "PUT", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({profile_id: snapshot!.profile_id, values, bootstrap}),
    signal: AbortSignal.timeout(8000),
  });
}

function schedule() {
  if (!snapshot || timer) return;
  timer = setTimeout(() => { timer = null; void flushProfilePreferences(); }, 250);
}

export async function flushProfilePreferences(): Promise<void> {
  if (!snapshot) return;
  if (inFlight) return inFlight;
  pending = readPending(snapshot.profile_id);
  if (timer) { clearTimeout(timer); timer = null; }
  if (!Object.keys(pending).length) {
    // Another tab may have acknowledged the shared outbox since this tab's
    // failed request. Its retry must also settle the local warning.
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("studio:preferences-save", {detail: {saved: true}}));
    return;
  }
  const scope = snapshot.profile_id;
  inFlight = (async () => {
    try {
      await withPreferenceLock(scope, async () => {
        const sent = readIntents(scope);
        if (!sent.length) { pending = {}; return; }
        await write(intentValues(sent));
        acknowledge(sent);
        pending = readPending(scope);
      });
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("studio:preferences-save", {detail: {saved: true}}));
    } catch (error) {
      // The per-profile outbox survives browser/process restarts. Never clear
      // it on a failed write or carry it into another selected profile.
      console.warn("Profile preferences are waiting to save", error);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("studio:preferences-save", {detail: {saved: false}}));
      timer = setTimeout(() => { timer = null; void flushProfilePreferences(); }, 3000);
    } finally {
      inFlight = null;
      if (!timer && Object.keys(pending).length) schedule();
    }
  })();
  return inFlight;
}

export async function initializeProfileStorage(): Promise<void> {
  snapshot = await fetchJson<Snapshot>(endpoint(), {signal: AbortSignal.timeout(8000)});
  const previousScope = browser().getItem(SCOPE_KEY);
  if (!snapshot.initialized) {
    const legacy: Changes = {};
    // One-time import of this browser's existing settings. A browser already
    // attached to another profile must not seed that profile's state here.
    if (!previousScope || previousScope === snapshot.profile_id) {
      Object.assign(legacy, await legacyPipeState());
      for (let i = 0; i < browser().length; i++) {
        const key = browser().key(i);
        if (key && allowed(key)) legacy[key] = browser().getItem(key);
      }
    }
    snapshot = await write(legacy, true);
  }
  await withPreferenceLock(snapshot.profile_id, async () => {
    pending = readPending(snapshot!.profile_id);
    if (Object.keys(pending).length) {
      const sent = readIntents(snapshot!.profile_id);
      snapshot = await write(intentValues(sent));
      acknowledge(sent);
      pending = readPending(snapshot.profile_id);
    } else {
      snapshot = await fetchJson<Snapshot>(endpoint(), {signal: AbortSignal.timeout(8000)});
    }
  });
  if (previousScope && previousScope !== snapshot.profile_id) {
    for (const key of ["ds_generation_feed", "ds_prompt_library", "ds_prompt_snippets", "ds_recent_images"]) browser().removeItem(key);
  }
  const keys = new Set([...Object.keys(snapshot.values)]);
  for (let i = 0; i < browser().length; i++) {
    const key = browser().key(i);
    if (key && allowed(key)) keys.add(key);
  }
  for (const key of keys) {
    const value = snapshot.values[key];
    if (value === undefined) browser().removeItem(key);
    else browser().setItem(key, value);
  }
  browser().setItem(SCOPE_KEY, snapshot.profile_id);
  unreliableCacheKeys.clear();
  if (Object.keys(pending).length) schedule();
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("studio:profile-storage-ready"));
}

function change(key: string, value: string | null) {
  const previous = allowed(key) && snapshot ? readIntents(snapshot.profile_id) : [];
  const queuedValue = intentValues(previous)[key];
  // Persist middleware also runs for transient store updates. Do not turn an
  // unchanged serialized preference into another profile write / sync intent.
  // A failed cache write stays uncertain even after its intent is acknowledged.
  if (!unreliableCacheKeys.has(key) && browser().getItem(key) === value &&
      (queuedValue === undefined || queuedValue === value)) return;
  if (allowed(key) && snapshot) {
    // Write the durable retry intent before updating the cache.
    const order = previous.reduce((latest, intent) => Math.max(latest, intent.order + 1), Date.now());
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-");
    browser().setItem(`${outboxKey(snapshot.profile_id)}:${id}`, JSON.stringify({key, value, order}));
    // Each intent has its own key: another tab cannot overwrite unrelated edits
    // or have a newer edit removed by an older acknowledgement. Coalesce only
    // the older entries observed before this write, keeping offline growth bounded.
    acknowledge(previous.filter(intent => intent.key === key));
    pending = readPending(snapshot.profile_id);
    schedule();
  }
  try {
    if (value === null) browser().removeItem(key);
    else browser().setItem(key, value);
    unreliableCacheKeys.delete(key);
  } catch (error) {
    unreliableCacheKeys.add(key);
    throw error;
  }
}

// Explicit adapter: auth/credential storage keeps using native browser storage.
export const profileStorage: Storage = {
  get length() { return browser().length; },
  key: index => browser().key(index),
  getItem: key => browser().getItem(key),
  setItem: (key, value) => change(key, value),
  removeItem: key => change(key, null),
  clear: () => { throw new Error("Clear individual profile preferences explicitly."); },
};


export const profilePreferencesReady = () => snapshot !== null;

// Import the old form cache once. Afterwards a different profile can never
// hydrate from the previous profile's unscoped IndexedDB records.
async function legacyPipeState(): Promise<Changes> {
  if (typeof indexedDB === "undefined") return {};
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("sts_persist");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close the older Studio tab to import its preferences."));
    request.onsuccess = () => {
      const db = request.result;
      const names = ["pipe_params", "prompt_rehydration"].filter(name => db.objectStoreNames.contains(name));
      if (!names.length) { db.close(); resolve({}); return; }
      const values: Changes = {};
      const transaction = db.transaction(names, "readonly");
      for (const name of names) {
        const read = transaction.objectStore(name).getAll();
        read.onsuccess = () => {
          for (const record of read.result) {
            if (typeof record.key === "string" && allowed(record.key) &&
                (!record.expiresAt || record.expiresAt > Date.now())) {
              values[record.key] = JSON.stringify(record.value);
            }
          }
        };
      }
      transaction.oncomplete = () => { db.close(); resolve(values); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}


async function withPreferenceLock<T>(scope: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("studio:profile-preferences:" + scope, action);
  }
  return action();
}


export async function persistPreferencesBeforeProfileOperation(): Promise<void> {
  if (!snapshot) return;
  await flushProfilePreferences();
  if (Object.keys(readPending(snapshot.profile_id)).length) {
    throw new Error("Preferences are still waiting to save to your profile. Retry when the profile is available.");
  }
}

export const getProfileStorageScope = (): string | null => snapshot?.profile_id ?? null;
