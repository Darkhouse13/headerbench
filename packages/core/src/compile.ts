/**
 * Compiles Headerbench state into declarativeNetRequest rules. Pure and deterministic.
 * Normative spec: docs/blueprint/ARCHITECTURE.md "Compiler".
 */
import type { DnrModifyHeaderInfo, DnrRule, DnrRuleCondition } from './dnr.js';
import { DNR_LIMITS } from './dnr.js';
import { base64Encode, utf8Encode } from './encoding.js';
import {
  MOCK_MAX_BYTES,
  checkBlock,
  checkFilter,
  checkHeaderMod,
  checkMock,
  checkRedirect,
  checkRedirectTarget,
} from './items.js';
import type {
  Activation,
  HeaderMod,
  MockRule,
  Profile,
  RedirectRule,
  ResourceType,
  State,
  Variable,
} from './model.js';
import { RESOURCE_TYPES } from './model.js';
import { checkHeaderValue, isAppendableRequestHeader, normalizeDomain } from './validate.js';
import { substituteVariables, usesVariables } from './variables.js';

export type WarningCode =
  | 'EXCLUDE_ALLOW_SCOPE'
  | 'APPEND_NOT_ALLOWED'
  | 'VARIABLE_UNRESOLVED'
  | 'PRO_PAUSED'
  | 'INVALID_ITEM'
  | 'MOCK_TOO_LARGE'
  | 'RULE_BUDGET';

export interface Warning {
  code: WarningCode;
  /** `error` means the item (or, for RULE_BUDGET, the whole compile) was not applied. */
  severity: 'warning' | 'error';
  message: string;
  profileId: string | null;
  itemIds: string[];
}

export interface CompileContext {
  pro: boolean;
  /** Milliseconds since epoch. */
  now: number;
}

export type RuleKind = 'headers' | 'exclude' | 'block' | 'redirect' | 'mock';

/** Where a compiled rule came from, so the UI can explain matched rule ids. */
export interface RuleSource {
  list: 'dynamic' | 'session';
  ruleId: number;
  profileId: string;
  /** Index into the active activations (0 = highest priority). */
  activationIndex: number;
  kind: RuleKind;
  /** For `headers` rules: one id per header op, request ops first, then response ops. */
  itemIds: string[];
}

export interface CompileStats {
  dynamic: number;
  session: number;
  /** modifyHeaders + redirect rules, the ones Chrome counts as "unsafe". Max of both lists. */
  unsafe: number;
  regex: number;
}

export interface CompileResult {
  /** False when RULE_BUDGET was hit: the caller must keep the rules it already has. */
  ok: boolean;
  dynamic: DnrRule[];
  session: DnrRule[];
  warnings: Warning[];
  sources: RuleSource[];
  stats: CompileStats;
}

/** Resource types a mock can serve. Chrome blocks top-level `data:` navigation, so no frames. */
export const MOCK_RESOURCE_TYPES: readonly ResourceType[] = [
  'xmlhttprequest',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'other',
];

/** Priority offsets inside a profile's band of 10. */
export const PRIORITY_OFFSET = { headers: 0, block: 2, redirect: 3, mock: 4, exclude: 9 } as const;

export function activeActivations(state: State, now: number): Activation[] {
  const ids = new Set(state.profiles.map((p) => p.id));
  return state.settings.activations.filter(
    (a) => ids.has(a.profileId) && (a.pauseAt === null || a.pauseAt > now),
  );
}

/** `$1` → `\1` for DNR regexSubstitution; a literal backslash is escaped. */
export function toRegexSubstitution(target: string): string {
  return target.replace(/\\/g, '\\\\').replace(/\$(\d)/g, '\\$1');
}

const TEXTUAL_TYPE = /^(text\/|application\/(json|javascript|xml|[\w.+-]+\+(json|xml))\b)/i;

export function mockDataUrl(contentType: string, body: string): string {
  let mediaType = contentType.replace(/\s+/g, '');
  if (TEXTUAL_TYPE.test(mediaType) && !/;charset=/i.test(mediaType)) {
    mediaType += ';charset=utf-8';
  }
  return `data:${mediaType};base64,${base64Encode(utf8Encode(body))}`;
}

class Compiler {
  readonly dynamic: DnrRule[] = [];
  readonly session: DnrRule[] = [];
  readonly sources: RuleSource[] = [];
  private readonly warnings = new Map<string, Warning>();

  constructor(
    private readonly ctx: CompileContext,
    private readonly variables: readonly Variable[],
  ) {}

