/** Reads and validates the extension build env vars. Used by vite.config.ts. */
import { DEV_LICENSE_PUBLIC_KEY } from '@headerbench/core';

export interface BuildEnv {
  e2e: boolean;
  licensePublicKey: string;
  apiBase: string;
}

export function readBuildEnv(env: Record<string, string | undefined>): BuildEnv {
  const e2e = env.HB_E2E === '1' || env.HB_E2E === 'true';
  const licensePublicKey = (env.HB_LICENSE_PUBLIC_KEY ?? '').trim() || DEV_LICENSE_PUBLIC_KEY;
  if (!/^[0-9a-f]{64}$/i.test(licensePublicKey)) {
    throw new Error('HB_LICENSE_PUBLIC_KEY must be 64 hex characters (an ed25519 public key).');
  }
  const rawBase = (env.HB_API_BASE ?? '').trim() || 'https://headerbench.com';
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error(`HB_API_BASE is not a URL: ${rawBase}`);
  }
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) {
    throw new Error('HB_API_BASE must use https (http is allowed for localhost only).');
  }
  return { e2e, licensePublicKey: licensePublicKey.toLowerCase(), apiBase: base.origin };
}
