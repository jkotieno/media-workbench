import {create} from "zustand";
import {getProfileStorageScope} from "./profileStorage";

type MediaIdentity = {id: number; continuity_media_uuid?: string | null; created_at?: string};
type Revision = {revision: number; deleted: boolean};
export type PendingMediaDelete = {scope: string | null | undefined; mediaUuid?: string | null};
let scope: string | null | undefined;
const images = new Map<string, Revision>();
const identities = new Map<number, {uuid: string; createdAt?: number}>();
const retired = new Set<string>();
export const useMediaRevision = create(() => ({revision: 0, ids: [] as number[]}));
const key = (id: number, uuid?: string | null) => `${id}:${uuid || "legacy"}`;
function current() {
  const selected = getProfileStorageScope();
  if (scope !== selected) {images.clear(); identities.clear(); retired.clear(); scope = selected;}
}
function timestamp(value: string | undefined) {
  if (!value) return undefined;
  const utc = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  const millis = Date.parse(utc);
  if (!Number.isFinite(millis)) return undefined;
  const fraction = value.match(/\.(\d+)/)?.[1] ?? "";
  return millis * 1000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}
export function recordMediaMutations(ids: number[], revisions: Record<string, number> | undefined,
  deleted: boolean, requestScope = getProfileStorageScope(), mediaUuids?: Record<string, string | null>) {
  if (requestScope !== getProfileStorageScope()) return;
  current();
  const changed: number[] = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const uuid = mediaUuids?.[String(id)] || undefined;
    const active = identities.get(id);
    // A legacy acknowledgement cannot identify a newer incarnation of its ID.
    if (!uuid && active || retired.has(key(id, uuid))) continue;
    const identity = key(id, uuid);
    const previous = images.get(identity);
    const revision = revisions?.[String(id)] ?? (previous?.revision ?? 0) + 1;
    if (previous && revision < previous.revision) continue;
    images.set(identity, {revision, deleted});
    if (uuid && !active) identities.set(id, {uuid});
    if (!active || !uuid || active.uuid === uuid) changed.push(id);
  }
  if (changed.length) useMediaRevision.setState(state => ({revision: state.revision + 1, ids: changed}));
}
export function mediaIsDeleted(id: number | undefined, uuid?: string | null) {
  current();
  if (id === undefined) return false;
  const identity = key(id, uuid || identities.get(id)?.uuid);
  return retired.has(identity) || images.get(identity)?.deleted === true;
}
export function acceptMediaRevision(image: MediaIdentity & {media_revision?: number; is_deleted?: boolean}) {
  current();
  const uuid = image.continuity_media_uuid || undefined;
  const active = identities.get(image.id);
  const identity = key(image.id, uuid);
  if (retired.has(identity) || !uuid && active) return false;
  const previous = images.get(identity);
  const revision = image.media_revision ?? 0;
  if (previous && (revision < previous.revision || revision === previous.revision && previous.deleted)) return false;
  if (uuid) {
    const createdAt = timestamp(image.created_at);
    if (active && active.uuid !== uuid) {
      if (active.createdAt !== undefined && createdAt !== undefined && createdAt < active.createdAt) {
        retired.add(identity); return false;
      }
      retired.add(key(image.id, active.uuid));
    }
    identities.set(image.id, {uuid, createdAt: createdAt ?? active?.createdAt});
  }
  if (!previous || revision > previous.revision) images.set(identity, {revision, deleted: image.is_deleted === true});
  return image.is_deleted !== true;
}
export function matchesPendingMediaDelete(pending: PendingMediaDelete | undefined, image: MediaIdentity,
  profileScope = getProfileStorageScope()) {
  return Boolean(pending && pending.scope === profileScope &&
    !(pending.mediaUuid && image.continuity_media_uuid && pending.mediaUuid !== image.continuity_media_uuid));
}
