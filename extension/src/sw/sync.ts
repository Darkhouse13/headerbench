/**
 * Pro sync: mirrors profiles and variables to `chrome.storage.sync` (Chrome's own sync, no server
 * of ours). The JSON is split into chunks under 8 KB per item and 100 KB in total. Local storage
 * stays the source of truth; when the data does not fit, sync pauses and says why.
 *
 * Devices never replace each other's data wholesale. Every push and every remote change runs
 * `mergeRemote`: profiles are merged one by one (the newer `updatedAt` wins), deletions travel as
 * tombstones, variables move as one list stamped with `variablesUpdatedAt`, and the profile order
 * (rule priority) comes from the side that reordered last (`orderUpdatedAt`).
 */
import type { Profile, State, Variable } from '@headerbench/core';
import { tryMigrate } from '@headerbench/core';

export const SYNC_KEYS = { meta: 'hb.meta', chunkPrefix: 'hb.' } as const;

export const SYNC_LIMITS = {
  /** chrome.storage.sync.QUOTA_BYTES */
  totalBytes: 102_400,
  /** chrome.storage.sync.QUOTA_BYTES_PER_ITEM, with room for the key. */
  itemBytes: 8_192 - 64,
} as const;

/** Tombstones older than this are forgotten. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stays at 1 so Headerbench 1.0.2 and older keep reading the mirror (they ignore the v2 fields).
 * The payload itself says which version it is.
 */
export interface SyncMeta {
  v: 1;
  device: string;
  writtenAt: number;
  chunks: number;
  bytes: number;
}

/** Profile id → when it was deleted (ms). */
export type Tombstones = Record<string, number>;

export interface SyncPayload {
  profiles: Profile[];
  variables: Variable[];
  /** v2. Empty when decoded from a v1 payload. */
  deleted: Tombstones;
  /** v2. When the variable list last changed; 0 when unknown (v1 payloads, old installs). */
  variablesUpdatedAt: number;
  /** v2. When profiles were last reordered; 0 when unknown (v1 payloads, old installs). */
  orderUpdatedAt: number;
}

/** What this device remembers between merges (storage.local, outside State). */
export interface LocalSyncMeta {
  tombstones: Tombstones;
  variablesUpdatedAt: number;
  orderUpdatedAt: number;
}

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

function chunkKey(index: number): string {
  return `${SYNC_KEYS.chunkPrefix}${index}`;
}

/** Splits `text` so each chunk's JSON encoding fits in `limit` bytes. Never splits a surrogate pair. */
export function splitChunks(text: string, limit: number = SYNC_LIMITS.itemBytes): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let size = Math.min(text.length - start, limit);
    let slice = text.slice(start, start + size);
    while (byteLength(slice) > limit) {
      size = Math.max(1, Math.floor(size * 0.9));
      slice = text.slice(start, start + size);
    }
    const last = slice.charCodeAt(slice.length - 1);
    if (slice.length > 1 && last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1);
    chunks.push(slice);
    start += slice.length;
  }
  return chunks;
}

const chunkBytes = (chunks: readonly string[]): number =>
  chunks.reduce((n, chunk, i) => n + chunkKey(i).length + byteLength(chunk), 0);

export type Encoded =
  { ok: true; items: Record<string, unknown>; meta: SyncMeta } | { ok: false; bytes: number };

export function encodePayload(payload: SyncPayload, device: string, now: number): Encoded {
  const chunks = splitChunks(JSON.stringify({ v: 2, ...payload }));
  const items: Record<string, unknown> = {};
  chunks.forEach((chunk, i) => (items[chunkKey(i)] = chunk));
  const bytes = chunkBytes(chunks);
  const meta: SyncMeta = { v: 1, device, writtenAt: now, chunks: chunks.length, bytes };
  if (bytes + 256 > SYNC_LIMITS.totalBytes) return { ok: false, bytes };
  items[SYNC_KEYS.meta] = meta;
  return { ok: true, items, meta };
}

function isMeta(value: unknown): value is SyncMeta {
  const m = value as SyncMeta | undefined;
  return (
    typeof m === 'object' &&
    m !== null &&
    m.v === 1 &&
    typeof m.device === 'string' &&
    Number.isInteger(m.chunks) &&
    typeof m.writtenAt === 'number'
  );
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readTombstones(raw: unknown): Tombstones {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => entry[0] !== '' && isTime(entry[1]),
    ),
  );
}

/**
 * Reassembles and sanitises a mirrored payload. Returns null when absent or unreadable, including
 * a half-arrived write (chunks that do not add up to the size the meta announces).
 */
