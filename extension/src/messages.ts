/**
 * Typed message API between extension pages and the service worker (`chrome.runtime.sendMessage`).
 * Every request gets a `Reply`: `{ ok: true, data }` or `{ ok: false, code, error }`.
 * Documented for E2E use in extension/README.md.
 */
import type {
  CompileStats,
  Effect,
  ImportReport,
  LicensePlan,
  Match,
  Method,
  ProStatus,
  ResourceType,
  RuleKind,
  State,
  Warning,
} from '@headerbench/core';
import { METHODS, RESOURCE_TYPES } from '@headerbench/core';

export interface SyncStatus {
  /** `settings.sync` is on and Pro is active. */
  active: boolean;
  /** Plain-language reason sync is not mirroring right now, or null. */
  error: string | null;
  /** Size of the last mirrored payload in bytes. */
  bytes: number;
  lastSyncedAt: number | null;
}

/** Everything a page needs to render. Returned by `getState` and by every mutating request. */
export interface Snapshot {
  /** Increases on every save. `saveState` must send the rev it edited. */
  rev: number;
  state: State;
  pro: ProStatus;
  /** Compiler warnings plus items Chrome itself rejected. */
  warnings: Warning[];
  stats: CompileStats;
  /** Set when the last resync could not install rules (e.g. the rule budget). */
  ruleError: string | null;
  sync: SyncStatus;
  /** Unreadable stored data was set aside under `state.corrupt` and can be downloaded. */
  hasCorruptData: boolean;
  version: string;
}

export interface TestUrlResult {
  matches: Match[];
  /** Null when the URL could not be parsed. */
  origin: string | null;
  /** Access to the request URL. */
  hasHostAccess: boolean;
  /** Host pattern of the page that sends the request (`initiator`), or null when none was given. */
  pageOrigin: string | null;
  /** Access to that page; true when there is none. Chrome needs it too. */
  hasPageAccess: boolean;
}

/** One effect Chrome reported as applied on a tab (a header op, redirect, block, mock or exclude). */
export interface AppliedEffect {
  profileId: string;
  profileName: string;
  color: string;
  kind: RuleKind;
  itemId: string | null;
  effect: Effect;
  /** Number of matched requests for the rule, and when it last matched (ms). */
  hits: number;
  lastMatchedAt: number;
}

export type TabMatches =
  | { unavailable: false; applied: AppliedEffect[]; explain: Match[] }
  | { unavailable: true; reason: string; explain: Match[] };

export interface ImportOutcome {
  report: ImportReport;
  summary: string;
  /** Ids of the imported profiles (empty for a preview or a failed import). */
  profileIds: string[];
  /** The new snapshot when `apply` was true and the import succeeded. */
  snapshot: Snapshot | null;
}

export interface LicenseOutcome {
  snapshot: Snapshot;
  plan: LicensePlan | null;
  expired: boolean;
  /** Ms since epoch, null for lifetime. */
  expiresAt: number | null;
  /** For `refreshLicense` with `auto: true`: nothing was due, so no request was made. */
  skipped: boolean;
}

export type ReviewAction = 'shown' | 'dismissed' | 'rated';

export type Request =
  | { type: 'getState' }
  | { type: 'saveState'; state: State; rev: number }
  | {
      type: 'testUrl';
      url: string;
      resourceType: ResourceType;
      method: Method;
      tabId?: number;
      /** The page that sends the request. */
      initiator?: string;
    }
  | { type: 'getMatchesForTab'; tabId: number; url?: string }
  | { type: 'importText'; text: string; apply: boolean }
  | { type: 'activate'; profileId: string; tabId: number | null; pauseAt: number | null }
  | { type: 'deactivate'; profileId: string }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'applyLicense'; key: string }
  | { type: 'refreshLicense'; auto: boolean }
  | { type: 'startTrial' }
  | { type: 'setReviewState'; state: ReviewAction }
  | { type: 'getDiagnostics' }
  | { type: 'getCorruptData' }
  | { type: 'discardCorruptData' };

export type RequestType = Request['type'];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

