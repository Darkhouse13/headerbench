/** Licence keys signed with the development key pair the E2E build trusts. */
import type { LicensePayload } from '@headerbench/core';
import { DEV_LICENSE_PUBLIC_KEY, signLicense, verifyLicense } from '@headerbench/core';
import { DEV_LICENSE_PRIVATE_KEY } from '../../packages/core/test/fixtures/dev-license-key.ts';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function devLicense(overrides: Partial<LicensePayload> = {}): string {
  return signLicense(
    {
      v: 1,
      lid: 'sub_01e2etest',
      plan: 'pro_yearly',
      sub: 'sub_01e2etest',
      txn: 'txn_01e2etest',
      exp: nowSec() + 365 * 86400,
      iat: nowSec(),
      ...overrides,
    },
    DEV_LICENSE_PRIVATE_KEY,
  );
}

/**
 * What the licence server's refresh does for an active subscription: the same licence re-signed
 * with an expiry a year out. Null for a key the dev key pair did not sign.
 */
export function renewLicense(key: string): string | null {
  const checked = verifyLicense(key, DEV_LICENSE_PUBLIC_KEY, nowSec());
  if (!checked.ok) return null;
  return signLicense(
    { ...checked.payload, exp: nowSec() + 365 * 86400, iat: nowSec() },
    DEV_LICENSE_PRIVATE_KEY,
  );
}

/** Same payload, one signature byte flipped. */
export function tamper(key: string): string {
  const [prefix, payload, signature = ''] = key.split('.');
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  return [prefix, payload, flipped].join('.');
}
