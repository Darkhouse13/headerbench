/**
 * Offline-verifiable licence keys: `HB1.<base64url(JSON payload)>.<base64url(ed25519 signature)>`.
 * The signature covers the UTF-8 bytes of the payload JSON (the decoded middle segment).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  base64Decode,
  base64UrlEncode,
  bytesToHex,
  hexToBytes,
  utf8Decode,
  utf8Encode,
} from './encoding.js';
import type { Settings, State } from './model.js';
import { usesVariables } from './variables.js';

export type LicensePlan = 'pro_yearly' | 'pro_lifetime';

export interface LicensePayload {
  v: 1;
  /** Licence id: the subscription id for yearly, the transaction id for lifetime. */
  lid: string;
  plan: LicensePlan;
  /** Paddle subscription id (yearly only). */
  sub: string | null;
  /** Paddle transaction id. */
  txn: string;
  /** Expiry in unix seconds, including the 7-day grace; `null` for lifetime. */
  exp: number | null;
  /** Issued-at, unix seconds. */
  iat: number;
}

export type LicenseFailure =
  | 'malformed'
  | 'bad_signature'
  | 'bad_payload'
  | 'bad_public_key'
  /** The licence id is on the build's revocation list (a refunded lifetime purchase). */
  | 'revoked';

export type LicenseVerification =
  { ok: true; payload: LicensePayload; expired: boolean } | { ok: false; reason: LicenseFailure };

const PREFIX = 'HB1';

/**
 * Public half of the development keypair. Builds without `HB_LICENSE_PUBLIC_KEY` use it; the
 * matching private key lives only in packages/core/test/fixtures/dev-license-key.ts.
 */
export const DEV_LICENSE_PUBLIC_KEY =
  '9d75c3108e2971713ca50a274d5d1f0591dd081d43b5fea1492a9c38f3df21c7';

export const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function isPayload(value: unknown): value is LicensePayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  const optionalString = (v: unknown): boolean =>
    v === null || (typeof v === 'string' && v.length > 0);
  return (
    p.v === 1 &&
    typeof p.lid === 'string' &&
    p.lid.length > 0 &&
    (p.plan === 'pro_yearly' || p.plan === 'pro_lifetime') &&
    optionalString(p.sub) &&
    typeof p.txn === 'string' &&
    p.txn.length > 0 &&
    (p.exp === null || (typeof p.exp === 'number' && Number.isFinite(p.exp))) &&
    typeof p.iat === 'number' &&
    Number.isFinite(p.iat)
  );
}

/** Signs a payload. Used by the server; `privateKeyHex` is a 32-byte ed25519 secret key. */
export function signLicense(payload: LicensePayload, privateKeyHex: string): string {
  if (!isPayload(payload)) throw new Error('Invalid licence payload');
  const secretKey = hexToBytes(privateKeyHex);
  if (secretKey.length !== 32) throw new Error('The licence private key must be 32 bytes of hex');
  const message = utf8Encode(JSON.stringify(payload));
  const signature = ed25519.sign(message, secretKey);
  return `${PREFIX}.${base64UrlEncode(message)}.${base64UrlEncode(signature)}`;
}

/** Hex public key for a hex private key, so the server can log which key it signs with. */
export function licensePublicKey(privateKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(privateKeyHex)));
}

/** A fresh ed25519 keypair (hex) for production signing. Used by scripts/gen-license-key.mjs. */
export function generateLicenseKeyPair(): { privateKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { privateKeyHex: bytesToHex(secretKey), publicKeyHex: bytesToHex(publicKey) };
}

/**
 * `nowSec` is unix seconds. An expired but authentic key returns `ok: true, expired: true`.
 * `revoked` lists licence ids (`lid`) that are no longer valid, e.g. refunded lifetime purchases;
 * the extension compiles this list in from extension/revoked.json.
 */
export function verifyLicense(
  key: string,
  publicKeyHex: string,
  nowSec: number,
  revoked: readonly string[] = [],
): LicenseVerification {
  let publicKey: Uint8Array;
  try {
    publicKey = hexToBytes(publicKeyHex);
  } catch {
    return { ok: false, reason: 'bad_public_key' };
  }
  if (publicKey.length !== 32) return { ok: false, reason: 'bad_public_key' };

  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'malformed' };
  let message: Uint8Array;
  let signature: Uint8Array;
  try {
    message = base64Decode(parts[1] as string);
    signature = base64Decode(parts[2] as string);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  let valid = false;
  try {
    valid =
      signature.length === 64 && ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let payload: unknown;
  try {
    payload = JSON.parse(utf8Decode(message));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!isPayload(payload)) return { ok: false, reason: 'bad_payload' };
  if (revoked.includes(payload.lid)) return { ok: false, reason: 'revoked' };
  return { ok: true, payload, expired: payload.exp !== null && payload.exp <= nowSec };
}

export interface ProStatus {
  pro: boolean;
  source: 'license' | 'trial' | null;
  /** Milliseconds since epoch, or null if no trial was started. */
  trialEndsAt: number | null;
  /** Milliseconds since epoch; null for lifetime licences or when there is no valid licence. */
  licenseExpiresAt: number | null;
  /** The verified licence plan, even when expired; null without a valid key. */
  plan: LicensePlan | null;
}

/**
 * `now` is milliseconds since epoch. `publicKeyHex` is the build's licence public key and
 * `revoked` its revocation list (see `verifyLicense`). A valid unexpired licence wins over the trial.
 */
export function proStatus(
  settings: Settings,
  now: number,
  publicKeyHex: string,
  revoked: readonly string[] = [],
): ProStatus {
  const trialEndsAt =
    settings.trialStartedAt === null ? null : settings.trialStartedAt + TRIAL_DAYS * DAY_MS;
  const verified = settings.licenseKey
    ? verifyLicense(settings.licenseKey, publicKeyHex, Math.floor(now / 1000), revoked)
    : null;
  const license = verified?.ok ? verified : null;
  const licenseExpiresAt = license?.payload.exp != null ? license.payload.exp * 1000 : null;
  const plan = license?.payload.plan ?? null;
  if (license && !license.expired) {
    return { pro: true, source: 'license', trialEndsAt, licenseExpiresAt, plan };
  }
  if (trialEndsAt !== null && trialEndsAt > now) {
    return { pro: true, source: 'trial', trialEndsAt, licenseExpiresAt, plan };
  }
  return { pro: false, source: null, trialEndsAt, licenseExpiresAt, plan };
}

/** Starts the 14-day trial the first time it is needed. Returns the same object if already started. */
export function startTrialIfNeeded(settings: Settings, now: number): Settings {
  return settings.trialStartedAt === null ? { ...settings, trialStartedAt: now } : settings;
}

/** True if any profile uses a Pro feature: mocks, regex redirects or `{{variables}}`. */
export function hasProItems(state: State): boolean {
  return state.profiles.some(
    (p) =>
      p.mocks.length > 0 ||
      p.redirects.some((r) => r.kind === 'regex' || usesVariables(r.to)) ||
      [...p.requestHeaders, ...p.responseHeaders].some((m) => usesVariables(m.value)),
  );
}
