/**
 * Pure activation helpers. A profile is either on everywhere (one activation with `tabId: null`)
 * or on in some tabs (one activation per tab). Activations are kept in profile-list order: the
 * list order is the priority order users see everywhere.
 */
import type { Activation, Profile, State } from '@headerbench/core';
import { activeActivations } from '@headerbench/core';

function withActivations(state: State, activations: Activation[]): State {
  return { ...state, settings: { ...state.settings, activations } };
}

/** Sorts activations to match the order of `state.profiles`. */
export function sortActivations(state: State): State {
  const index = new Map(state.profiles.map((p, i) => [p.id, i]));
  const sorted = [...state.settings.activations].sort(
    (a, b) => (index.get(a.profileId) ?? 0) - (index.get(b.profileId) ?? 0),
  );
  return withActivations(state, sorted);
}

/**
 * Turns a profile on. `tabId: null` makes it global and replaces all of its activations. A tab id
 * adds (or updates) that tab without touching the profile's other tabs; if the profile was global,
 * the tab activation replaces the global one.
 */
export function activate(
  state: State,
  profileId: string,
  tabId: number | null,
  pauseAt: number | null,
): State {
  const kept = state.settings.activations.filter(
    (a) => a.profileId !== profileId || (tabId !== null && a.tabId !== null && a.tabId !== tabId),
  );
  return sortActivations(withActivations(state, [...kept, { profileId, tabId, pauseAt }]));
}

/** Turns a profile off everywhere, or only in `tabId` when given. */
export function deactivate(state: State, profileId: string, tabId?: number): State {
  return withActivations(
    state,
    state.settings.activations.filter(
      (a) => a.profileId !== profileId || (tabId !== undefined && a.tabId !== tabId),
    ),
  );
}

/** Drops tab-scoped activations: all of them (browser restart) or one tab's (tab closed). */
export function dropTabActivations(state: State, tabId?: number): State {
  return withActivations(
    state,
    state.settings.activations.filter(
      (a) => a.tabId === null || (tabId !== undefined && a.tabId !== tabId),
    ),
  );
}

/** Removes activations whose auto-pause time has passed. */
export function dropExpired(state: State, now: number): State {
  return withActivations(
    state,
    state.settings.activations.filter((a) => a.pauseAt === null || a.pauseAt > now),
  );
}

/** Earliest future auto-pause time, or null. */
export function nextPauseAt(state: State, now: number): number | null {
  const times = state.settings.activations
    .map((a) => a.pauseAt)
    .filter((t): t is number => t !== null && t > now);
  return times.length > 0 ? Math.min(...times) : null;
}

/** A profile's activations: one global one, or one per tab it is scoped to. */
export function activationsOf(state: State, profileId: string): Activation[] {
  return state.settings.activations.filter((a) => a.profileId === profileId);
}

/** Profiles currently applying rules (not paused, not expired), in priority order. */
export function activeProfiles(state: State, now: number): Profile[] {
  if (state.settings.paused) return [];
  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  const seen = new Set<string>();
  return activeActivations(state, now).flatMap((a) => {
    const profile = byId.get(a.profileId);
    if (!profile || seen.has(profile.id)) return [];
    seen.add(profile.id);
    return [profile];
  });
}

/** Moves a profile one step up or down in the list (and so in priority). */
export function moveProfile(state: State, profileId: string, delta: -1 | 1): State {
  const from = state.profiles.findIndex((p) => p.id === profileId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= state.profiles.length) return state;
  return reorderProfiles(state, from, to);
}

/** Moves the profile at `from` to index `to`, keeping activations in list order. */
export function reorderProfiles(state: State, from: number, to: number): State {
  const profiles = [...state.profiles];
  const [moved] = profiles.splice(from, 1);
  if (!moved) return state;
  profiles.splice(to, 0, moved);
  return sortActivations({ ...state, profiles });
}