export interface ResponseMap {
  getState: Snapshot;
  saveState: Snapshot;
  testUrl: TestUrlResult;
  getMatchesForTab: TabMatches;
  importText: ImportOutcome;
  activate: Snapshot;
  deactivate: Snapshot;
  setPaused: Snapshot;
  applyLicense: LicenseOutcome;
  refreshLicense: LicenseOutcome;
  startTrial: Snapshot;
  setReviewState: Snapshot;
  getDiagnostics: { text: string };
  getCorruptData: { json: string | null };
  discardCorruptData: Snapshot;
}

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_state'
  | 'conflict'
  | 'not_found'
  | 'license_invalid'
  | 'subscription_inactive'
  | 'network'
  | 'internal';

export type Reply<T extends RequestType> =
  | { ok: true; data: ResponseMap[T] }
  | { ok: false; code: ErrorCode; error: string; snapshot?: Snapshot };

/** Message accepted from https://headerbench.com via `chrome.runtime.sendMessage(EXTENSION_ID, …)`. */
export interface ExternalActivateLicense {
  type: 'activate-license';
  key: string;
}

export type ExternalReply =
  { ok: true; plan: LicensePlan; expiresAt: number | null } | { ok: false; reason: string };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isTime = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v));

/**
 * Shallow shape check of an incoming request. `saveState` bodies are validated in depth by the
 * state store. Returns null for anything that is not a well-formed request.
 */
export function parseRequest(raw: unknown): Request | null {
  if (!isObj(raw) || !isStr(raw.type)) return null;
  const r = raw as Raw & { type: string };
  switch (r.type) {
    case 'getState':
    case 'startTrial':
    case 'getDiagnostics':
    case 'getCorruptData':
    case 'discardCorruptData':
      return { type: r.type };
    case 'saveState':
      return isObj(r.state) && isInt(r.rev)
        ? { type: 'saveState', state: r.state as unknown as State, rev: r.rev }
        : null;
    case 'testUrl':
      return isStr(r.url) &&
        RESOURCE_TYPES.includes(r.resourceType as ResourceType) &&
        METHODS.includes(r.method as Method) &&
        (r.tabId === undefined || isInt(r.tabId)) &&
        (r.initiator === undefined || isStr(r.initiator))
        ? {
            type: 'testUrl',
            url: r.url,
            resourceType: r.resourceType as ResourceType,
            method: r.method as Method,
            ...(isInt(r.tabId) ? { tabId: r.tabId } : {}),
            ...(isStr(r.initiator) && r.initiator.trim() !== ''
              ? { initiator: r.initiator.trim() }
              : {}),
          }
        : null;
    case 'getMatchesForTab':
      return isInt(r.tabId) && (r.url === undefined || isStr(r.url))
        ? { type: 'getMatchesForTab', tabId: r.tabId, ...(isStr(r.url) ? { url: r.url } : {}) }
        : null;
    case 'importText':
      return isStr(r.text) && typeof r.apply === 'boolean'
        ? { type: 'importText', text: r.text, apply: r.apply }
        : null;
    case 'activate':
      return isStr(r.profileId) && (r.tabId === null || isInt(r.tabId)) && isTime(r.pauseAt)
        ? { type: 'activate', profileId: r.profileId, tabId: r.tabId, pauseAt: r.pauseAt }
        : null;
    case 'deactivate':
      return isStr(r.profileId) ? { type: 'deactivate', profileId: r.profileId } : null;
    case 'setPaused':
      return typeof r.paused === 'boolean' ? { type: 'setPaused', paused: r.paused } : null;
    case 'applyLicense':
      return isStr(r.key) ? { type: 'applyLicense', key: r.key } : null;
    case 'refreshLicense':
      return typeof r.auto === 'boolean' ? { type: 'refreshLicense', auto: r.auto } : null;
    case 'setReviewState':
      return r.state === 'shown' || r.state === 'dismissed' || r.state === 'rated'
        ? { type: 'setReviewState', state: r.state }
        : null;
    default:
      return null;
  }
}

export function parseExternal(raw: unknown): ExternalActivateLicense | null {
  return isObj(raw) && raw.type === 'activate-license' && isStr(raw.key) && raw.key.length < 4096
    ? { type: 'activate-license', key: raw.key }
    : null;
}
