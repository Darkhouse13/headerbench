/**
 * The service worker's logic, built on an injected `chrome` so tests can drive it with a fake.
 * All state changes go through `mutate`, which runs serially: load → change → validate and save
 * (with backup) → recompile and replace DNR rules → badge → wake-up alarm → sync bookkeeping and
 * a debounced sync push. Sync never replaces state wholesale: pushes and remote changes both go
 * through `mergeRemote` (see sync.ts).
 */
import type { ImportReportLine, ProStatus, State, Warning } from '@headerbench/core';
import {
  compile,
  hostAccessFrom,
  importAny,
  needsInitiatorAccess,
  pageOrigin,
  newId,
  proStatus,
  startTrialIfNeeded,
  summarizeImport,
  testUrl,
  verifyLicense,
} from '@headerbench/core';
import {
  activate,
  deactivate,
  dropExpired,
  dropTabActivations,
  nextPauseAt,
  sortActivations,
} from '../activations';
import type {
  ErrorCode,
  ExternalReply,
  LicenseOutcome,
  LicenseRefreshError,
  Reply,
  Request,
  RequestOf,
  RequestType,
  ResponseMap,
  Snapshot,
  TestUrlResult,
} from '../messages';
import { parseExternal, parseRequest } from '../messages';
import { recordActiveDay } from '../review';
import { applyBadge, computeBadge } from './badge';
import { buildDiagnostics } from './diagnostics';
import {
  AUTO_REFRESH_INTERVAL_MS,
  addsProItem,
  checkLicenseReplacement,
  refreshDue,
  requestRefresh,
} from './license';
import { appliedEffects } from './matches';
import { installRules } from './rules';
import type { SplitRule } from './rules';
import type { Loaded } from './store';
import { KEYS, StateError, StateStore } from './store';
import {
  SYNC_KEYS,
  decodePayload,
  encodePayload,
  mergeRemote,
  payloadFingerprint,
  recordLocalChanges,
  reviveProfiles,
  staleChunkKeys,
  syncTooLargeMessage,
} from './sync';
import type { LocalSyncMeta, SyncMeta, SyncPayload, Tombstones } from './sync';
import { stateProblem } from './validate-state';

export interface BackgroundConfig {
  licensePublicKey: string;
  /** Licence ids that no longer turn on Pro (extension/revoked.json). */
  revokedLicenses: readonly string[];
  apiBase: string;
  version: string;
  /** Origins allowed to send `activate-license` (port-agnostic for localhost entries). */
  externalOrigins: readonly string[];
  e2e: boolean;
}

export interface Env {
  chrome: typeof chrome;
  now: () => number;
  fetch: typeof fetch;
  userAgent: string;
  config: BackgroundConfig;
  /** Delay before mirroring a save to chrome.storage.sync. */
  syncDelayMs?: number;
}

/** One alarm covers auto-pause times and Pro trial/licence expiry. */
export const WAKE_ALARM = 'headerbench-wake';
/** Every 6 hours: refreshes a yearly licence in its last 14 days (no request otherwise). */
export const LICENSE_ALARM = 'headerbench-license';
export const LICENSE_ALARM_PERIOD_MINUTES = AUTO_REFRESH_INTERVAL_MS / 60_000;

/** storage.local keys outside State. Pages watch some of them (see extension/README.md). */
export const LOCAL_KEYS = {
  runtime: 'runtime',
  syncStatus: 'syncStatus',
  deviceId: 'deviceId',
  refreshAttempt: 'licenseRefreshAttemptAt',
  /** The last automatic licence refresh failure (`LicenseRefreshError`), cleared on success. */
  refreshError: 'licenseRefreshError',
  /** Profile id → deletion time, for sync (`Tombstones`). */
  tombstones: 'syncTombstones',
  /** When the variable list last changed on this device, for sync. */
  variablesUpdatedAt: 'syncVariablesUpdatedAt',
  /** When profiles were last reordered (here or on a device this one merged with), for sync. */
  orderUpdatedAt: 'syncOrderUpdatedAt',
} as const;

interface RuntimeStatus {
  ruleError: string | null;
  rejected: Warning[];
  /** Header rules installed split by header name, so matched rule ids can be explained. */
  split: SplitRule[];
}

