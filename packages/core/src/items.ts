/**
 * Per-item validation. Each check returns `null` when the item can be compiled, or the reason
 * it cannot. Used by the compiler (to skip with INVALID_ITEM), by importers (to import the item
 * disabled) and by the UI (inline errors). Variables are not substituted here.
 */
import type { BlockRule, HeaderMod, MockRule, Profile, RedirectRule, UrlFilter } from './model.js';
import { checkRegex, checkRegexSubstitution, toRegexSubstitution } from './re2.js';
import { matchesUrlFilter } from './urlfilter.js';
import {
  checkContentType,
  checkDomain,
  checkExactUrl,
  checkHeaderName,
  checkHeaderValue,
  checkTargetUrl,
  checkUrlFilter,
} from './validate.js';
import { usesVariables } from './variables.js';

/** Mock bodies above this many UTF-8 bytes are rejected with MOCK_TOO_LARGE. */
export const MOCK_MAX_BYTES = 64 * 1024;

export function checkHeaderMod(mod: HeaderMod): string | null {
  const name = checkHeaderName(mod.name);
  if (name) return name;
  return mod.op === 'remove' ? null : checkHeaderValue(mod.value);
}

export function checkFilter(filter: UrlFilter): string | null {
  switch (filter.kind) {
    case 'domain':
      return checkDomain(filter.value);
    case 'urlFilter':
      return checkUrlFilter(filter.value);
    case 'regex':
      return checkRegex(filter.value);
  }
}

function checkPattern(kind: 'urlFilter' | 'regex', pattern: string): string | null {
  return kind === 'regex' ? checkRegex(pattern) : checkUrlFilter(pattern);
}

/** Target checks are skipped when the target contains `{{variables}}`; the compiler re-checks after substitution. */
export function checkRedirect(rule: RedirectRule): string | null {
  const from = rule.kind === 'url' ? checkExactUrl(rule.from) : checkPattern(rule.kind, rule.from);
  if (from) return from;
  if (rule.to.trim().length === 0) return 'The redirect target is empty.';
  if (rule.kind !== 'regex' && usesVariables(rule.to)) return null;
  return checkRedirectTarget(rule, rule.to);
}

/**
 * Checks a resolved redirect target: for regex redirects, that every `$N` names a capture group;
 * otherwise a valid URL that does not redirect to itself.
 */
export function checkRedirectTarget(rule: RedirectRule, target: string): string | null {
  if (rule.kind === 'regex') {
    return checkRegexSubstitution(rule.from, toRegexSubstitution(target));
  }
  const invalid = checkTargetUrl(target);
  if (invalid) return invalid;
  const loops =
    rule.kind === 'url'
      ? new URL(target).href === new URL(rule.from).href
      : matchesUrlFilter(rule.from, target);
  return loops ? 'The target matches the source, so the redirect would loop forever.' : null;
}

export function checkBlock(rule: BlockRule): string | null {
  return checkPattern(rule.kind, rule.pattern);
}

export function checkMock(rule: MockRule): string | null {
  return checkPattern(rule.kind, rule.pattern) ?? checkContentType(rule.contentType);
}

export interface ItemIssue {
  itemId: string;
  message: string;
}

/** Every invalid item in a profile, enabled or not, for inline UI messages. */
export function profileIssues(profile: Profile): ItemIssue[] {
  const issues: ItemIssue[] = [];
  const add = (itemId: string, message: string | null): void => {
    if (message) issues.push({ itemId, message });
  };
  for (const mod of [...profile.requestHeaders, ...profile.responseHeaders]) {
    add(mod.id, checkHeaderMod(mod));
  }
  for (const filter of profile.filters) add(filter.id, checkFilter(filter));
  for (const rule of profile.redirects) add(rule.id, checkRedirect(rule));
  for (const rule of profile.blocks) add(rule.id, checkBlock(rule));
  for (const rule of profile.mocks) add(rule.id, checkMock(rule));
  return issues;
}
