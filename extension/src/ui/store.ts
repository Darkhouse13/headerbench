/**
 * UI state: the latest service-worker snapshot plus local, not-yet-saved edits. Edits apply
 * instantly and are saved after a short pause; requests to the service worker flush them first.
 */
import type { Profile, State } from '@headerbench/core';
import type { RequestOf, RequestType, ResponseMap, Snapshot } from '../messages';
import type { Platform } from './platform';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

function isSnapshot(value: unknown): value is Snapshot {
  return typeof value === 'object' && value !== null && 'rev' in value && 'state' in value;
}

export class Store {
  snapshot: Snapshot | null = null;
  loadError: string | null = null;
  toasts: Toast[] = [];
  private local: State | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
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
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    this.platform.onStateChange(() => void this.refresh());
    this.emit();
  }

  /** Re-reads the snapshot after another page or the service worker changed something. */
  async refresh(): Promise<void> {
    if (this.local !== null || this.saving !== null) return;
    try {
      const snapshot = await this.send({ type: 'getState' });
      if (this.local === null && this.saving === null) {
        this.snapshot = snapshot;
        this.emit();
      }
    } catch {
      // A failed background refresh keeps the last snapshot; the next change retries.
    }
  }

  async send<T extends RequestType>(req: RequestOf<T>): Promise<ResponseMap[T]> {
    const reply = await this.platform.send(req);
    if (!reply) throw new ApiError('internal', 'Headerbench did not answer. Reload this page.');
    if (!reply.ok) {
      if (reply.snapshot) {
        this.snapshot = reply.snapshot;
        this.local = null;
        this.emit();
      }
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
    if (isSnapshot(snapshot)) {
      this.snapshot = snapshot;
      this.emit();
    }
    return data;
  }

  update(fn: (state: State) => State): void {
    this.local = fn(this.state);
    this.emit();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.saveDelayMs);
  }

  updateProfile(profileId: string, fn: (profile: Profile) => Profile): void {
    const now = this.platform.now();
    this.update((s) => ({
      ...s,
      profiles: s.profiles.map((p) => (p.id === profileId ? { ...fn(p), updatedAt: now } : p)),
    }));
  }

  /** Saves pending edits now. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.saving !== null || this.local !== null) {
      if (this.saving === null) this.saving = this.saveOnce();
      await this.saving;
    }
  }

  private async save(): Promise<void> {
    if (this.saving === null && this.local !== null) {
      this.saving = this.saveOnce();
      await this.saving;
      if (this.local !== null && this.timer === null) void this.save();
    }
  }

  private async saveOnce(): Promise<void> {
    const sending = this.local;
    const rev = this.snapshot?.rev;
    try {
      if (sending === null || rev === undefined) return;
      const snapshot = await this.send({ type: 'saveState', state: sending, rev });
      this.snapshot = snapshot;
      if (this.local === sending) this.local = null;
    } catch (error) {
      this.local = null;
      this.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      this.saving = null;
      this.emit();
    }
  }

  notify(message: string, tone: Toast['tone'] = 'info'): void {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, message, tone }];
    this.emit();
    setTimeout(
      () => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
        this.emit();
      },
      tone === 'error' ? 8000 : 4000,
    );
  }
}
