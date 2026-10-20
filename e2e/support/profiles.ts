/** Small builders for complete `Profile` objects, on top of core's factories. */
import type {
  BlockRule,
  HeaderMod,
  MockRule,
  Profile,
  RedirectRule,
  UrlFilter,
} from '@headerbench/core';
import { newHeaderMod, newId, newProfile } from '@headerbench/core';

type HeaderSpec =
  [name: string, value: string] | [name: string, value: string, op: HeaderMod['op']];

export function headers(...specs: HeaderSpec[]): HeaderMod[] {
  return specs.map(([name, value, op = 'set']) => newHeaderMod({ name, value, op }));
}

export function filter(kind: UrlFilter['kind'], value: string, exclude = false): UrlFilter {
  return { id: newId(), enabled: true, kind, value, exclude };
}

export function redirect(kind: RedirectRule['kind'], from: string, to: string): RedirectRule {
  return { id: newId(), enabled: true, kind, from, to, comment: '' };
}

export function block(kind: BlockRule['kind'], pattern: string): BlockRule {
  return { id: newId(), enabled: true, kind, pattern, comment: '' };
}

export function mock(pattern: string, body: string, contentType = 'application/json'): MockRule {
  return { id: newId(), enabled: true, kind: 'urlFilter', pattern, contentType, body, comment: '' };
}

export function profile(name: string, parts: Partial<Omit<Profile, 'id' | 'name'>> = {}): Profile {
  return { ...newProfile({ name }), ...parts };
}
