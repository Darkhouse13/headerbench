/**
 * Pro sync: mirrors profiles and variables to `chrome.storage.sync` (Chrome's own sync, no server
 * of ours). The JSON is split into chunks under 8 KB per item and 100 KB in total. Local storage
 * stays the source of truth; when the data does not fit, sync pauses and says why.
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

export interface SyncMeta {
  v: 1;
  device: string;
  writtenAt: number;
  chunks: number;
  bytes: number;
}

export interface SyncPayload {
  profiles: Profile[];
  variables: Variable[];
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

export type Encoded =
  { ok: true; items: Record<string, unknown>; meta: SyncMeta } | { ok: false; bytes: number };

export function encodePayload(payload: SyncPayload, device: string, now: number): Encoded {
  const chunks = splitChunks(JSON.stringify(payload));
  const items: Record<string, unknown> = {};
  chunks.forEach((chunk, i) => (items[chunkKey(i)] = chunk));
  const bytes = Object.entries(items).reduce((n, [k, v]) => n + k.length + byteLength(v), 0);
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

/** Reassembles and sanitises a mirrored payload. Returns null when absent or unreadable. */
export function decodePayload(
  items: Record<string, unknown>,
  now: number,
): { meta: SyncMeta; payload: SyncPayload } | null {
  const meta = items[SYNC_KEYS.meta];
  if (!isMeta(meta)) return null;
  let text = '';
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = items[chunkKey(i)];
    if (typeof chunk !== 'string') return null;
    text += chunk;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = parsed as Partial<SyncPayload>;
  const migrated = tryMigrate(
    { schemaVersion: 1, profiles: raw.profiles, settings: { variables: raw.variables } },
    now,
  );
  if (!migrated.ok) return null;
  return {
    meta,
    payload: { profiles: migrated.state.profiles, variables: migrated.state.settings.variables },
  };
}

/** Keys of chunks left over from a larger earlier write. */
export function staleChunkKeys(previous: SyncMeta | null, current: SyncMeta): string[] {
  const keys: string[] = [];
  for (let i = current.chunks; i < (previous?.chunks ?? 0); i++) keys.push(chunkKey(i));
  return keys;
}

/** Applies a remote payload: remote profiles and variables win; activations of gone profiles drop. */
export function applyRemote(state: State, payload: SyncPayload): State {
  const ids = new Set(payload.profiles.map((p) => p.id));
  return {
    ...state,
    profiles: payload.profiles,
    settings: {
      ...state.settings,
      variables: payload.variables,
      activations: state.settings.activations.filter((a) => ids.has(a.profileId)),
    },
  };
}

/**
 * Merges when sync is first turned on: profiles from both sides are kept, and for a profile on
 * both sides the most recently updated copy wins. Local variables win on a name clash.
 */
export function mergeOnEnable(state: State, payload: SyncPayload): State {
  const local = new Map(state.profiles.map((p) => [p.id, p]));
  const profiles = state.profiles.map((p) => {
    const remote = payload.profiles.find((r) => r.id === p.id);
    return remote && remote.updatedAt > p.updatedAt ? remote : p;
  });
  for (const remote of payload.profiles) if (!local.has(remote.id)) profiles.push(remote);
  const names = new Set(state.settings.variables.map((v) => v.name));
  const variables = [
    ...state.settings.variables,
    ...payload.variables.filter((v) => !names.has(v.name)),
  ];
  return { ...state, profiles, settings: { ...state.settings, variables } };
}

export function syncTooLargeMessage(bytes: number): string {
  return `Sync is paused: your profiles take ${Math.ceil(bytes / 1024)} KB and Chrome sync allows ${
    SYNC_LIMITS.totalBytes / 1024
  } KB. Everything is still saved on this device.`;
}