export function decodePayload(
  items: Record<string, unknown>,
  now: number,
): { meta: SyncMeta; payload: SyncPayload } | null {
  const meta = items[SYNC_KEYS.meta];
  if (!isMeta(meta)) return null;
  const chunks: string[] = [];
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = items[chunkKey(i)];
    if (typeof chunk !== 'string') return null;
    chunks.push(chunk);
  }
  if (chunkBytes(chunks) !== meta.bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunks.join(''));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const migrated = tryMigrate(
    { schemaVersion: 1, profiles: raw.profiles, settings: { variables: raw.variables } },
    now,
  );
  if (!migrated.ok) return null;
  return {
    meta,
    payload: {
      profiles: migrated.state.profiles,
      variables: migrated.state.settings.variables,
      deleted: readTombstones(raw.deleted),
      variablesUpdatedAt: isTime(raw.variablesUpdatedAt) ? raw.variablesUpdatedAt : 0,
      orderUpdatedAt: isTime(raw.orderUpdatedAt) ? raw.orderUpdatedAt : 0,
    },
  };
}

/** Keys of chunks left over from a larger earlier write. */
export function staleChunkKeys(previous: SyncMeta | null, current: SyncMeta): string[] {
  const keys: string[] = [];
  for (let i = current.chunks; i < (previous?.chunks ?? 0); i++) keys.push(chunkKey(i));
  return keys;
}

/** Keeps the newest deletion time per id and forgets tombstones older than the TTL. */
export function mergeTombstones(a: Tombstones, b: Tombstones, now: number): Tombstones {
  const out: Tombstones = {};
  for (const [id, at] of [...Object.entries(a), ...Object.entries(b)]) {
    if (now - at > TOMBSTONE_TTL_MS) continue;
    out[id] = Math.max(out[id] ?? at, at);
  }
  return out;
}

function without(tombstones: Tombstones, ids: ReadonlySet<string>): Tombstones {
  return Object.fromEntries(Object.entries(tombstones).filter(([id]) => !ids.has(id)));
}

/** True when profiles that exist before and after a save changed their relative order. */
function reordered(prev: State, next: State): boolean {
  const after = new Set(next.profiles.map((p) => p.id));
  const before = new Set(prev.profiles.map((p) => p.id));
  const kept = prev.profiles.map((p) => p.id).filter((id) => after.has(id));
  const now = next.profiles.map((p) => p.id).filter((id) => before.has(id));
  return kept.some((id, i) => now[i] !== id);
}

/**
 * Local bookkeeping after a save: tombstones for deleted profiles (none for profiles present),
 * and the time of a variable change or a reorder. Adding or deleting a profile is not a reorder.
 */
export function recordLocalChanges(
  prev: State,
  next: State,
  meta: LocalSyncMeta,
  now: number,
): LocalSyncMeta {
  const present = new Set(next.profiles.map((p) => p.id));
  const removed: Tombstones = {};
  for (const p of prev.profiles) if (!present.has(p.id)) removed[p.id] = now;
  const tombstones = without(mergeTombstones(meta.tombstones, removed, now), present);
  const variablesChanged =
    JSON.stringify(prev.settings.variables) !== JSON.stringify(next.settings.variables);
  return {
    tombstones,
    variablesUpdatedAt: variablesChanged ? now : meta.variablesUpdatedAt,
    orderUpdatedAt: reordered(prev, next) ? now : meta.orderUpdatedAt,
  };
}

/**
 * A profile that comes back after being deleted here (undo, re-import of an old export) must beat
 * its own tombstone on every device, so its `updatedAt` moves past the deletion time.
 */
export function reviveProfiles(
  prev: State,
  next: State,
  tombstones: Tombstones,
  now: number,
): State {
  const before = new Set(prev.profiles.map((p) => p.id));
  let changed = false;
  const profiles = next.profiles.map((p) => {
    const deletedAt = tombstones[p.id];
    if (before.has(p.id) || deletedAt === undefined || p.updatedAt > deletedAt) return p;
    changed = true;
    return { ...p, updatedAt: Math.max(now, deletedAt + 1) };
  });
  return changed ? { ...next, profiles } : next;
}