interface StoredSyncStatus {
  error: string | null;
  bytes: number;
  lastSyncedAt: number | null;
}

class HandlerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function reportError(error: unknown): void {
  // Surfaces on chrome://extensions so a user can paste it into a support email.
  // eslint-disable-next-line no-console
  console.error('Headerbench:', error);
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function httpUrl(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const NOT_SHARED =
  'Chrome shares what applied on a tab only when you open Headerbench from the toolbar while that tab is in front.';
const QUOTA =
  'Chrome limits how often Headerbench can ask what applied on a tab (20 times in 10 minutes). Try again in a few minutes.';

export function createBackground(env: Env) {
  const c = env.chrome;
  const cfg = env.config;
  const store = new StateStore(c.storage.local, env.now);
  let queue: Promise<unknown> = Promise.resolve();
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncDone: { promise: Promise<void>; resolve: () => void } | null = null;

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  const licenseKeys = { publicKey: cfg.licensePublicKey, revoked: cfg.revokedLicenses };
  const pro = (state: State): ProStatus =>
    proStatus(state.settings, env.now(), cfg.licensePublicKey, cfg.revokedLicenses);
  const verify = (key: string) =>
    verifyLicense(key, cfg.licensePublicKey, env.now() / 1000, cfg.revokedLicenses);

  /** Checks a key against the stored one (see checkLicenseReplacement). */
  async function replacementCheck(key: string) {
    const { state } = await store.load();
    return checkLicenseReplacement(key, state.settings.licenseKey, licenseKeys, env.now() / 1000);
  }

  // ---------- rules ----------

  async function writeRuntime(next: RuntimeStatus): Promise<void> {
    const stored = await c.storage.local.get(LOCAL_KEYS.runtime);
    if (JSON.stringify(stored[LOCAL_KEYS.runtime] ?? null) !== JSON.stringify(next)) {
      await c.storage.local.set({ [LOCAL_KEYS.runtime]: next });
    }
  }

  async function readRuntime(): Promise<RuntimeStatus> {
    const stored = (await c.storage.local.get(LOCAL_KEYS.runtime))[LOCAL_KEYS.runtime] as
      Partial<RuntimeStatus> | undefined;
    return {
      ruleError: stored?.ruleError ?? null,
      rejected: stored?.rejected ?? [],
      split: stored?.split ?? [],
    };
  }

  async function armWake(state: State, status: ProStatus, now: number): Promise<void> {
    const times = [
      nextPauseAt(state, now),
      status.source === 'trial' ? status.trialEndsAt : null,
      status.source === 'license' ? status.licenseExpiresAt : null,
    ].filter((t): t is number => t !== null && t > now);
    if (times.length > 0) await c.alarms.create(WAKE_ALARM, { when: Math.min(...times) });
    else await c.alarms.clear(WAKE_ALARM);
  }

  async function resyncNow(state: State): Promise<void> {
    const now = env.now();
    const status = pro(state);
    const result = compile(state, { pro: status.pro, now });
    let runtime: RuntimeStatus;
    if (!result.ok) {
      const budget = result.warnings.find((w) => w.code === 'RULE_BUDGET');
      runtime = {
        ruleError: budget?.message ?? 'Rules could not be compiled.',
        rejected: [],
        split: [],
      };
    } else {
      const outcome = await installRules(c.declarativeNetRequest, result);
      runtime = { ruleError: outcome.error, rejected: outcome.rejected, split: outcome.split };
    }
    await writeRuntime(runtime);
    try {
      await applyBadge(c.action, computeBadge(state, now));
    } catch (error) {
      reportError(error);
    }
    await armWake(state, status, now);
  }

  function resync(): Promise<void> {
    return serial(async () => resyncNow((await store.load()).state));
  }

  // ---------- state changes ----------

  type Mutation = (state: State, rev: number) => State | Promise<State>;

  /** `keepRev`: see StateStore.save. */
  function mutate(fn: Mutation, options: { keepRev?: boolean } = {}): Promise<Loaded> {
    return serial(async () => {
      const loaded = await store.load();
      const changed = await fn(loaded.state, loaded.rev);
      if (JSON.stringify(changed) === JSON.stringify(loaded.state)) return loaded;
      const next = await revive(loaded.state, changed);
      const saved = await store.save(next, { keepRev: options.keepRev === true });
      await resyncNow(saved.state);
      await afterSave(loaded.state, saved.state);
      return saved;
    });
  }

  // ---------- sync ----------

  async function deviceId(): Promise<string> {
    const stored = await c.storage.local.get(LOCAL_KEYS.deviceId);
    const existing = stored[LOCAL_KEYS.deviceId];
    if (typeof existing === 'string') return existing;
    const id = newId();
    await c.storage.local.set({ [LOCAL_KEYS.deviceId]: id });
    return id;
  }

  async function writeSyncStatus(patch: Partial<StoredSyncStatus>): Promise<void> {
    const stored = await c.storage.local.get(LOCAL_KEYS.syncStatus);
    const current = (stored[LOCAL_KEYS.syncStatus] as StoredSyncStatus | undefined) ?? {
      error: null,
      bytes: 0,
      lastSyncedAt: null,
    };
    await c.storage.local.set({ [LOCAL_KEYS.syncStatus]: { ...current, ...patch } });
  }

  const syncActive = (state: State): boolean => state.settings.sync && pro(state).pro;

  async function readLocalSync(): Promise<LocalSyncMeta> {
    const stored = await c.storage.local.get([
      LOCAL_KEYS.tombstones,
      LOCAL_KEYS.variablesUpdatedAt,
      LOCAL_KEYS.orderUpdatedAt,
    ]);
    const raw = stored[LOCAL_KEYS.tombstones];
    const tombstones: Tombstones =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(
              (entry): entry is [string, number] => isTime(entry[1]),
            ),
          )
        : {};
    const at = stored[LOCAL_KEYS.variablesUpdatedAt];
    const orderAt = stored[LOCAL_KEYS.orderUpdatedAt];
    return {
      tombstones,
      variablesUpdatedAt: isTime(at) ? at : 0,
      orderUpdatedAt: isTime(orderAt) ? orderAt : 0,
    };
  }

  async function writeLocalSync(before: LocalSyncMeta, after: LocalSyncMeta): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await c.storage.local.set({
      [LOCAL_KEYS.tombstones]: after.tombstones,
      [LOCAL_KEYS.variablesUpdatedAt]: after.variablesUpdatedAt,
      [LOCAL_KEYS.orderUpdatedAt]: after.orderUpdatedAt,
    });
  }