  warn(
    code: WarningCode,
    profileId: string | null,
    itemIds: string[],
    message: string,
    severity: Warning['severity'] = 'warning',
  ): void {
    const key = `${code}|${profileId}|${itemIds.join(',')}|${message}`;
    if (!this.warnings.has(key))
      this.warnings.set(key, { code, severity, message, profileId, itemIds });
  }

  allWarnings(): Warning[] {
    return [...this.warnings.values()];
  }

  add(
    tabId: number | null,
    source: Omit<RuleSource, 'list' | 'ruleId'>,
    rule: Omit<DnrRule, 'id'>,
  ): void {
    const list = tabId === null ? 'dynamic' : 'session';
    const target = list === 'dynamic' ? this.dynamic : this.session;
    const id = target.length + 1;
    const condition = tabId === null ? rule.condition : { ...rule.condition, tabIds: [tabId] };
    target.push({ id, priority: rule.priority, action: rule.action, condition });
    this.sources.push({ list, ruleId: id, ...source });
  }

  /** Substitutes variables when Pro is on; otherwise keeps the literal and warns. */
  resolve(text: string, profileId: string, itemId: string): string {
    if (!usesVariables(text)) return text;
    if (!this.ctx.pro) {
      this.warn(
        'VARIABLE_UNRESOLVED',
        profileId,
        [itemId],
        'Variables need Pro. The {{name}} text is sent as written.',
      );
      return text;
    }
    const { text: out, unresolved } = substituteVariables(text, this.variables);
    if (unresolved.length > 0) {
      this.warn(
        'VARIABLE_UNRESOLVED',
        profileId,
        [itemId],
        `Unknown variable ${unresolved.map((n) => `{{${n}}}`).join(', ')}. The text is sent as written.`,
      );
    }
    return out;
  }

  profile(profile: Profile, activation: Activation, index: number, base: number): void {
    const proPaused: string[] = [];
    this.headerRules(profile, activation, index, base);
    for (const block of profile.blocks) {
      if (!block.enabled) continue;
      const invalid = checkBlock(block);
      if (invalid) {
        this.warn('INVALID_ITEM', profile.id, [block.id], invalid, 'error');
        continue;
      }
      this.add(
        activation.tabId,
        { profileId: profile.id, activationIndex: index, kind: 'block', itemIds: [block.id] },
        {
          priority: base + PRIORITY_OFFSET.block,
          action: { type: 'block' },
          condition: {
            ...patternCondition(block.kind, block.pattern),
            resourceTypes: [...RESOURCE_TYPES],
          },
        },
      );
    }
    for (const redirect of profile.redirects) {
      if (!redirect.enabled) continue;
      // A {{variable}} target is not a URL until substituted, so it waits for Pro too.
      if (!this.ctx.pro && (redirect.kind === 'regex' || usesVariables(redirect.to))) {
        proPaused.push(redirect.id);
        continue;
      }
      this.redirectRule(profile, redirect, activation, index, base);
    }
    for (const mock of profile.mocks) {
      if (!mock.enabled) continue;
      if (!this.ctx.pro) {
        proPaused.push(mock.id);
        continue;
      }
      this.mockRule(profile, mock, activation, index, base);
    }
    if (proPaused.length > 0) {
      this.warn(
        'PRO_PAUSED',
        profile.id,
        proPaused,
        `${proPaused.length} Pro ${proPaused.length === 1 ? 'rule is' : 'rules are'} paused. They resume when Pro is active.`,
      );
    }
  }

  private headerOps(
    profile: Profile,
    mods: HeaderMod[],
    direction: 'request' | 'response',
  ): { ops: DnrModifyHeaderInfo[]; ids: string[] } {
    const ops: DnrModifyHeaderInfo[] = [];
    const ids: string[] = [];
    const replaced = new Set<string>();
    for (const mod of mods) {
      if (!mod.enabled) continue;
      const invalid = checkHeaderMod(mod);
      if (invalid) {
        this.warn('INVALID_ITEM', profile.id, [mod.id], invalid, 'error');
        continue;
      }
      const key = mod.name.toLowerCase();
      // Chrome rejects a mixed-case request-header `append` (and with it the whole rule), so request
      // ops always use the lowercase name; HTTP header names are case-insensitive.
      const header = direction === 'request' ? key : mod.name;
      let op = mod.op;
      if (op === 'append' && direction === 'request' && !isAppendableRequestHeader(mod.name)) {
        this.warn(
          'APPEND_NOT_ALLOWED',
          profile.id,
          [mod.id],
          `Chrome cannot append to the ${mod.name} request header, so it is set instead.`,
        );
        op = 'set';
      }
      if (op !== 'append') {
        if (replaced.has(key)) {
          this.warn(
            'INVALID_ITEM',
            profile.id,
            [mod.id],
            `An earlier row already sets or removes ${mod.name} in this profile. The first row wins.`,
            'error',
          );
          continue;
        }
        replaced.add(key);
      }
      if (op === 'remove') {
        ops.push({ header, operation: 'remove' });
        ids.push(mod.id);
        continue;
      }
      const value = this.resolve(mod.value, profile.id, mod.id);
      const badValue = checkHeaderValue(value);
      if (badValue) {
        this.warn('INVALID_ITEM', profile.id, [mod.id], `After variables: ${badValue}`, 'error');
        continue;
      }
      ops.push({ header, operation: op, value });
      ids.push(mod.id);
    }
    return { ops, ids };
  }

