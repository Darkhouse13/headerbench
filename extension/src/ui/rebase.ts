/**
 * Three-way merge of unsaved UI edits onto a newer snapshot (another window saved first, or the
 * service worker changed state while edits were pending).
 *
 * `base` is the state the edits started from, `local` the edited state, `remote` the newer one.
 * Per profile, per settings field and per profile's activations: changed only locally → local;
 * only remotely → remote; on both sides → local wins and the clash is reported. A profile one side
 * deleted while the other edited it is kept with the edit.
 */
import type { Activation, Profile, Settings, State } from '@headerbench/core';

export interface Rebased {
  state: State;
  /** Names of profiles both sides changed differently ("settings" for a settings field). */
  clashes: string[];
  /** Names of profiles deleted here but edited by another window, which were kept. */
  kept: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Picks one side for a value that may be absent (undefined) on any side. */
function pick<T>(base: T | undefined, local: T | undefined, remote: T | undefined) {
  if (same(base, local)) return { value: remote, clash: false };
  if (same(base, remote)) return { value: local, clash: false };
  return { value: local, clash: !same(local, remote) };
}

function byId<T>(list: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(list.map((item) => [key(item), item]));
}

/** Local order when the edits reordered profiles, else remote order; missing ids follow. */
function order(base: string[], local: string[], remote: string[], keep: Set<string>): string[] {
  const relative = (list: string[], ids: Set<string>): string[] => list.filter((id) => ids.has(id));
  const shared = new Set(base.filter((id) => local.includes(id)));
  const reordered = !same(relative(base, shared), relative(local, shared));
  const [first, second] = reordered ? [local, remote] : [remote, local];
  const result = first.filter((id) => keep.has(id));
  for (const id of second) {
    if (keep.has(id) && !result.includes(id)) {
      // Insert after the nearest item that precedes it on its own side and survived, so new
      // profiles stay in place; first on its side stays first, no surviving predecessor appends.
      const index = second.indexOf(id);
      const before = second
        .slice(0, index)
        .reverse()
        .find((other) => result.includes(other));
      const at =
        before !== undefined ? result.indexOf(before) + 1 : index === 0 ? 0 : result.length;
      result.splice(at, 0, id);
    }
  }
  return result;
}

function mergeProfiles(base: State, local: State, remote: State) {
  const b = byId(base.profiles, (p) => p.id);
  const l = byId(local.profiles, (p) => p.id);
  const r = byId(remote.profiles, (p) => p.id);
  const merged = new Map<string, Profile>();
  const clashes: string[] = [];
  const kept: string[] = [];
  for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const remoteEdit = r.get(id);
    if (b.has(id) && !l.has(id) && remoteEdit && !same(b.get(id), remoteEdit)) {
      // Deleted here, edited elsewhere: the edit wins, as a local edit wins over a remote delete.
      merged.set(id, remoteEdit);
      kept.push(remoteEdit.name || 'Untitled profile');
      continue;
    }
    const { value, clash } = pick(b.get(id), l.get(id), remoteEdit);
    if (value) merged.set(id, value);
    if (clash) clashes.push((l.get(id) ?? r.get(id) ?? b.get(id))?.name || 'Untitled profile');
  }
  const ids = order(
    base.profiles.map((p) => p.id),
    local.profiles.map((p) => p.id),
    remote.profiles.map((p) => p.id),
    new Set(merged.keys()),
  );
  return { profiles: ids.map((id) => merged.get(id) as Profile), clashes, kept };
}

function mergeActivations(base: State, local: State, remote: State, profiles: Profile[]) {
  const of = (s: State, id: string): Activation[] =>
    s.settings.activations.filter((a) => a.profileId === id);
  return profiles.flatMap(
    (p) => pick(of(base, p.id), of(local, p.id), of(remote, p.id)).value ?? [],
  );
}

export function rebase(base: State, local: State, remote: State): Rebased {
  const { profiles, clashes, kept } = mergeProfiles(base, local, remote);
  const settings = { ...remote.settings } as Record<string, unknown>;
  let settingsClash = false;
  for (const key of Object.keys(remote.settings) as (keyof Settings)[]) {
    if (key === 'activations') continue;
    const { value, clash } = pick(base.settings[key], local.settings[key], remote.settings[key]);
    settings[key] = value;
    settingsClash ||= clash;
  }
  settings.activations = mergeActivations(base, local, remote, profiles);
  return {
    state: { ...remote, profiles, settings: settings as unknown as Settings },
    clashes: settingsClash ? [...clashes, 'settings'] : clashes,
    kept,
  };
}
