/**
 * Persistent state in `chrome.storage.local`. Every save writes the previous good state to
 * `state.backup` in the same call, unless either is over 4 MB (Chrome gives the extension 10 MB in
 * all). Loading a current-schema blob that fails strict validation first repairs it in place;
 * only when that would lose profiles does it fall back to the backup. Either way the raw blob is
 * set aside under `state.corrupt` so the user can download it.
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

export type Recovery = 'none' | 'migrated' | 'repaired' | 'backup' | 'fresh';

/** Above this size (bytes of JSON) a state is not copied to `state.backup`. */
export const BACKUP_MAX_BYTES = 4 * 1024 * 1024;

export const STORAGE_FULL_MESSAGE =
  "Headerbench's storage is full (Chrome allows 10 MB). Remove large mocks or profiles.";

export class StateError extends Error {
  override readonly name = 'StateError';
  constructor(
    message: string,
    /** `storage_full` when Chrome refused the write for lack of space. */
    readonly reason: 'invalid' | 'storage_full' = 'invalid',
  ) {
    super(message);
  }
}

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export class StateStore {
  private cache: Loaded | null = null;
  private warnedBackupSize = false;
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
    // Unreadable, damaged or from a newer Headerbench: keep the blob for the user first.
    await this.setAside(raw);
    if (migrated.ok && repairKeepsProfiles(raw, migrated.state)) {
      this.recovery = 'repaired';
      return this.write(migrated.state, rev + 1, null);
    }
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
    const keepBackup = backup !== null && backup !== undefined && this.backupFits(state, backup);
    if (backup !== null && backup !== undefined && !keepBackup) {
      // An older backup would only eat the space the new state needs.
      await this.area.remove(KEYS.backup);
    }
    try {
      await this.area.set({
        [KEYS.state]: state,
        [KEYS.rev]: next.rev,
        ...(keepBackup ? { [KEYS.backup]: backup } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/quota/i.test(message)) throw new StateError(STORAGE_FULL_MESSAGE, 'storage_full');
      throw error;
    }
    return this.remember(next);
  }

  /** Stores `raw` under `state.corrupt`, dropping the backup (already read) if space is short. */
  private async setAside(raw: unknown): Promise<void> {
    try {
      await this.area.set({ [KEYS.corrupt]: raw });
    } catch {
      await this.area.remove(KEYS.backup);
      await this.area.set({ [KEYS.corrupt]: raw });
    }
  }

  private backupFits(state: State, backup: unknown): boolean {
    if (jsonBytes(state) <= BACKUP_MAX_BYTES && jsonBytes(backup) <= BACKUP_MAX_BYTES) return true;
    if (!this.warnedBackupSize) {
      this.warnedBackupSize = true;
      // eslint-disable-next-line no-console
      console.warn('Headerbench: state is over 4 MB, so no backup copy is kept.');
    }
    return false;
  }

  private remember(loaded: Loaded): Loaded {
    this.cache = loaded;
    return loaded;
  }
}

/** A repair is good enough when every stored profile survived it. */
function repairKeepsProfiles(raw: unknown, repaired: State): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const profiles = (raw as { profiles?: unknown }).profiles;
  return Array.isArray(profiles) && profiles.length === repaired.profiles.length;
}

function isRecordWithOlderSchema(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof version !== 'number' || version < SCHEMA_VERSION;
}
