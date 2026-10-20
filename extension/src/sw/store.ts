/**
 * Persistent state in `chrome.storage.local`. Every save writes the previous good state to
 * `state.backup` in the same call. Loading falls back to the backup when `state` is unreadable,
 * and sets the raw blob aside under `state.corrupt` so the user can download it.
 */
import type { State } from '@headerbench/core';
import { SCHEMA_VERSION, defaultState, tryMigrate } from '@headerbench/core';
import { isValidState, normalizeState, stateProblem } from './validate-state';

export const KEYS = {
  state: 'state',
  backup: 'state.backup',
  corrupt: 'state.corrupt',
  rev: 'rev',
} as const;

export interface Loaded {
  state: State;
  rev: number;
}

export type Recovery = 'none' | 'migrated' | 'backup' | 'fresh';

export class StateError extends Error {
  override readonly name = 'StateError';
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export class StateStore {
  private cache: Loaded | null = null;
  /** How the last load from storage went; for diagnostics and tests. */
  recovery: Recovery = 'none';

  constructor(
    private readonly area: Area,
    private readonly now: () => number,
  ) {}

  async load(): Promise<Loaded> {
    if (this.cache) return this.cache;
    const stored = await this.area.get([KEYS.state, KEYS.backup, KEYS.rev]);
    const raw: unknown = stored[KEYS.state];
    const rev = typeof stored[KEYS.rev] === 'number' ? (stored[KEYS.rev] as number) : 0;

    if (raw === undefined) {
      this.recovery = 'none';
      return this.remember({ state: defaultState(), rev });
    }
    if (isValidState(raw)) {
      this.recovery = 'none';
      return this.remember({ state: normalizeState(raw), rev });
    }
    const migrated = tryMigrate(raw, this.now());
    if (migrated.ok && isRecordWithOlderSchema(raw)) {
      this.recovery = 'migrated';
      return this.write(migrated.state, rev + 1, raw);
    }
    // Unreadable or from a newer Headerbench: keep the blob, recover from the backup if possible.
    await this.area.set({ [KEYS.corrupt]: raw });
    const backup = tryMigrate(stored[KEYS.backup], this.now());
    this.recovery = backup.ok ? 'backup' : 'fresh';
    return this.write(backup.ok ? backup.state : defaultState(), rev + 1, null);
  }

  /**
   * Validates and persists `next`. Throws StateError when it is not a well-formed State.
   * `keepRev` saves without bumping `rev`, for bookkeeping that no open editor can conflict with
   * (`saveState` never takes those fields from the page).
   */
  async save(next: State, options: { keepRev?: boolean } = {}): Promise<Loaded> {
    const problem = stateProblem(next);
    if (problem) throw new StateError(`Not saved: ${problem}.`);
    const current = await this.load();
    const rev = options.keepRev ? current.rev : current.rev + 1;
    return this.write(normalizeState(next), rev, current.state);
  }

  async corruptData(): Promise<unknown> {
    const stored = await this.area.get(KEYS.corrupt);
    return stored[KEYS.corrupt];
  }

  async discardCorruptData(): Promise<void> {
    await this.area.remove(KEYS.corrupt);
  }

  private async write(state: State, rev: number, backup: unknown): Promise<Loaded> {
    const next = { state, rev };
    await this.area.set({
      [KEYS.state]: state,
      [KEYS.rev]: next.rev,
      ...(backup !== null && backup !== undefined ? { [KEYS.backup]: backup } : {}),
    });
    return this.remember(next);
  }

  private remember(loaded: Loaded): Loaded {
    this.cache = loaded;
    return loaded;
  }
}

function isRecordWithOlderSchema(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof version !== 'number' || version < SCHEMA_VERSION;
}