  private headerRules(profile: Profile, activation: Activation, index: number, base: number): void {
    const { ops: request, ids: requestIds } = this.headerOps(
      profile,
      profile.requestHeaders,
      'request',
    );
    const { ops: response, ids: responseIds } = this.headerOps(
      profile,
      profile.responseHeaders,
      'response',
    );
    const filters = profile.filters.filter((f) => {
      if (!f.enabled) return false;
      const invalid = checkFilter(f);
      if (invalid) this.warn('INVALID_ITEM', profile.id, [f.id], invalid, 'error');
      return invalid === null;
    });
    if (request.length === 0 && response.length === 0) return;

    const includes = filters.filter((f) => !f.exclude);
    const hadIncludes = profile.filters.some((f) => f.enabled && !f.exclude);
    if (hadIncludes && includes.length === 0) {
      // Never widen a scoped profile to all URLs because its filters are broken.
      return;
    }
    const excludedDomains = filters
      .filter((f) => f.exclude && f.kind === 'domain')
      .map((f) => normalizeDomain(f.value) as string);
    const common: DnrRuleCondition = {
      resourceTypes:
        profile.resourceTypes.length > 0 ? unique(profile.resourceTypes) : [...RESOURCE_TYPES],
      ...(profile.methods.length > 0 ? { requestMethods: unique(profile.methods) } : {}),
    };
    const action = {
      type: 'modifyHeaders' as const,
      ...(request.length > 0 ? { requestHeaders: request } : {}),
      ...(response.length > 0 ? { responseHeaders: response } : {}),
    };
    // Aligned with the ops: request ops first, then response ops.
    const itemIds = [...requestIds, ...responseIds];
    const conditions = includes.length > 0 ? includes.map(filterCondition) : [{}];
    for (const condition of conditions) {
      this.add(
        activation.tabId,
        { profileId: profile.id, activationIndex: index, kind: 'headers', itemIds },
        {
          priority: base + PRIORITY_OFFSET.headers,
          action,
          condition: {
            ...condition,
            ...common,
            ...(excludedDomains.length > 0
              ? { excludedRequestDomains: unique(excludedDomains) }
              : {}),
          },
        },
      );
    }
    for (const exclude of filters.filter((f) => f.exclude && f.kind !== 'domain')) {
      this.add(
        activation.tabId,
        { profileId: profile.id, activationIndex: index, kind: 'exclude', itemIds: [exclude.id] },
        {
          priority: base + PRIORITY_OFFSET.exclude,
          action: { type: 'allow' },
          condition: { ...filterCondition(exclude), ...common },
        },
      );
      this.warn(
        'EXCLUDE_ALLOW_SCOPE',
        profile.id,
        [exclude.id],
        'Exclude patterns also pause lower-priority profiles on matching URLs. Use a domain exclude to affect only this profile.',
      );
    }
  }

  private redirectRule(
    profile: Profile,
    redirect: RedirectRule,
    activation: Activation,
    index: number,
    base: number,
  ): void {
    const invalid = checkRedirect(redirect);
    if (invalid) {
      this.warn('INVALID_ITEM', profile.id, [redirect.id], invalid, 'error');
      return;
    }
    const to = this.resolve(redirect.to, profile.id, redirect.id);
    const badTarget = checkRedirectTarget(redirect, to);
    if (badTarget) {
      this.warn('INVALID_ITEM', profile.id, [redirect.id], badTarget, 'error');
      return;
    }
    const condition: DnrRuleCondition =
      redirect.kind === 'url'
        ? { urlFilter: `|${exactUrlFilterTarget(redirect.from)}|` }
        : patternCondition(redirect.kind, redirect.from);
    this.add(
      activation.tabId,
      { profileId: profile.id, activationIndex: index, kind: 'redirect', itemIds: [redirect.id] },
      {
        priority: base + PRIORITY_OFFSET.redirect,
        action: {
          type: 'redirect',
          redirect:
            redirect.kind === 'regex'
              ? { regexSubstitution: toRegexSubstitution(to) }
              : { url: to },
        },
        condition: { ...condition, resourceTypes: [...RESOURCE_TYPES] },
      },
    );
  }

