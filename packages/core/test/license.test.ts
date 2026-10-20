import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  DEV_LICENSE_PUBLIC_KEY,
  base64UrlEncode,
  defaultSettings,
  generateLicenseKeyPair,
  hasProItems,
  hexToBytes,
  licensePublicKey,
  proStatus,
  signLicense,
  startTrialIfNeeded,
  utf8Encode,
  verifyLicense,
} from '../src/index.js';
import type { LicensePayload } from '../src/index.js';
import { DEV_LICENSE_PRIVATE_KEY } from './fixtures/dev-license-key.js';
import { header, profile, redirect, stateWith } from './helpers.js';

const NOW_SEC = 1_760_000_000;
const yearly: LicensePayload = {
  v: 1,
  lid: 'sub_01',
  plan: 'pro_yearly',
  sub: 'sub_01',
  txn: 'txn_01',
  exp: NOW_SEC + 86_400,
  iat: NOW_SEC,
};
const lifetime: LicensePayload = {
  v: 1,
  lid: 'txn_02',
  plan: 'pro_lifetime',
  sub: null,
  txn: 'txn_02',
  exp: null,
  iat: NOW_SEC,
};

describe('licence keys', () => {
  it('signs and verifies a yearly and a lifetime key', () => {
    const key = signLicense(yearly, DEV_LICENSE_PRIVATE_KEY);
    expect(key).toMatch(/^HB1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyLicense(key, DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: true,
      payload: yearly,
      expired: false,
    });
    expect(
      verifyLicense(
        signLicense(lifetime, DEV_LICENSE_PRIVATE_KEY),
        DEV_LICENSE_PUBLIC_KEY,
        4_000_000_000,
      ),
    ).toEqual({ ok: true, payload: lifetime, expired: false });
  });

  it('generates working keypairs', () => {
    const { privateKeyHex, publicKeyHex } = generateLicenseKeyPair();
    expect(privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(licensePublicKey(privateKeyHex)).toBe(publicKeyHex);
    expect(verifyLicense(signLicense(lifetime, privateKeyHex), publicKeyHex, NOW_SEC).ok).toBe(
      true,
    );
  });

  it('matches the committed dev public key', () => {
    expect(licensePublicKey(DEV_LICENSE_PRIVATE_KEY)).toBe(DEV_LICENSE_PUBLIC_KEY);
  });

  it('reports an authentic expired key as expired', () => {
    const key = signLicense(yearly, DEV_LICENSE_PRIVATE_KEY);
    expect(verifyLicense(key, DEV_LICENSE_PUBLIC_KEY, NOW_SEC + 86_400)).toMatchObject({
      ok: true,
      expired: true,
    });
  });

  it('rejects a tampered payload or signature', () => {
    const [prefix, payload, signature] = signLicense(yearly, DEV_LICENSE_PRIVATE_KEY).split('.');
    const forged = base64UrlEncode(
      utf8Encode(JSON.stringify({ ...yearly, exp: NOW_SEC + 10 * 365 * 86_400 })),
    );
    expect(
      verifyLicense(`${prefix}.${forged}.${signature}`, DEV_LICENSE_PUBLIC_KEY, NOW_SEC),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    const flipped = `${signature!.slice(0, -2)}${signature!.endsWith('AA') ? 'AB' : 'AA'}`;
    expect(
      verifyLicense(`${prefix}.${payload}.${flipped}`, DEV_LICENSE_PUBLIC_KEY, NOW_SEC),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects keys signed by another key', () => {
    const other = 'a'.repeat(64);
    const key = signLicense(yearly, other);
    expect(verifyLicense(key, DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyLicense(key, licensePublicKey(other), NOW_SEC).ok).toBe(true);
  });

  it('rejects malformed keys and bad public keys', () => {
    expect(verifyLicense('', DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLicense('HB2.a.b', DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLicense('HB1.!!.b', DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLicense('HB1.abcd.abcd', DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyLicense('HB1.a.b', 'zz', NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_public_key',
    });
    expect(verifyLicense('HB1.a.b', 'abcd', NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_public_key',
    });
  });

  it('rejects a correctly signed payload with the wrong shape', () => {
    const sign = (text: string): string => {
      const message = utf8Encode(text);
      const signature = ed25519.sign(message, hexToBytes(DEV_LICENSE_PRIVATE_KEY));
      return `HB1.${base64UrlEncode(message)}.${base64UrlEncode(signature)}`;
    };
    expect(verifyLicense(sign('{"v":1,"plan":"gold"}'), DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_payload',
    });
    expect(verifyLicense(sign('not json'), DEV_LICENSE_PUBLIC_KEY, NOW_SEC)).toEqual({
      ok: false,
      reason: 'bad_payload',
    });
    expect(() =>
      signLicense(
        { ...yearly, plan: 'gold' } as unknown as LicensePayload,
        DEV_LICENSE_PRIVATE_KEY,
      ),
    ).toThrow('Invalid licence payload');
    expect(() => signLicense(yearly, 'abcd')).toThrow('32 bytes');
  });

  it('accepts surrounding whitespace from a paste', () => {
    const key = signLicense(lifetime, DEV_LICENSE_PRIVATE_KEY);
    expect(verifyLicense(`  ${key}\n`, DEV_LICENSE_PUBLIC_KEY, NOW_SEC).ok).toBe(true);
  });
});

describe('proStatus', () => {
  const now = NOW_SEC * 1000;
  const day = 86_400_000;

  it('is off with no licence and no trial', () => {
    expect(proStatus(defaultSettings(), now, DEV_LICENSE_PUBLIC_KEY)).toEqual({
      pro: false,
      source: null,
      trialEndsAt: null,
      licenseExpiresAt: null,
      plan: null,
    });
  });

  it('runs the trial for 14 days', () => {
    const settings = { ...defaultSettings(), trialStartedAt: now - 13 * day };
    expect(proStatus(settings, now, DEV_LICENSE_PUBLIC_KEY)).toMatchObject({
      pro: true,
      source: 'trial',
      trialEndsAt: now + day,
    });
    expect(proStatus(settings, now + day, DEV_LICENSE_PUBLIC_KEY)).toMatchObject({
      pro: false,
      source: null,
    });
  });

  it('prefers a valid licence and reports its expiry', () => {
    const settings = {
      ...defaultSettings(),
      trialStartedAt: now,
      licenseKey: signLicense(yearly, DEV_LICENSE_PRIVATE_KEY),
    };
    expect(proStatus(settings, now, DEV_LICENSE_PUBLIC_KEY)).toEqual({
      pro: true,
      source: 'license',
      trialEndsAt: now + 14 * day,
      licenseExpiresAt: (NOW_SEC + 86_400) * 1000,
      plan: 'pro_yearly',
    });
  });

  it('turns off when the licence expires or is forged', () => {
    const expired = {
      ...defaultSettings(),
      licenseKey: signLicense(yearly, DEV_LICENSE_PRIVATE_KEY),
    };
    expect(proStatus(expired, now + 2 * day, DEV_LICENSE_PUBLIC_KEY)).toMatchObject({
      pro: false,
      plan: 'pro_yearly',
    });
    const forged = { ...defaultSettings(), licenseKey: signLicense(lifetime, 'b'.repeat(64)) };
    expect(proStatus(forged, now, DEV_LICENSE_PUBLIC_KEY)).toMatchObject({
      pro: false,
      plan: null,
    });
  });
});

describe('licence revocation list', () => {
  const key = signLicense(lifetime, DEV_LICENSE_PRIVATE_KEY);

  it('rejects a key whose lid is listed', () => {
    expect(verifyLicense(key, DEV_LICENSE_PUBLIC_KEY, NOW_SEC, ['txn_02'])).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(verifyLicense(key, DEV_LICENSE_PUBLIC_KEY, NOW_SEC, ['txn_other']).ok).toBe(true);
  });

  it('turns Pro off for a revoked licence but keeps a running trial', () => {
    const now = NOW_SEC * 1000;
    const settings = { ...defaultSettings(), licenseKey: key };
    expect(proStatus(settings, now, DEV_LICENSE_PUBLIC_KEY, ['txn_02'])).toMatchObject({
      pro: false,
      source: null,
      plan: null,
    });
    expect(
      proStatus({ ...settings, trialStartedAt: now }, now, DEV_LICENSE_PUBLIC_KEY, ['txn_02']),
    ).toMatchObject({ pro: true, source: 'trial' });
  });
});

describe('trial helpers', () => {
  it('starts the trial once', () => {
    const started = startTrialIfNeeded(defaultSettings(), 1000);
    expect(started.trialStartedAt).toBe(1000);
    expect(startTrialIfNeeded(started, 2000)).toBe(started);
  });

  it('detects Pro items', () => {
    expect(hasProItems(stateWith([profile('P', { requestHeaders: [header('X-A', '1')] })]))).toBe(
      false,
    );
    expect(
      hasProItems(stateWith([profile('P', { requestHeaders: [header('X-A', '{{token}}')] })])),
    ).toBe(true);
    expect(
      hasProItems(stateWith([profile('P', { redirects: [redirect('regex', 'a', 'b')] })])),
    ).toBe(true);
  });
});
