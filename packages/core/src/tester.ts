/**
 * "Test a URL": simulates the compiled rules against one request with DNR's evaluation order,
 * so the UI can say what would apply and why something would not.
 */
import type { CompileContext, RuleKind, RuleSource, Warning } from './compile.js';
import { compile } from './compile.js';
import type { DnrRule, DnrRuleCondition } from './dnr.js';
import type { Method, Profile, ResourceType, State } from './model.js';
import { pageOrigin } from './origins.js';
import { canonicalUrl, hostMatchesDomain, matchesUrlFilter } from './urlfilter.js';

export interface TestRequest {
  url: string;
  resourceType: ResourceType;
  method: Method;
  /** The tab the request comes from. Tab-scoped rules only match when this equals their tab. */
  tabId?: number;
  /** The page that sends the request (Chrome's "initiator"). Omit for typed-in navigations. */
  initiator?: string;
  /**
   * Whether Headerbench has host access to a URL. Chrome applies header and redirect rules only
   * when both the request URL and its http(s) initiator are granted. Omit to assume access.
   */
  hasHostAccess?: (url: string) => boolean;
}

export type Effect =
  | {
      type: 'header';
      direction: 'request' | 'response';
      header: string;
      operation: 'set' | 'append' | 'remove';
      value?: string;
    }
  | { type: 'block' }
  | { type: 'redirect'; to: string }
  | { type: 'mock'; contentType: string; bytes: number }
  | { type: 'exclude' };

export interface Match {
  profileId: string;
  profileName: string;
  list: 'dynamic' | 'session';
  ruleId: number;
  kind: RuleKind;
  itemId: string | null;
  effect: Effect;
  applied: boolean;
  /** Why it does not apply; `null` when applied. */
  reason: string | null;
  warnings: Warning[];
}

interface Candidate {
  rule: DnrRule;
  source: RuleSource;
  profile: Profile;
}

/** DNR breaks priority ties in this order: allow, block, redirect, then modifyHeaders. */
const ACTION_RANK: Record<DnrRule['action']['type'], number> = {
  allow: 3,
  block: 2,
  redirect: 1,
  modifyHeaders: 0,
};

function conditionMatches(
  c: DnrRuleCondition,
  url: string,
  host: string,
  req: TestRequest,
): boolean {
  if (
    c.urlFilter !== undefined &&
    !matchesUrlFilter(c.urlFilter, url, c.isUrlFilterCaseSensitive)
  ) {
    return false;
  }
  if (
    c.regexFilter !== undefined &&
    !new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i').test(url)
  ) {
    return false;
  }
  if (c.requestDomains && !c.requestDomains.some((d) => hostMatchesDomain(host, d))) return false;
  if (c.excludedRequestDomains?.some((d) => hostMatchesDomain(host, d))) return false;
  if (c.resourceTypes && !c.resourceTypes.includes(req.resourceType)) return false;
  if (c.requestMethods && !c.requestMethods.includes(req.method)) return false;
  if (c.tabIds && (req.tabId === undefined || !c.tabIds.includes(req.tabId))) return false;
  return true;
}

/** Applies a DNR regexSubstitution (`\1`, `\\`) to the first match, as Chrome does. */
function applySubstitution(url: string, regexFilter: string, substitution: string): string {
  const match = new RegExp(regexFilter, 'i').exec(url);
  if (!match) return url;
  const replacement = substitution.replace(/\\(\\|\d)/g, (_, c: string) =>
    c === '\\' ? '\\' : (match[Number(c)] ?? ''),
  );
  return url.slice(0, match.index) + replacement + url.slice(match.index + match[0].length);
}

function byPriority(a: Candidate, b: Candidate): number {
  return (
    b.rule.priority - a.rule.priority ||
    ACTION_RANK[b.rule.action.type] - ACTION_RANK[a.rule.action.type] ||
    a.source.activationIndex - b.source.activationIndex
  );
}

interface HeaderState {
  operation: 'set' | 'append' | 'remove';
  priority: number;
  ruleKey: string;
  profileName: string;
}