  private mockRule(
    profile: Profile,
    mock: MockRule,
    activation: Activation,
    index: number,
    base: number,
  ): void {
    const invalid = checkMock(mock);
    if (invalid) {
      this.warn('INVALID_ITEM', profile.id, [mock.id], invalid, 'error');
      return;
    }
    const body = this.resolve(mock.body, profile.id, mock.id);
    const size = utf8Encode(body).length;
    if (size > MOCK_MAX_BYTES) {
      this.warn(
        'MOCK_TOO_LARGE',
        profile.id,
        [mock.id],
        `The mock body is ${Math.ceil(size / 1024)} KB. The limit is ${MOCK_MAX_BYTES / 1024} KB.`,
        'error',
      );
      return;
    }
    this.add(
      activation.tabId,
      { profileId: profile.id, activationIndex: index, kind: 'mock', itemIds: [mock.id] },
      {
        priority: base + PRIORITY_OFFSET.mock,
        action: { type: 'redirect', redirect: { url: mockDataUrl(mock.contentType, body) } },
        condition: {
          ...patternCondition(mock.kind, mock.pattern),
          resourceTypes: [...MOCK_RESOURCE_TYPES],
        },
      },
    );
  }
}

/**
 * The form Chrome matches an exact-URL redirect against: the canonical URL (lowercase host,
 * default port dropped, `/` path for a bare origin, non-ASCII percent-encoded), without the
 * fragment, which never reaches the network.
 */
export function exactUrlFilterTarget(from: string): string {
  const url = new URL(from.trim());
  url.hash = '';
  return url.href;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function patternCondition(kind: 'urlFilter' | 'regex', pattern: string): DnrRuleCondition {
  return kind === 'regex' ? { regexFilter: pattern } : { urlFilter: pattern };
}

function filterCondition(filter: { kind: string; value: string }): DnrRuleCondition {
  if (filter.kind === 'domain')
    return { requestDomains: [normalizeDomain(filter.value) as string] };
  return patternCondition(filter.kind as 'urlFilter' | 'regex', filter.value);
}

function countStats(dynamic: DnrRule[], session: DnrRule[]): CompileStats {
  const unsafe = (rules: DnrRule[]): number =>
    rules.filter((r) => r.action.type === 'modifyHeaders' || r.action.type === 'redirect').length;
  return {
    dynamic: dynamic.length,
    session: session.length,
    unsafe: Math.max(unsafe(dynamic), unsafe(session)),
    regex: [...dynamic, ...session].filter((r) => r.condition.regexFilter !== undefined).length,
  };
}

const EMPTY_STATS: CompileStats = { dynamic: 0, session: 0, unsafe: 0, regex: 0 };

export function compile(state: State, ctx: CompileContext): CompileResult {
  if (state.settings.paused) {
    return { ok: true, dynamic: [], session: [], warnings: [], sources: [], stats: EMPTY_STATS };
  }
  const compiler = new Compiler(ctx, state.settings.variables);
  const byId = new Map(state.profiles.map((p) => [p.id, p]));
  const active = activeActivations(state, ctx.now);
  active.forEach((activation, index) => {
    const profile = byId.get(activation.profileId) as Profile;
    compiler.profile(profile, activation, index, (active.length - index) * 10);
  });

  const stats = countStats(compiler.dynamic, compiler.session);
  const warnings = compiler.allWarnings();
  if (stats.unsafe > DNR_LIMITS.maxUnsafeRules || stats.regex > DNR_LIMITS.maxRegexRules) {
    warnings.unshift({
      code: 'RULE_BUDGET',
      severity: 'error',
      message:
        `Too many rules for Chrome: ${stats.unsafe} header/redirect rules (limit ${DNR_LIMITS.maxUnsafeRules}) ` +
        `and ${stats.regex} regex rules (limit ${DNR_LIMITS.maxRegexRules}). The previous rules stay in place.`,
      profileId: null,
      itemIds: [],
    });
    return { ok: false, dynamic: [], session: [], warnings, sources: [], stats };
  }
  return {
    ok: true,
    dynamic: compiler.dynamic,
    session: compiler.session,
    warnings,
    sources: compiler.sources,
    stats,
  };
}
