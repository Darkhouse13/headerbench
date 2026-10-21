/** Licence helpers for the service worker: messages, refresh scheduling and the refresh call. */
import type { LicenseFailure, LicensePayload, ProStatus, State } from '@headerbench/core';
import { usesVariables, verifyLicense } from '@headerbench/core';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A yearly licence is refreshed automatically in the last 14 days before it expires. */
export const REFRESH_WINDOW_MS = 14 * DAY_MS;
/** Automatic refreshes are attempted at most this often; also the background alarm's period. */
export const AUTO_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

export function licenseFailureMessage(reason: LicenseFailure): string {
  switch (reason) {
    case 'malformed':
      return 'This is not a Headerbench licence key. Keys start with HB1. and have two dots.';
    case 'bad_signature':
    case 'bad_payload':
      return 'This key does not match a Headerbench licence. Copy the whole key from your activation page or receipt email.';
    case 'bad_public_key':
      return 'This build of Headerbench cannot check licences. Please report it to support@headerbench.com.';
    case 'revoked':
      return 'This licence was refunded, so it no longer turns on Pro. If that is a mistake, email support@headerbench.com.';
  }
}

export interface LicenseKeys {
  publicKey: string;
  /** Licence ids that no longer count (extension/revoked.json). */
  revoked: readonly string[];
}

export type LicenseCheck =
  | { ok: true; payload: LicensePayload }
  /** `shorter`: authentic and unexpired, but the current key lasts longer. */
  | { ok: false; error: string; shorter?: true };

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Whether `candidate` may become the stored licence. It must be authentic and unexpired, and it
 * never replaces a valid current key that lasts longer: lifetime beats yearly, and a later
 * expiry beats an earlier one, except for a newer key of the same licence (same `lid` and plan),
 * which always wins. `nowSec` is unix seconds.
 */
export function checkLicenseReplacement(
  candidate: string,
  current: string | null,
  keys: LicenseKeys,
  nowSec: number,
): LicenseCheck {
  const next = verifyLicense(candidate, keys.publicKey, nowSec, keys.revoked);
  if (!next.ok) return { ok: false, error: licenseFailureMessage(next.reason) };
  if (next.expired) {
    return {
      ok: false,
      error: 'This licence key has expired. Renew it on headerbench.com/pro, then activate again.',
    };
  }
  const now = current ? verifyLicense(current, keys.publicKey, nowSec, keys.revoked) : null;
  if (!now?.ok || now.expired || current === candidate.trim()) {
    return { ok: true, payload: next.payload };
  }
  const currentExp = now.payload.exp;
  const nextExp = next.payload.exp;
  if (currentExp === null && nextExp !== null) {
    return {
      ok: false,
      error: 'Your lifetime licence is already active, so this key was not applied.',
      shorter: true,
    };
  }
  // Same subscription: the server is the authority on how long it runs (it now issues keys of at
  // most 60 days, so a refresh can legitimately end sooner than a 1-year key from before).
  const sameLicence =
    next.payload.lid === now.payload.lid && next.payload.plan === now.payload.plan;
  if (currentExp !== null && nextExp !== null && nextExp < currentExp && !sameLicence) {
    return {
      ok: false,
      error: `Your current licence lasts longer (until ${day(currentExp)}), so it stays active.`,
      shorter: true,
    };
  }
  return { ok: true, payload: next.payload };
}

/** True for a yearly licence in its last 14 days. Never after it expired: then only a click refreshes. */
export function refreshDue(pro: ProStatus, now: number): boolean {
  return (
    pro.plan === 'pro_yearly' &&
    pro.licenseExpiresAt !== null &&
    pro.licenseExpiresAt > now &&
    pro.licenseExpiresAt - now < REFRESH_WINDOW_MS
  );
}

export type RefreshResult =
  | { ok: true; key: string }
  | { ok: false; code: 'subscription_inactive' | 'network'; error: string };

/**
 * POST {apiBase}/api/license/refresh with only the key. The only network request Headerbench
 * makes: on a Refresh click, or automatically for a yearly licence in its last 14 days.
 */
export async function requestRefresh(
  fetchFn: typeof fetch,
  apiBase: string,
  key: string,
): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await fetchFn(`${apiBase}/api/license/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      code: 'network',
      error: 'Could not reach headerbench.com. Your current licence stays active; try again later.',
    };
  }
  const body = (await response.json().catch(() => null)) as {
    key?: unknown;
    message?: unknown;
  } | null;
  if (response.ok && typeof body?.key === 'string') return { ok: true, key: body.key };
  // Server errors are `{ reason, message }`; the message is written for users.
  const serverMessage =
    typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null;
  if (response.status === 410) {
    return {
      ok: false,
      code: 'subscription_inactive',
      error:
        serverMessage ??
        'Your subscription is no longer active, so the licence was not renewed. Pro rules pause when the current key expires; nothing is deleted.',
    };
  }
  return {
    ok: false,
    code: 'network',
    error: `${serverMessage ?? `The licence server answered with an error (HTTP ${response.status}).`} Your current licence stays active.`,
  };
}

/** Ids of Pro items (mocks, regex or variable redirects, variable headers) and variables. */
export function proItemIds(state: State): Set<string> {
  const ids = new Set<string>();
  for (const p of state.profiles) {
    for (const m of p.mocks) ids.add(m.id);
    for (const r of p.redirects) if (r.kind === 'regex' || usesVariables(r.to)) ids.add(r.id);
    for (const h of [...p.requestHeaders, ...p.responseHeaders]) {
      if (usesVariables(h.value)) ids.add(h.id);
    }
  }
  for (const v of state.settings.variables) ids.add(v.id);
  return ids;
}

/** True when `next` adds a Pro item that `prev` did not have: the moment the trial starts. */
export function addsProItem(prev: State, next: State): boolean {
  const before = proItemIds(prev);
  return [...proItemIds(next)].some((id) => !before.has(id));
}
