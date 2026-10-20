import type {
  Activation,
  BlockRule,
  HeaderMod,
  MockRule,
  Profile,
  RedirectRule,
  State,
  UrlFilter,
} from '../src/index.js';
import { defaultState } from '../src/index.js';

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${++counter}`;

export function resetIds(): void {
  counter = 0;
}

export function header(
  name: string,
  value: string,
  op: HeaderMod['op'] = 'set',
  extra: Partial<HeaderMod> = {},
): HeaderMod {
  return { id: nextId('h'), enabled: true, name, value, op, comment: '', ...extra };
}

export function filter(
  kind: UrlFilter['kind'],
  value: string,
  exclude = false,
  extra: Partial<UrlFilter> = {},
): UrlFilter {
  return { id: nextId('f'), enabled: true, kind, value, exclude, ...extra };
}

export function redirect(
  kind: RedirectRule['kind'],
  from: string,
  to: string,
  extra: Partial<RedirectRule> = {},
): RedirectRule {
  return { id: nextId('r'), enabled: true, kind, from, to, comment: '', ...extra };
}

export function block(kind: BlockRule['kind'], pattern: string): BlockRule {
  return { id: nextId('b'), enabled: true, kind, pattern, comment: '' };
}

export function mock(
  kind: MockRule['kind'],
  pattern: string,
  body: string,
  contentType = 'application/json',
): MockRule {
  return { id: nextId('m'), enabled: true, kind, pattern, contentType, body, comment: '' };
}

export function profile(name: string, extra: Partial<Profile> = {}): Profile {
  return {
    id: `p-${name.toLowerCase().replace(/\W+/g, '-')}`,
    name,
    badge: name.slice(0, 1).toUpperCase(),
    color: '#1a73e8',
    env: 'none',
    requestHeaders: [],
    responseHeaders: [],
    filters: [],
    resourceTypes: [],
    methods: [],
    redirects: [],
    blocks: [],
    mocks: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...extra,
  };
}

/** A state where every given profile is active in the given order (globally), unless activations are passed. */
export function stateWith(profiles: Profile[], activations?: Activation[]): State {
  const base = defaultState();
  return {
    ...base,
    profiles,
    settings: {
      ...base.settings,
      activations:
        activations ?? profiles.map((p) => ({ profileId: p.id, tabId: null, pauseAt: null })),
    },
  };
}

export const NOW = 1_760_000_000_000;
export const FREE = { pro: false, now: NOW };
export const PRO = { pro: true, now: NOW };