/** Deterministic pick between two copies of a profile, so every device settles on the same one. */
function newer(a: Profile, b: Profile): Profile {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/**
 * The ids of `primary` in its order, with ids only in `secondary` inserted after the closest
 * id that precedes them in `secondary`, so a profile keeps its place in the priority list.
 */
function orderedIds(primary: readonly string[], secondary: readonly string[]): string[] {
  const out = [...primary];
  const placed = new Set(primary);
  let anchor = -1;
  for (const id of secondary) {
    if (placed.has(id)) {
      anchor = out.indexOf(id);
      continue;
    }
    out.splice(anchor + 1, 0, id);
    placed.add(id);
    anchor += 1;
  }
  return out;
}

function mergeVariables(
  local: Variable[],
  localAt: number,
  remote: Variable[],
  remoteAt: number,
): Variable[] {
  if (localAt > remoteAt) return local;
  if (remoteAt > localAt) return uniqueBy(remote, (v) => v.id);
  // Same stamp (typically 0 on both sides right after updating from 1.0.2): keep every name.
  // On a clash (same id or same name) the choice must be the same on both devices, or they would
  // keep overwriting each other.
  return uniqueBy(
    uniqueBy([...local, ...remote], (v) => v.id),
    (v) => v.name,
  );
}

function uniqueBy(list: Variable[], key: (v: Variable) => string): Variable[] {
  const out = new Map<string, Variable>();
  for (const v of list) {
    const seen = out.get(key(v));
    if (!seen || JSON.stringify(v) > JSON.stringify(seen)) out.set(key(v), v);
  }
  return [...out.values()];
}

export interface MergeResult {
  state: State;
  meta: LocalSyncMeta;
  /** What this device should mirror after the merge. */
  payload: SyncPayload;
}

/**
 * Merges a remote payload into local state.
 * - Profiles: union by id; for an id on both sides the newer `updatedAt` wins. A tombstone (from
 *   either side) deletes a profile only when it is newer than that profile's `updatedAt`.
 * - Variables: the whole list from the side with the newer `variablesUpdatedAt` (union on a tie).
 * - Order: from the side with the newer `orderUpdatedAt`, so a reorder survives an unrelated edit
 *   made elsewhere before it arrived. On a tie, `order: 'remote'` keeps the remote order (a change
 *   arrived from another device) and `'local'` this device's (it is pushing). Profiles only on
 *   the other side keep their place next to the profile they followed there.
 * Activations stay local; the store drops those whose profile is gone.
 */
export function mergeRemote(
  local: State,
  localMeta: LocalSyncMeta,
  remote: SyncPayload | null,
  options: { order: 'local' | 'remote'; now: number },
): MergeResult {
  const remoteSide: SyncPayload = remote ?? {
    profiles: [],
    variables: [],
    deleted: {},
    variablesUpdatedAt: 0,
    orderUpdatedAt: 0,
  };
  const allTombstones = mergeTombstones(localMeta.tombstones, remoteSide.deleted, options.now);
  const localById = new Map(local.profiles.map((p) => [p.id, p]));
  const remoteById = new Map(remoteSide.profiles.map((p) => [p.id, p]));
  const localIds = local.profiles.map((p) => p.id);
  const remoteIds = remoteSide.profiles.map((p) => p.id);
  const localOrderAt = localMeta.orderUpdatedAt;
  const remoteOrderAt = remoteSide.orderUpdatedAt;
  const remoteOrder =
    remoteOrderAt !== localOrderAt ? remoteOrderAt > localOrderAt : options.order === 'remote';
  const ids = remoteOrder ? orderedIds(remoteIds, localIds) : orderedIds(localIds, remoteIds);

  const profiles: Profile[] = [];
  for (const id of ids) {
    const mine = localById.get(id);
    const theirs = remoteById.get(id);
    const winner = mine && theirs ? newer(mine, theirs) : (mine ?? theirs);
    if (!winner) continue;
    const deletedAt = allTombstones[id];
    if (deletedAt !== undefined && deletedAt > winner.updatedAt) continue;
    profiles.push(winner);
  }
  // A tombstone that a live profile outranks has done its job.
  const tombstones = without(allTombstones, new Set(profiles.map((p) => p.id)));

  const variables = mergeVariables(
    local.settings.variables,
    localMeta.variablesUpdatedAt,
    remoteSide.variables,
    remoteSide.variablesUpdatedAt,
  );
  const variablesUpdatedAt = Math.max(localMeta.variablesUpdatedAt, remoteSide.variablesUpdatedAt);
  const orderUpdatedAt = Math.max(localOrderAt, remoteOrderAt);
  return {
    state: { ...local, profiles, settings: { ...local.settings, variables } },
    meta: { tombstones, variablesUpdatedAt, orderUpdatedAt },
    payload: { profiles, variables, deleted: tombstones, variablesUpdatedAt, orderUpdatedAt },
  };
}

/**
 * Identity of a payload, to tell whether a mirror write would change anything. Profile order
 * counts (it is rule priority); variable and tombstone order do not.
 */
export function payloadFingerprint(payload: SyncPayload): string {
  return JSON.stringify([
    payload.profiles,
    [...payload.variables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    Object.entries(payload.deleted).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    payload.variablesUpdatedAt,
    payload.orderUpdatedAt,
  ]);
}

export function syncTooLargeMessage(bytes: number): string {
  return `Sync is paused: your profiles take ${Math.ceil(bytes / 1024)} KB and Chrome sync allows ${
    SYNC_LIMITS.totalBytes / 1024
  } KB. Everything is still saved on this device.`;
}
