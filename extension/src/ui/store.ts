/**
 * UI state: the latest service-worker snapshot plus local, not-yet-saved edits. Edits apply
 * instantly and are saved after a short pause; requests to the service worker flush them first.
 *
 * Edits are never thrown away: a failed save keeps them (the next edit or flush retries), and a
 * newer snapshot (another window, a `conflict` reply, a request's answer) is merged under them
 * with a three-way rebase (`rebase.ts`).
 */
import type { Profile, State } from '@headerbench/core';
import type { RequestOf, RequestType, ResponseMap, Snapshot } from '../messages';
import type { Platform } from './platform';
import { rebase } from './rebase';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: ToastAction;
}

/** How long a toast stays, unless it carries an action (`UNDO_MS`). */
const TOAST_MS = { info: 4000, error: 8000 } as const;
/** Undo toasts stay this long. */
export const UNDO_MS = 8000;
/** A save is retried at most this many times in a row after `conflict` replies. */
const MAX_CONFLICT_RETRIES = 3;

function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === 'object' && value !== null && 'rev' in value && 'state' in value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Store {
  snapshot: Snapshot | null = null;
  loadError: string | null = null;
  toasts: Toast[] = [];
  /** Unsaved edits, or null. */
  private local: State | null = null;
  /** The snapshot state `local` was edited from. Set whenever `local` is. */
  private base: State | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<boolean> | null = null;
  /** A refresh arrived while a save was in flight; run it once the save settles. */
  private refreshQueued = false;
  private listeners = new Set<() => void>();
  private toastId = 0;
  /** Increases on every change, so late subscribers can tell they missed one. */
  version = 0;

  constructor(
    readonly platform: Platform,
    private readonly saveDelayMs = 300,
  ) {}

  get state(): State {
    const state = this.local ?? this.snapshot?.state;
    if (!state) throw new Error('Store used before it loaded');
    return state;
  }

  /** True while edits are waiting to be saved (or failed to save). */
  get dirty(): boolean {
    return this.local !== null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  async init(): Promise<void> {
    try {
      this.snapshot = await this.send({ type: 'getState' });
    } catch (error) {
      this.loadError = message(error);
    }
    this.platform.onStateChange(() => void this.refresh());
    this.emit();
  }

  /**
   * Re-reads the snapshot after another page or the service worker changed something. Pending
   * edits are rebased onto it; during a save it waits for the save to settle.
   */
  async refresh(): Promise<void> {
    if (this.saving !== null) {
      this.refreshQueued = true;
      return;
    }
    try {
      const snapshot = await this.send({ type: 'getState' });
      if (this.saving !== null) {
        this.refreshQueued = true;
        return;
      }
      if (this.snapshot === null || snapshot.rev >= this.snapshot.rev) this.adopt(snapshot);
    } catch {
      // A failed background refresh keeps the last snapshot; the next change retries.
    }
  }

  /** Makes `snapshot` current, rebasing pending edits onto it. */
  private adopt(snapshot: Snapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (this.local !== null && this.base !== null) {
      const { state, clashes, kept } = rebase(this.base, this.local, snapshot.state);
      this.local = state;
      this.base = snapshot.state;
      if (previous !== null && previous.rev !== snapshot.rev) {
        if (clashes.length > 0) this.notifyClash(clashes);
        if (kept.length > 0) this.notifyKept(kept);
      }
    }
    this.emit();
  }

  private notifyClash(clashes: string[]): void {
    const names = clashes.filter((c) => c !== 'settings');
    const what =
      names.length === 0
        ? 'settings'
        : names.length === 1
          ? (names[0] as string)
          : `${names.length} profiles`;
    this.notify(`Another window changed ${what} at the same time. Your edits were kept.`);
  }

  /** Profiles deleted here that another window edited meanwhile, so the deletion was undone. */
  private notifyKept(names: string[]): void {
    const what = names.length === 1 ? (names[0] as string) : `${names.length} profiles`;
    this.notify(
      `Another window changed ${what}, so ${names.length === 1 ? 'it was' : 'they were'} kept.`,
    );
  }

  async send<T extends RequestType>(req: RequestOf<T>): Promise<ResponseMap[T]> {
    const reply = await this.platform.send(req);
    if (!reply) throw new ApiError('internal', 'Headerbench did not answer. Reload this page.');
    if (!reply.ok) {
      if (reply.snapshot) this.adopt(reply.snapshot);
      throw new ApiError(reply.code, reply.error);
    }
    return reply.data;
  }

  /** Sends a request after saving pending edits, and adopts any snapshot in the answer. */
  async call<T extends RequestType>(req: RequestOf<T>): Promise<ResponseMap[T]> {
    await this.flush();
    const data = await this.send(req);
    const snapshot = isSnapshot(data)
      ? data
      : (data as { snapshot?: Snapshot | null } | null)?.snapshot;
    // Edits whose save just failed stay pending on top of it; the next edit or flush retries.
    if (isSnapshot(snapshot)) this.adopt(snapshot);
    return data;
  }

  /** `call`, showing a failure as an error toast. Resolves to undefined on failure. */
  async run<T extends RequestType>(req: RequestOf<T>): Promise<ResponseMap[T] | undefined> {
    try {
      return await this.call(req);
    } catch (error) {
      this.notify(message(error), 'error');
      return undefined;
    }
  }

  update(fn: (state: State) => State): void {
    if (this.local === null) this.base = this.snapshot?.state ?? null;
    this.local = fn(this.state);
    this.emit();
    this.schedule();
  }

  updateProfile(profileId: string, fn: (profile: Profile) => Profile): void {
    const now = this.platform.now();
    this.update((s) => ({
      ...s,
      profiles: s.profiles.map((p) => (p.id === profileId ? { ...fn(p), updatedAt: now } : p)),
    }));
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.saveDelayMs);
  }

  /**
   * Saves pending edits now. Resolves to false when a save failed; the edits are kept and the
   * failure was shown as a toast.
   */
  async flush(): Promise<boolean> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.saving !== null || this.local !== null) {
      this.saving ??= this.saveOnce();
      const ok = await this.saving;
      if (!ok) return false;
    }
    return true;
  }

  /** One save of the current edits, retrying after conflicts. True when they were saved. */
  private async saveOnce(): Promise<boolean> {
    try {
      for (let attempt = 0; this.local !== null && this.snapshot !== null; attempt++) {
        const sending = this.local;
        try {
          const snapshot = await this.send({
            type: 'saveState',
            state: sending,
            rev: this.snapshot.rev,
          });
          this.snapshot = snapshot;
          if (this.local === sending) {
            this.local = null;
            this.base = null;
          } else {
            // Edits made during the save: keep them on top of what was saved.
            this.local = rebase(sending, this.local, snapshot.state).state;
            this.base = snapshot.state;
          }
          return true;
        } catch (error) {
          // `send` already rebased the edits onto the conflict reply's snapshot.
          if (error instanceof ApiError && error.code === 'conflict') {
            if (attempt < MAX_CONFLICT_RETRIES) continue;
          }
          this.notify(message(error), 'error');
          return false;
        }
      }
      return true;
    } finally {
      this.saving = null;
      this.emit();
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  notify(text: string, tone: Toast['tone'] = 'info', action?: ToastAction): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, message: text, tone, ...(action ? { action } : {}) }];
    this.emit();
    setTimeout(() => this.dismiss(id), action ? UNDO_MS : TOAST_MS[tone]);
  }

  dismiss(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }
}
