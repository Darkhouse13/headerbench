import type { HeaderMod, LicensePayload, Profile, State } from '@headerbench/core';
import {
  DEV_LICENSE_PUBLIC_KEY,
  defaultState,
  newHeaderMod,
  newProfile,
  signLicense,
} from '@headerbench/core';
import { DEV_LICENSE_PRIVATE_KEY } from '../../packages/core/test/fixtures/dev-license-key';
import type { Env } from '../src/sw/background';
import { createBackground } from '../src/sw/background';
import type { Reply, Request, RequestType, ResponseMap } from '../src/messages';
import { createChromeFake } from './chrome-fake';

export const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export function header(name: string, value: string, op: HeaderMod['op'] = 'set'): HeaderMod {
  return newHeaderMod({ name, value, op });
}

export function profile(name: string, extra: Partial<Profile> = {}): Profile {
  return { ...newProfile({ name, now: NOW }), ...extra };
}

export function domain(value: string, exclude = false) {
  return { id: crypto.randomUUID(), enabled: true, kind: 'domain' as const, value, exclude };
}

export function stateWith(profiles: Profile[], settings: Partial<State['settings']> = {}): State {
  const base = defaultState();
  return { ...base, profiles, settings: { ...base.settings, ...settings } };
}

export function licenseKey(payload: Partial<LicensePayload> = {}): string {
  return signLicense(
    {
      v: 1,
      lid: 'sub_01',
      plan: 'pro_yearly',
      sub: 'sub_01',
      txn: 'txn_01',
      exp: Math.floor((NOW + 300 * DAY) / 1000),
      iat: Math.floor(NOW / 1000),
      ...payload,
    },
    DEV_LICENSE_PRIVATE_KEY,
  );
}

/** A background wired to a fresh fake chrome, with a controllable clock and fetch. */
export function setup(
  options: { now?: number; fetch?: typeof fetch; revokedLicenses?: string[] } = {},
) {
  const fakeChrome = createChromeFake();
  const clock = { now: options.now ?? NOW };
  const env: Env = {
    chrome: fakeChrome.chrome,
    now: () => clock.now,
    fetch: options.fetch ?? (async () => new Response('{}', { status: 500 })),
    userAgent: 'Mozilla/5.0 Chrome/141.0.0.0',
    config: {
      licensePublicKey: DEV_LICENSE_PUBLIC_KEY,
      revokedLicenses: options.revokedLicenses ?? [],
      apiBase: 'https://headerbench.com',
      version: '1.0.0',
      externalOrigins: ['https://headerbench.com'],
      e2e: false,
    },
    syncDelayMs: 0,
  };
  const bg = createBackground(env);
  async function call<T extends RequestType>(
    req: Extract<Request, { type: T }>,
  ): Promise<ResponseMap[T]> {
    const reply = (await bg.dispatch(req)) as Reply<T>;
    if (!reply.ok) throw new Error(`${reply.code}: ${reply.error}`);
    return reply.data;
  }
  /** Saves a state through the message API, the way the editor does. */
  async function save(state: State): Promise<ResponseMap['saveState']> {
    const { rev } = await call({ type: 'getState' });
    return call({ type: 'saveState', state, rev });
  }
  return { bg, env, clock, call, save, ...fakeChrome };
}