export function testUrl(state: State, ctx: CompileContext, req: TestRequest): Match[] {
  const url = canonicalUrl(req.url);
  if (url === null) return [];
  const host = new URL(url).hostname;
  const compiled = compile(state, ctx);
  if (!compiled.ok) return [];

  const profiles = new Map(state.profiles.map((p) => [p.id, p]));
  const rulesByKey = new Map<string, DnrRule>();
  for (const rule of compiled.dynamic) rulesByKey.set(`dynamic:${rule.id}`, rule);
  for (const rule of compiled.session) rulesByKey.set(`session:${rule.id}`, rule);

  const candidates: Candidate[] = compiled.sources
    .map((source) => ({
      source,
      rule: rulesByKey.get(`${source.list}:${source.ruleId}`) as DnrRule,
      profile: profiles.get(source.profileId) as Profile,
    }))
    .filter((c) => conditionMatches(c.rule.condition, url, host, req))
    .sort(byPriority);

  const noAccessReason = accessProblem(req, url, host);
  const noAccess = noAccessReason !== null;
  const needsAccess = (c: Candidate): boolean =>
    c.rule.action.type === 'redirect' || c.rule.action.type === 'modifyHeaders';
  const terminal = candidates.find(
    (c) => c.rule.action.type !== 'modifyHeaders' && !(noAccess && needsAccess(c)),
  );

  const warningsFor = (profileId: string, itemId: string | null): Warning[] =>
    compiled.warnings.filter(
      (w) => w.profileId === profileId && itemId !== null && w.itemIds.includes(itemId),
    );
  const base = (
    c: Candidate,
    itemId: string | null,
  ): Omit<Match, 'effect' | 'applied' | 'reason'> => ({
    profileId: c.profile.id,
    profileName: c.profile.name,
    list: c.source.list,
    ruleId: c.rule.id,
    kind: c.source.kind,
    itemId,
    warnings: warningsFor(c.profile.id, itemId),
  });
  const terminalReason = (): string => {
    if (!terminal) return '';
    const name = terminal.profile.name;
    switch (terminal.rule.action.type) {
      case 'allow':
        return `Excluded by an exclude pattern in "${name}".`;
      case 'block':
        return `The request is blocked by "${name}" first.`;
      default:
        return `The request is redirected by "${name}" first.`;
    }
  };

  const matches: Match[] = [];
  const headers = new Map<string, HeaderState>();
  for (const c of candidates) {
    const action = c.rule.action;
    if (action.type !== 'modifyHeaders') {
      const itemId = c.source.itemIds[0] ?? null;
      const applied = c === terminal;
      const reason = applied
        ? null
        : noAccess && needsAccess(c)
          ? noAccessReason
          : terminalReason();
      matches.push({ ...base(c, itemId), effect: terminalEffect(c, url, itemId), applied, reason });
      continue;
    }
    const blockedBy =
      terminal &&
      (terminal.rule.action.type !== 'allow' || terminal.rule.priority >= c.rule.priority)
        ? terminalReason()
        : null;
    const ops = [
      ...(action.requestHeaders ?? []).map((op) => ({ op, direction: 'request' as const })),
      ...(action.responseHeaders ?? []).map((op) => ({ op, direction: 'response' as const })),
    ];
    ops.forEach(({ op, direction }, i) => {
      const itemId = c.source.itemIds[i] ?? null;
      const effect: Effect = {
        type: 'header',
        direction,
        header: headerLabel(c.profile, itemId, op.header),
        operation: op.operation,
        ...(op.value !== undefined ? { value: op.value } : {}),
      };
      let reason = noAccessReason ?? blockedBy;
      if (reason === null) {
        const key = `${direction}:${op.header.toLowerCase()}`;
        const ruleKey = `${c.source.list}:${c.rule.id}`;
        const prev = headers.get(key);
        reason = prev ? conflictReason(prev, op.operation, c.rule.priority, ruleKey) : null;
        if (reason === null && !prev) {
          headers.set(key, {
            operation: op.operation,
            priority: c.rule.priority,
            ruleKey,
            profileName: c.profile.name,
          });
        }
      }
      matches.push({ ...base(c, itemId), effect, applied: reason === null, reason });
    });
  }
  return matches;
}

/**
 * The header name as the user typed it. Compiled request ops use lowercase names (Chrome requires
 * that for `append`), which reads worse in the UI.
 */
export function headerLabel(profile: Profile, itemId: string | null, fallback: string): string {
  if (itemId === null) return fallback;
  const mod = [...profile.requestHeaders, ...profile.responseHeaders].find((m) => m.id === itemId);
  return mod?.name ?? fallback;
}

/** Why Chrome would skip header and redirect rules for lack of host access, or null. */
function accessProblem(req: TestRequest, url: string, host: string): string | null {
  const granted = req.hasHostAccess;
  if (!granted) return null;
  if (!granted(url)) return `No site access for ${host}. Grant access so Chrome applies this rule.`;
  if (
    req.initiator !== undefined &&
    pageOrigin(req.initiator) !== null &&
    !granted(req.initiator)
  ) {
    return `Chrome needs access to the page that sends this request (${new URL(req.initiator).origin}).`;
  }
  return null;
}

/**
 * Chrome: after a remove, nothing else applies; after a set, only lower-priority rules (or later
 * ops in the same rule) may append; after an append, only appends.
 */
function conflictReason(
  prev: HeaderState,
  operation: 'set' | 'append' | 'remove',
  priority: number,
  ruleKey: string,
): string | null {
  const by = `"${prev.profileName}"`;
  if (prev.operation === 'remove') return `Already removed by ${by}, which has higher priority.`;
  if (
    operation === 'append' &&
    (prev.operation === 'append' || prev.priority > priority || prev.ruleKey === ruleKey)
  ) {
    return null;
  }
  return `Overridden by ${by}, which has higher priority.`;
}

function terminalEffect(c: Candidate, url: string, itemId: string | null): Effect {
  const action = c.rule.action;
  if (action.type === 'block') return { type: 'block' };
  if (action.type === 'allow') return { type: 'exclude' };
  if (c.source.kind === 'mock') {
    const mock = c.profile.mocks.find((m) => m.id === itemId);
    const body = (action.redirect?.url ?? '').split(',')[1] ?? '';
    return {
      type: 'mock',
      contentType: mock?.contentType ?? '',
      bytes: Math.floor((body.replace(/=+$/, '').length * 3) / 4),
    };
  }
  const redirect = action.redirect ?? {};
  const to =
    redirect.regexSubstitution !== undefined && c.rule.condition.regexFilter !== undefined
      ? applySubstitution(url, c.rule.condition.regexFilter, redirect.regexSubstitution)
      : (redirect.url ?? '');
  return { type: 'redirect', to };
}
