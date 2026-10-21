/**
 * Installs compiled rules: the dynamic list first, then the session list, each replaced
 * atomically. When Chrome rejects one rule (it names the rule id in its error), that rule is
 * handled and the update retried:
 * - a `headers` rule carrying several header names is split into one rule per header name (same
 *   priority and condition, fresh ids above the list's highest), so the retry pins the rejection
 *   on the one bad row;
 * - when a second part of the same split rule is rejected, the fault is the shared condition, not
 *   a header: all its remaining parts are dropped at once;
 * - any other rule is dropped.
 * Each dropped rule or part is reported once, as an INVALID_ITEM error for its own items. The rest
 * are installed. At most `MAX_REJECTED_RULES` compiled rules may be refused per list (a split
 * rule counts once, whatever its parts cost). If the dynamic list cannot be installed at all, the
 * session list is left untouched and the error returned; either way the failed list keeps its
 * previous rules.
 */
import type { CompileResult, DnrRule, RuleSource, Warning } from '@headerbench/core';

type Dnr = Pick<
  typeof chrome.declarativeNetRequest,
  'getDynamicRules' | 'updateDynamicRules' | 'getSessionRules' | 'updateSessionRules'
>;

/** A rule installed in place of a compiled one that was split, with its source. */
export interface SplitRule {
  rule: DnrRule;
  source: RuleSource;
}

export interface InstallOutcome {
  /** Items Chrome refused, reported as INVALID_ITEM errors. */
  rejected: Warning[];
  /** A failure that left the previous rules in place, or null. */
  error: string | null;
  /** Rules installed in addition to the compiled ones (parts of split header rules). */
  split: SplitRule[];
}

/** Chrome reports the offending rule as e.g. "Rule with id 3 specified a non-supported regex." */
const RULE_ID = /rule with id (\d+)/i;
/** Compiled rules Chrome may refuse in one list before Headerbench gives up on the update. */
export const MAX_REJECTED_RULES = 20;
/** Rejected parts of one split rule that show its condition, not a header, is the problem. */
const PART_REJECTIONS_TO_DROP_RULE = 2;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HeaderOp = NonNullable<DnrRule['action']['requestHeaders']>[number];

/** One rule per header name (per direction), or null when the rule has only one name. */
function splitHeaderRule(rule: DnrRule, source: RuleSource, firstId: number): SplitRule[] | null {
  const groups = new Map<string, { request: HeaderOp[]; response: HeaderOp[]; ids: string[] }>();
  const add = (direction: 'request' | 'response', op: HeaderOp, itemId: string | undefined) => {
    const key = `${direction}:${op.header.toLowerCase()}`;
    const group = groups.get(key) ?? { request: [], response: [], ids: [] };
    group[direction].push(op);
    if (itemId !== undefined) group.ids.push(itemId);
    groups.set(key, group);
  };
  const request = rule.action.requestHeaders ?? [];
  const response = rule.action.responseHeaders ?? [];
  request.forEach((op, i) => add('request', op, source.itemIds[i]));
  response.forEach((op, i) => add('response', op, source.itemIds[request.length + i]));
  if (groups.size < 2) return null;
  return [...groups.values()].map((group, i) => {
    const id = firstId + i;
    return {
      rule: {
        id,
        priority: rule.priority,
        condition: rule.condition,
        action: {
          type: 'modifyHeaders',
          ...(group.request.length > 0 ? { requestHeaders: group.request } : {}),
          ...(group.response.length > 0 ? { responseHeaders: group.response } : {}),
        },
      },
      source: { ...source, ruleId: id, itemIds: group.ids },
    };
  });
}

function invalidItem(source: RuleSource, message: string): Warning {
  return {
    code: 'INVALID_ITEM',
    severity: 'error',
    message: `Chrome rejected this rule: ${message}`,
    profileId: source.profileId,
    itemIds: source.itemIds,
  };
}

async function replaceList(
  list: 'dynamic' | 'session',
  dnr: Dnr,
  rules: DnrRule[],
  sources: RuleSource[],
  rejected: Warning[],
  split: SplitRule[],
): Promise<string | null> {
  const existing = list === 'dynamic' ? await dnr.getDynamicRules() : await dnr.getSessionRules();
  const removeRuleIds = existing.map((r) => r.id);
  const byId = new Map(sources.filter((s) => s.list === list).map((s) => [s.ruleId, s]));
  const compiledIds = new Set(rules.map((r) => r.id));
  /** Part rule id → the compiled rule it was split from. */
  const parentOf = new Map<number, number>();
  /** Compiled rule id → how many of its parts Chrome refused. */
  const partRejections = new Map<number, number>();
  /** Compiled rules Chrome refused (whole or in part). */
  const refused = new Set<number>();
  let nextId = Math.max(0, ...rules.map((r) => r.id)) + 1;
  let pending = rules;
  const drop = (ids: ReadonlySet<number>, message: string) => {
    for (const rule of pending) {
      const source = byId.get(rule.id);
      if (ids.has(rule.id) && source) rejected.push(invalidItem(source, message));
    }
    pending = pending.filter((r) => !ids.has(r.id));
    for (const id of ids) byId.delete(id);
  };
  for (;;) {
    const options = {
      removeRuleIds,
      addRules: pending as unknown as chrome.declarativeNetRequest.Rule[],
    };
    try {
      if (list === 'dynamic') await dnr.updateDynamicRules(options);
      else await dnr.updateSessionRules(options);
      for (const rule of pending) {
        const source = byId.get(rule.id);
        if (!compiledIds.has(rule.id) && source) split.push({ rule, source });
      }
      return null;
    } catch (error) {
      const message = errorMessage(error);
      const ruleId = Number(RULE_ID.exec(message)?.[1]);
      const source = byId.get(ruleId);
      const rule = pending.find((r) => r.id === ruleId);
      if (!source || !rule) return `Chrome refused the ${list} rules: ${message}`;
      const parent = parentOf.get(ruleId) ?? ruleId;
      refused.add(parent);
      if (refused.size > MAX_REJECTED_RULES) {
        return `Chrome rejected more than ${MAX_REJECTED_RULES} ${list} rules. The previous rules stay in place.`;
      }
      if (parent !== ruleId) {
        const count = (partRejections.get(parent) ?? 0) + 1;
        partRejections.set(parent, count);
        const siblings = [...parentOf].filter(([, p]) => p === parent).map(([id]) => id);
        drop(new Set(count >= PART_REJECTIONS_TO_DROP_RULE ? siblings : [ruleId]), message);
        continue;
      }
      const parts = source.kind === 'headers' ? splitHeaderRule(rule, source, nextId) : null;
      if (!parts) {
        drop(new Set([ruleId]), message);
        continue;
      }
      pending = pending.filter((r) => r.id !== ruleId);
      byId.delete(ruleId);
      nextId += parts.length;
      for (const part of parts) {
        byId.set(part.rule.id, part.source);
        parentOf.set(part.rule.id, ruleId);
      }
      pending = [...pending, ...parts.map((p) => p.rule)];
    }
  }
}

export async function installRules(dnr: Dnr, result: CompileResult): Promise<InstallOutcome> {
  const rejected: Warning[] = [];
  const split: SplitRule[] = [];
  const dynamicError = await replaceList(
    'dynamic',
    dnr,
    result.dynamic,
    result.sources,
    rejected,
    split,
  );
  if (dynamicError) return { rejected, error: dynamicError, split };
  const sessionError = await replaceList(
    'session',
    dnr,
    result.session,
    result.sources,
    rejected,
    split,
  );
  return { rejected, error: sessionError, split };
}