  /** A profile added back after a local delete outranks its tombstone (see reviveProfiles). */
  async function revive(prev: State, next: State): Promise<State> {
    const before = new Set(prev.profiles.map((p) => p.id));
    if (next.profiles.every((p) => before.has(p.id))) return next;
    return reviveProfiles(prev, next, (await readLocalSync()).tombstones, env.now());
  }

  /**
   * Reads the mirror and merges it into local state (run inside `serial`). Saves the merged
   * state when it differs and returns what this device should mirror, and whether the mirror
   * lacks any of it.
   */
  async function mergeWithMirror(
    order: 'local' | 'remote',
  ): Promise<{ payload: SyncPayload; mirrorStale: boolean }> {
    const now = env.now();
    const { state } = await store.load();
    const decoded = decodePayload(await c.storage.sync.get(null), now);
    const localMeta = await readLocalSync();
    const merged = mergeRemote(state, localMeta, decoded?.payload ?? null, { order, now });
    const next = sortActivations(merged.state);
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      const saved = await store.save(next);
      await resyncNow(saved.state);
    }
    await writeLocalSync(localMeta, merged.meta);
    const mirrorStale =
      decoded === null ||
      payloadFingerprint(decoded.payload) !== payloadFingerprint(merged.payload);
    return { payload: merged.payload, mirrorStale };
  }

  /** Merges with the mirror, then writes the merged result to it when that changes anything. */
  async function pushNow(): Promise<void> {
    if (!syncActive((await store.load()).state)) return;
    const now = env.now();
    const { payload, mirrorStale } = await mergeWithMirror('local');
    if (!mirrorStale) {
      await writeSyncStatus({ error: null, lastSyncedAt: now });
      return;
    }
    const encoded = encodePayload(payload, await deviceId(), now);
    if (!encoded.ok) {
      await writeSyncStatus({ error: syncTooLargeMessage(encoded.bytes), bytes: encoded.bytes });
      return;
    }
    try {
      const previous = (await c.storage.sync.get(SYNC_KEYS.meta))[SYNC_KEYS.meta] as
        SyncMeta | undefined;
      await c.storage.sync.set(encoded.items);
      const stale = staleChunkKeys(previous ?? null, encoded.meta);
      if (stale.length > 0) await c.storage.sync.remove(stale);
      await writeSyncStatus({ error: null, bytes: encoded.meta.bytes, lastSyncedAt: now });
    } catch (error) {
      await writeSyncStatus({
        error: `Chrome sync refused the update (${errorText(error)}). Everything is still saved on this device.`,
      });
    }
  }

  function schedulePush(): void {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncDone?.resolve();
    let resolve = (): void => undefined;
    const promise = new Promise<void>((r) => (resolve = r));
    syncDone = { promise, resolve };
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void serial(pushNow).then(resolve, (error: unknown) => {
        reportError(error);
        resolve();
      });
    }, env.syncDelayMs ?? 2000);
  }

  async function afterSave(prev: State, next: State): Promise<void> {
    const before = await readLocalSync();
    await writeLocalSync(before, recordLocalChanges(prev, next, before, env.now()));
    if (!syncActive(next)) return;
    // Sync just became active (toggle, licence, trial): take in what other devices mirrored
    // before this device writes anything.
    if (!syncActive(prev)) await mergeWithMirror('local');
    schedulePush();
  }

  /** Merges what another device mirrored; pushes back only when that device lacks something. */
  async function onSyncChanged(changes: Record<string, chrome.storage.StorageChange>) {
    if (!Object.keys(changes).some((key) => key.startsWith(SYNC_KEYS.chunkPrefix))) return;
    const own = await deviceId();
    const pushBack = await serial(async () => {
      if (!syncActive((await store.load()).state)) return false;
      const meta = (await c.storage.sync.get(SYNC_KEYS.meta))[SYNC_KEYS.meta] as
        SyncMeta | undefined;
      if (!meta || meta.device === own) return false;
      const { mirrorStale } = await mergeWithMirror('remote');
      await writeSyncStatus({ error: null, lastSyncedAt: env.now() });
      return mirrorStale;
    });
    if (pushBack) schedulePush();
  }

  /** On browser start: catch up with what other devices mirrored while this one was closed. */
  async function pullFromMirror(): Promise<void> {
    const pushBack = await serial(async () => {
      if (!syncActive((await store.load()).state)) return false;
      return (await mergeWithMirror('remote')).mirrorStale;
    });
    if (pushBack) schedulePush();
  }

  // ---------- licence refresh ----------

  async function readRefreshError(): Promise<LicenseRefreshError | null> {
    const raw = (await c.storage.local.get(LOCAL_KEYS.refreshError))[LOCAL_KEYS.refreshError] as
      LicenseRefreshError | undefined;
    return raw ?? null;
  }

  async function clearRefreshError(): Promise<void> {
    if (await readRefreshError()) await c.storage.local.remove(LOCAL_KEYS.refreshError);
  }

  /** `keepRev` for saves the user didn't make, so an open editor can still save its own. */
  const setLicense = async (key: string, options: { keepRev?: boolean } = {}): Promise<Loaded> => {
    const saved = await mutate(
      (s) => ({ ...s, settings: { ...s.settings, licenseKey: key } }),
      options,
    );
    await clearRefreshError();
    return saved;
  };

  /** Same licence, plan and expiry: the keys differ at most by when they were signed (`iat`). */
  function sameTerms(a: string, b: string): boolean {
    const x = verify(a);
    const y = verify(b);
    if (!x.ok || !y.ok) return false;
    const p = x.payload;
    const q = y.payload;
    return p.lid === q.lid && p.plan === q.plan && p.exp === q.exp;
  }

  /**
   * The refresh request itself. Throws HandlerError on failure; the stored key is kept.
   * `auto`: a background or editor-mount refresh, which saves without bumping rev.
   */
  async function refreshKey(key: string, auto: boolean): Promise<LicenseOutcome> {
    await c.storage.local.set({ [LOCAL_KEYS.refreshAttempt]: env.now() });
    const result = await requestRefresh(env.fetch, cfg.apiBase, key);
    if (!result.ok) throw new HandlerError(result.code, result.error);
    // Near the period end the server re-signs the same expiry; storing it would change nothing.
    if (sameTerms(result.key, key)) {
      await clearRefreshError();
      return licenseOutcome(key, false);
    }
    const check = await replacementCheck(result.key);
    if (check.ok) {
      await setLicense(result.key, { keepRev: auto });
      return licenseOutcome(result.key, false);
    }
    if (check.shorter) {
      // The server sent a different licence that ends sooner (a same-licence key is accepted
      // above); the stored one stays and the subscription is evidently fine.
      await clearRefreshError();
      return licenseOutcome(key, false);
    }
    throw new HandlerError(
      'license_invalid',
      `The licence server sent a key this version cannot use. ${check.error} Your current licence stays active.`,
    );
  }

  /**
   * Refreshes a yearly licence in its last 14 days, at most every 6 hours. Returns null when
   * nothing was due (no request made). A failure is stored for Settings and rethrown.
   */
  async function autoRefresh(): Promise<LicenseOutcome | null> {
    const key = await serial(async () => {
      const { state } = await store.load();
      const now = env.now();
      const last = (await c.storage.local.get(LOCAL_KEYS.refreshAttempt))[
        LOCAL_KEYS.refreshAttempt
      ];
      const recent = isTime(last) && now - last < AUTO_REFRESH_INTERVAL_MS;
      if (!state.settings.licenseKey || !refreshDue(pro(state), now) || recent) return null;
      // Claimed inside the queue, so concurrent triggers make one request.
      await c.storage.local.set({ [LOCAL_KEYS.refreshAttempt]: now });
      return state.settings.licenseKey;
    });
    if (key === null) return null;
    try {
      return await refreshKey(key, true);
    } catch (error) {
      const stored: LicenseRefreshError = {
        at: env.now(),
        code: error instanceof HandlerError ? error.code : 'internal',
        message: errorText(error),
      };
      await c.storage.local.set({ [LOCAL_KEYS.refreshError]: stored });
      throw error;
    }
  }

  /** Background trigger (alarm, startup, install): failures stay silent, stored for Settings. */
  async function refreshInBackground(): Promise<void> {
    try {
      await autoRefresh();
    } catch (error) {
      if (!(error instanceof HandlerError)) reportError(error);
    }
  }

  // ---------- snapshot ----------

  async function snapshot(): Promise<Snapshot> {
    const { state, rev } = await store.load();
    const now = env.now();
    const status = pro(state);
    const compiled = compile(state, { pro: status.pro, now });
    const stored = await c.storage.local.get([LOCAL_KEYS.syncStatus, KEYS.corrupt]);
    const runtime = await readRuntime();
    const sync = stored[LOCAL_KEYS.syncStatus] as StoredSyncStatus | undefined;
    return {
      rev,
      state,
      pro: status,
      warnings: [...compiled.warnings, ...runtime.rejected],
      stats: compiled.stats,
      ruleError: runtime.ruleError,
      sync: {
        active: state.settings.sync && status.pro,
        error:
          state.settings.sync && !status.pro
            ? 'Sync needs Pro. Your profiles stay saved on this device.'
            : (sync?.error ?? null),
        bytes: sync?.bytes ?? 0,
        lastSyncedAt: sync?.lastSyncedAt ?? null,
      },
      licenseRefreshError: await readRefreshError(),
      hasCorruptData: stored[KEYS.corrupt] !== undefined,
      version: cfg.version,
    };
  }

  // ---------- handlers ----------

  async function testUrlFor(
    state: State,
    url: string,
    req: Omit<RequestOf<'testUrl'>, 'type' | 'url'>,
  ): Promise<TestUrlResult> {
    const parsed = httpUrl(url);
    const page = req.initiator !== undefined ? pageOrigin(req.initiator) : null;
    if (!parsed) {
      return {
        matches: [],
        origin: null,
        hasHostAccess: false,
        pageOrigin: page,
        hasPageAccess: false,
      };
    }
    const granted = hostAccessFrom((await c.permissions.getAll()).origins ?? []);
    const now = env.now();
    const matches = testUrl(
      state,
      { pro: pro(state).pro, now },
      {
        url: parsed.href,
        resourceType: req.resourceType,
        method: req.method,
        hasHostAccess: granted,
        ...(req.tabId !== undefined ? { tabId: req.tabId } : {}),
        ...(page !== null && req.initiator !== undefined ? { initiator: req.initiator } : {}),
      },
    );
    return {
      matches,
      origin: parsed.origin,
      hasHostAccess: granted(parsed.href),
      pageOrigin: page,
      // Chrome applies rules to page loads (main_frame, sub_frame) without initiator access.
      hasPageAccess:
        page === null ||
        !needsInitiatorAccess(req.resourceType) ||
        granted(req.initiator as string),
    };
  }

  async function licenseOutcome(key: string | null, skipped: boolean): Promise<LicenseOutcome> {
    const snap = await snapshot();
    const verified = key ? verify(key) : null;
    const payload = verified?.ok ? verified.payload : null;
    return {
      snapshot: snap,
      plan: payload?.plan ?? null,
      expired: verified?.ok ? verified.expired : false,
      expiresAt: payload?.exp != null ? payload.exp * 1000 : null,
      skipped,
    };
  }

  const handlers: { [K in RequestType]: (req: RequestOf<K>) => Promise<ResponseMap[K]> } = {
    async getState() {
      // Review bookkeeping only: keeps `rev`, so opening a page never makes another one's edit
      // look like a conflict.
      await mutate((s) => recordActiveDay(s, env.now()) ?? s, { keepRev: true });
      return snapshot();
    },

    async saveState(req) {
      const problem = stateProblem(req.state);
      if (problem) throw new HandlerError('invalid_state', `Not saved: ${problem}.`);
      await mutate((prev, rev) => {
        if (req.rev !== rev) {
          throw new HandlerError(
            'conflict',
            'Headerbench was changed in another window, so this edit was not saved. The latest version is shown; please make the change again.',
          );
        }
        // Licence, trial and review fields change only through their own requests.
        let settings = {
          ...req.state.settings,
          licenseKey: prev.settings.licenseKey,
          trialStartedAt: prev.settings.trialStartedAt,
          review: prev.settings.review,
        };
        const next = { ...req.state, settings };
        // Anyone who ever had a licence (even an expired one) has had their trial's worth.
        if (addsProItem(prev, next) && pro(prev).plan === null) {
          settings = startTrialIfNeeded(settings, env.now());
        }
        return sortActivations({ ...next, settings });
      });
      return snapshot();
    },

    async testUrl(req) {
      const { state } = await store.load();
      return testUrlFor(state, req.url, req);
    },

    async getMatchesForTab(req) {
      const { state } = await store.load();
      const now = env.now();
      const explain = req.url
        ? (
            await testUrlFor(state, req.url, {
              resourceType: 'main_frame',
              method: 'get',
              tabId: req.tabId,
            })
          ).matches
        : [];
      let matched: chrome.declarativeNetRequest.MatchedRuleInfo[];
      try {
        matched = (await c.declarativeNetRequest.getMatchedRules({ tabId: req.tabId }))
          .rulesMatchedInfo;
      } catch (error) {
        const reason = /quota/i.test(errorText(error)) ? QUOTA : NOT_SHARED;
        return { unavailable: true, reason, explain };
      }
      const compiled = compile(state, { pro: pro(state).pro, now });
      const { split } = await readRuntime();
      const installed = {
        ...compiled,
        dynamic: [
          ...compiled.dynamic,
          ...split.filter((s) => s.source.list === 'dynamic').map((s) => s.rule),
        ],
        session: [
          ...compiled.session,
          ...split.filter((s) => s.source.list === 'session').map((s) => s.rule),
        ],
        sources: [...compiled.sources, ...split.map((s) => s.source)],
      };
      return { unavailable: false, applied: appliedEffects(state, installed, matched), explain };
    },

    async importText(req) {
      const result = importAny(req.text, env.now());
      const summary = summarizeImport(result.report);
      const nothing = result.profiles.length === 0 && result.variables.length === 0;
      if (!req.apply || result.report.errors.length > 0 || nothing) {
        return { report: result.report, summary, profileIds: [], snapshot: null };
      }
      const lines: ImportReportLine[] = [];
      let profileIds: string[] = [];
      await mutate((prev) => {
        lines.length = 0;
        const taken = new Set(prev.profiles.map((p) => p.id));
        const imported = result.profiles.map((p) => (taken.has(p.id) ? { ...p, id: newId() } : p));
        profileIds = imported.map((p) => p.id);
        const names = new Set(prev.settings.variables.map((v) => v.name));
        const variables = result.variables.flatMap((v) => {
          if (!names.has(v.name)) return [{ ...v, id: newId() }];
          lines.push({
            level: 'warning',
            profile: null,
            message: `You already have a variable {{${v.name}}}, so your current value was kept.`,
          });
          return [];
        });
        return {
          ...prev,
          profiles: [...prev.profiles, ...imported],
          settings: {
            ...prev.settings,
            variables: [...prev.settings.variables, ...variables],
          },
        };
      });
      return {
        report: { ...result.report, lines: [...result.report.lines, ...lines] },
        summary,
        profileIds,
        snapshot: await snapshot(),
      };
    },

    async activate(req) {
      await mutate((s) => {
        if (!s.profiles.some((p) => p.id === req.profileId)) {
          throw new HandlerError('not_found', 'That profile no longer exists.');
        }
        return activate(s, req.profileId, req.tabId, req.pauseAt);
      });
      return snapshot();
    },

    async deactivate(req) {
      await mutate((s) => deactivate(s, req.profileId, req.tabId));
      return snapshot();
    },

    async setPaused(req) {
      await mutate((s) => ({ ...s, settings: { ...s.settings, paused: req.paused } }));
      return snapshot();
    },

    async applyLicense(req) {
      const key = req.key.trim();
      const check = await replacementCheck(key);
      if (!check.ok) throw new HandlerError('license_invalid', check.error);
      await setLicense(key);
      return licenseOutcome(key, false);
    },

    async refreshLicense(req) {
      const { state } = await store.load();
      const key = state.settings.licenseKey;
      const status = pro(state);
      if (!key || status.plan === null) {
        throw new HandlerError('license_invalid', 'There is no licence key to refresh yet.');
      }
      if (status.plan === 'pro_lifetime') return licenseOutcome(key, true);
      if (req.auto) return (await autoRefresh()) ?? licenseOutcome(key, true);
      return refreshKey(key, false);
    },

    async startTrial() {
      await mutate((s) =>
        pro(s).plan !== null ? s : { ...s, settings: startTrialIfNeeded(s.settings, env.now()) },
      );
      return snapshot();
    },

    async setReviewState(req) {
      await mutate((s) => {
        const current = s.settings.review.state;
        if (current === 'dismissed' || current === 'rated') return s;
        return {
          ...s,
          settings: { ...s.settings, review: { ...s.settings.review, state: req.state } },
        };
      });
      return snapshot();
    },

    async getDiagnostics() {
      const origins = (await c.permissions.getAll()).origins ?? [];
      return {
        text: buildDiagnostics({
          snapshot: await snapshot(),
          origins,
          userAgent: env.userAgent,
          e2e: cfg.e2e,
          now: env.now(),
        }),
      };
    },

    async getCorruptData() {
      const raw = await store.corruptData();
      return { json: raw === undefined ? null : JSON.stringify(raw, null, 2) };
    },

    async discardCorruptData() {
      await store.discardCorruptData();
      return snapshot();
    },
  };

  async function dispatch(raw: unknown): Promise<Reply<RequestType>> {
    const req = parseRequest(raw);
    if (!req) return { ok: false, code: 'invalid_request', error: 'Unknown or malformed request.' };
    try {
      const handler = handlers[req.type] as (r: Request) => Promise<ResponseMap[RequestType]>;
      return { ok: true, data: await handler(req) };
    } catch (error) {
      if (error instanceof HandlerError) {
        return {
          ok: false,
          code: error.code,
          error: error.message,
          ...(error.code === 'conflict' ? { snapshot: await snapshot() } : {}),
        };
      }
      if (error instanceof StateError) {
        return {
          ok: false,
          code: error.reason === 'storage_full' ? 'storage_full' : 'invalid_state',
          error: error.message,
        };
      }
      reportError(error);
      return {
        ok: false,
        code: 'internal',
        error: `Headerbench hit an unexpected error: ${errorText(error)}`,
      };
    }
  }

  function externalAllowed(sender: chrome.runtime.MessageSender): boolean {
    const raw = sender.origin ?? sender.url;
    if (!raw) return false;
    try {
      const url = new URL(raw);
      return (
        cfg.externalOrigins.includes(url.origin) ||
        cfg.externalOrigins.includes(`${url.protocol}//${url.hostname}`)
      );
    } catch {
      return false;
    }
  }

  async function handleExternal(
    raw: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<ExternalReply> {
    if (!externalAllowed(sender)) {
      return { ok: false, reason: 'This page is not allowed to activate Headerbench.' };
    }
    const message = parseExternal(raw);
    if (!message) return { ok: false, reason: 'Headerbench does not understand this message.' };
    const key = message.key.trim();
    const check = await replacementCheck(key);
    if (!check.ok) return { ok: false, reason: check.error };
    try {
      await setLicense(key);
    } catch (error) {
      reportError(error);
      return { ok: false, reason: 'Headerbench could not save the key. Paste it in Settings.' };
    }
    const exp = check.payload.exp;
    return { ok: true, plan: check.payload.plan, expiresAt: exp === null ? null : exp * 1000 };
  }

  // ---------- lifecycle ----------

  /**
   * Creates the 6-hourly licence alarm unless it already runs with that period. Chrome may drop
   * alarms across updates and when the extension is disabled and enabled again (which fires
   * neither onInstalled nor onStartup), so this also runs whenever the service worker starts.
   * An existing alarm is kept, so frequent restarts don't keep pushing it back.
   */
  async function armLicenseAlarm(): Promise<void> {
    const existing = await c.alarms.get(LICENSE_ALARM);
    if (existing?.periodInMinutes === LICENSE_ALARM_PERIOD_MINUTES) return;
    await c.alarms.create(LICENSE_ALARM, {
      delayInMinutes: LICENSE_ALARM_PERIOD_MINUTES,
      periodInMinutes: LICENSE_ALARM_PERIOD_MINUTES,
    });
  }

  async function onInstalled(details: { reason: string }): Promise<void> {
    await serial(() => store.load());
    if (details.reason === 'install') {
      await c.tabs.create({ url: c.runtime.getURL('welcome.html') });
    }
    await resync();
    await armLicenseAlarm();
    await refreshInBackground();
  }

  async function onStartup(): Promise<void> {
    await mutate((s) => dropExpired(dropTabActivations(s), env.now()));
    await resync();
    await armLicenseAlarm();
    await pullFromMirror();
    await refreshInBackground();
  }

  async function onAlarm(alarm: { name: string }): Promise<void> {
    if (alarm.name === LICENSE_ALARM) {
      await refreshInBackground();
      return;
    }
    if (alarm.name !== WAKE_ALARM) return;
    await mutate((s) => dropExpired(s, env.now()));
    await resync();
  }

  async function onCommand(command: string): Promise<void> {
    if (command !== 'toggle-pause') return;
    await mutate((s) => ({ ...s, settings: { ...s.settings, paused: !s.settings.paused } }));
  }

  async function onTabRemoved(tabId: number): Promise<void> {
    await mutate((s) => dropTabActivations(s, tabId));
  }

  function register(): void {
    const guard =
      <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
      (...args: A): void => {
        fn(...args).catch(reportError);
      };
    c.runtime.onInstalled.addListener(guard(onInstalled));
    c.runtime.onStartup.addListener(guard(onStartup));
    c.alarms.onAlarm.addListener(guard(onAlarm));
    c.commands.onCommand.addListener(guard(onCommand));
    c.tabs.onRemoved.addListener(guard(onTabRemoved));
    c.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') onSyncChanged(changes).catch(reportError);
    });
    c.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== c.runtime.id) return false;
      void dispatch(message).then(sendResponse);
      return true;
    });
    c.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
      void handleExternal(message, sender).then(sendResponse);
      return true;
    });
    armLicenseAlarm().catch(reportError);
  }

  /** Resolves once queued work and any scheduled sync push have finished (tests). */
  async function idle(): Promise<void> {
    for (;;) {
      const pending = syncDone?.promise;
      await pending;
      await queue;
      if (syncDone?.promise === pending && syncTimer === null) return;
    }
  }

  return {
    store,
    dispatch,
    handleExternal,
    resync,
    onInstalled,
    onStartup,
    onAlarm,
    onCommand,
    onTabRemoved,
    onSyncChanged,
    register,
    idle,
  };
}

export type Background = ReturnType<typeof createBackground>;
