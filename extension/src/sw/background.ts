/**
 * The service worker's logic, built on an injected `chrome` so tests can drive it with a fake.
 * All state changes go through `mutate`, which runs serially: load → change → validate and save
 * (with backup) → recompile and replace DNR rules → badge → wake-up alarm → sync mirror.
 */
import type { ImportReportLine, ProStatus, State, Warning } from '@headerbench/core';
import {
  compile,
  hostAccessFrom,
  importAny,
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
import type { Loaded } from './store';
import { KEYS, StateError, StateStore } from './store';
import {
  SYNC_KEYS,
  applyRemote,
  decodePayload,
  encodePayload,
  mergeOnEnable,
  staleChunkKeys,
  syncTooLargeMessage,
} from './sync';
import type { SyncMeta } from './sync';
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
export const LOCAL_KEYS = {
  runtime: 'runtime',
  syncStatus: 'syncStatus',
  deviceId: 'deviceId',
  refreshAttempt: 'licenseRefreshAttemptAt',
} as const;

interface RuntimeStatus {
  ruleError: string | null;
  rejected: Warning[];
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
      runtime = { ruleError: budget?.message ?? 'Rules could not be compiled.', rejected: [] };
    } else {
      const outcome = await installRules(c.declarativeNetRequest, result);
      runtime = { ruleError: outcome.error, rejected: outcome.rejected };
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
  function mutate(
    fn: Mutation,
    options: { fromSync?: boolean; keepRev?: boolean } = {},
  ): Promise<Loaded> {
    return serial(async () => {
      const loaded = await store.load();
      const next = await fn(loaded.state, loaded.rev);
      if (JSON.stringify(next) === JSON.stringify(loaded.state)) return loaded;
      const saved = await store.save(next, { keepRev: options.keepRev === true });
      await resyncNow(saved.state);
      if (!options.fromSync) await afterSave(loaded.state, saved.state);
      return saved;
    });
  }

  // ---------- sync mirror ----------

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

  async function pushNow(): Promise<void> {
    const { state } = await store.load();
    if (!syncActive(state)) return;
    const now = env.now();
    const payload = { profiles: state.profiles, variables: state.settings.variables };
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
    if (!syncActive(next)) return;
    if (!prev.settings.sync) {
      const decoded = decodePayload(await c.storage.sync.get(null), env.now());
      if (decoded && decoded.meta.device !== (await deviceId())) {
        const merged = sortActivations(mergeOnEnable(next, decoded.payload));
        if (JSON.stringify(merged) !== JSON.stringify(next)) {
          const saved = await store.save(merged);
          await resyncNow(saved.state);
        }
      }
    }
    schedulePush();
  }

  async function onSyncChanged(changes: Record<string, chrome.storage.StorageChange>) {
    const meta = changes[SYNC_KEYS.meta]?.newValue as SyncMeta | undefined;
    if (!meta || meta.device === (await deviceId())) return;
    await mutate(
      async (state) => {
        if (!syncActive(state)) return state;
        const decoded = decodePayload(await c.storage.sync.get(null), env.now());
        if (!decoded) return state;
        await writeSyncStatus({ error: null, lastSyncedAt: env.now() });
        return applyRemote(state, decoded.payload);
      },
      { fromSync: true },
    );
  }

  // ---------- snapshot ----------

  async function snapshot(): Promise<Snapshot> {
    const { state, rev } = await store.load();
    const now = env.now();
    const status = pro(state);
    const compiled = compile(state, { pro: status.pro, now });
    const stored = await c.storage.local.get([
      LOCAL_KEYS.runtime,
      LOCAL_KEYS.syncStatus,
      KEYS.corrupt,
    ]);
    const runtime = (stored[LOCAL_KEYS.runtime] as RuntimeStatus | undefined) ?? {
      ruleError: null,
      rejected: [],
    };
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
      hasPageAccess: page === null || granted(req.initiator as string),
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

  const setLicense = (key: string): Promise<Loaded> =>
    mutate((s) => ({ ...s, settings: { ...s.settings, licenseKey: key } }));

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
        if (addsProItem(prev, next) && pro(prev).source !== 'license') {
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
      return { unavailable: false, applied: appliedEffects(state, compiled, matched), explain };
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
      await mutate((s) => deactivate(s, req.profileId));
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
      const now = env.now();
      if (status.plan === 'pro_lifetime') return licenseOutcome(key, true);
      if (req.auto) {
        const last = (await c.storage.local.get(LOCAL_KEYS.refreshAttempt))[
          LOCAL_KEYS.refreshAttempt
        ];
        const recent = typeof last === 'number' && now - last < AUTO_REFRESH_INTERVAL_MS;
        if (!refreshDue(status, now) || recent) return licenseOutcome(key, true);
      }
      await c.storage.local.set({ [LOCAL_KEYS.refreshAttempt]: now });
      const result = await requestRefresh(env.fetch, cfg.apiBase, key);
      if (!result.ok) throw new HandlerError(result.code, result.error);
      const check = await replacementCheck(result.key);
      if (!check.ok) {
        throw new HandlerError(
          'license_invalid',
          `The licence server sent a key this version cannot use. ${check.error} Your current licence stays active.`,
        );
      }
      await setLicense(result.key);
      return licenseOutcome(result.key, false);
    },

    async startTrial() {
      await mutate((s) =>
        pro(s).source === 'license'
          ? s
          : { ...s, settings: startTrialIfNeeded(s.settings, env.now()) },
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
        return { ok: false, code: 'invalid_state', error: error.message };
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

  async function onInstalled(details: { reason: string }): Promise<void> {
    await serial(() => store.load());
    if (details.reason === 'install') {
      await c.tabs.create({ url: c.runtime.getURL('welcome.html') });
    }
    await resync();
  }

  async function onStartup(): Promise<void> {
    await mutate((s) => dropExpired(dropTabActivations(s), env.now()));
    await resync();
  }

  async function onAlarm(alarm: { name: string }): Promise<void> {
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
  }

  /** Resolves once queued work and any scheduled sync push have finished (tests). */
  async function idle(): Promise<void> {
    await syncDone?.promise;
    await queue;
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
