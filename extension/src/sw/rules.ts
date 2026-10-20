/**
 * Installs compiled rules. Each list is replaced atomically. If Chrome rejects one rule (for
 * example a regex RE2 cannot handle), that rule is dropped with a warning and the rest are
 * installed, so a single bad row never blocks the others.
 */
import type { CompileResult, DnrRule, RuleSource, Warning } from '@headerbench/core';

type Dnr = Pick<
  typeof chrome.declarativeNetRequest,
  'getDynamicRules' | 'updateDynamicRules' | 'getSessionRules' | 'updateSessionRules'
>;

export interface InstallOutcome {
  /** Items Chrome refused, reported as INVALID_ITEM errors. */
  rejected: Warning[];
  /** A failure that left the previous rules in place, or null. */
  error: string | null;
}

/** Chrome reports the offending rule as e.g. "Rule with id 3 specified a non-supported regex." */
const RULE_ID = /rule with id (\d+)/i;
const MAX_REJECTIONS = 20;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function replaceList(
  list: 'dynamic' | 'session',
  dnr: Dnr,
  rules: DnrRule[],
  sources: RuleSource[],
  rejected: Warning[],
): Promise<string | null> {
  const existing = list === 'dynamic' ? await dnr.getDynamicRules() : await dnr.getSessionRules();
  const removeRuleIds = existing.map((r) => r.id);
  let pending = rules;
  for (let attempt = 0; attempt <= MAX_REJECTIONS; attempt++) {
    const options = {
      removeRuleIds,
      addRules: pending as unknown as chrome.declarativeNetRequest.Rule[],
    };
    try {
      if (list === 'dynamic') await dnr.updateDynamicRules(options);
      else await dnr.updateSessionRules(options);
      return null;
    } catch (error) {
      const message = errorMessage(error);
      const ruleId = Number(RULE_ID.exec(message)?.[1]);
      const source = sources.find((s) => s.list === list && s.ruleId === ruleId);
      if (!source) return `Chrome refused the ${list} rules: ${message}`;
      rejected.push({
        code: 'INVALID_ITEM',
        severity: 'error',
        message: `Chrome rejected this rule: ${message}`,
        profileId: source.profileId,
        itemIds: source.itemIds,
      });
      pending = pending.filter((r) => r.id !== ruleId);
    }
  }
  return `Chrome rejected more than ${MAX_REJECTIONS} ${list} rules. The previous rules stay in place.`;
}

export async function installRules(dnr: Dnr, result: CompileResult): Promise<InstallOutcome> {
  const rejected: Warning[] = [];
  const dynamicError = await replaceList('dynamic', dnr, result.dynamic, result.sources, rejected);
  const sessionError = await replaceList('session', dnr, result.session, result.sources, rejected);
  return { rejected, error: dynamicError ?? sessionError };
}
