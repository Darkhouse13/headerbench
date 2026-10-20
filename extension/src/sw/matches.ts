/** Maps Chrome's matched rule ids back to the profiles and rows that produced them. */
import type { CompileResult, DnrRule, Effect, State } from '@headerbench/core';
import { headerLabel } from '@headerbench/core';
import type { AppliedEffect } from '../messages';

export interface MatchedRuleInfo {
  rule: { ruleId: number; rulesetId: string };
  timeStamp: number;
}

/** chrome.declarativeNetRequest.DYNAMIC_RULESET_ID / SESSION_RULESET_ID */
const RULESET_LIST: Record<string, 'dynamic' | 'session'> = {
  _dynamic: 'dynamic',
  _session: 'session',
};

function effectsOf(rule: DnrRule, kind: string): Effect[] {
  const action = rule.action;
  switch (action.type) {
    case 'block':
      return [{ type: 'block' }];
    case 'allow':
      return [{ type: 'exclude' }];
    case 'redirect': {
      const url = action.redirect?.url ?? '';
      if (kind === 'mock') {
        const [head = '', body = ''] = url.split(',');
        return [
          {
            type: 'mock',
            contentType: head.replace(/^data:/, '').replace(/;.*$/, ''),
            bytes: Math.floor((body.replace(/=+$/, '').length * 3) / 4),
          },
        ];
      }
      return [{ type: 'redirect', to: url || 'a URL rewritten by your pattern' }];
    }
    case 'modifyHeaders':
      return [
        ...(action.requestHeaders ?? []).map((op): Effect => ({
          type: 'header',
          direction: 'request',
          header: op.header,
          operation: op.operation,
          ...(op.value !== undefined ? { value: op.value } : {}),
        })),
        ...(action.responseHeaders ?? []).map((op): Effect => ({
          type: 'header',
          direction: 'response',
          header: op.header,
          operation: op.operation,
          ...(op.value !== undefined ? { value: op.value } : {}),
        })),
      ];
  }
}

export function appliedEffects(
  state: State,
  compiled: CompileResult,
  matched: readonly MatchedRuleInfo[],
): AppliedEffect[] {
  const profiles = new Map(state.profiles.map((p) => [p.id, p]));
  const rules = new Map<string, DnrRule>();
  for (const r of compiled.dynamic) rules.set(`dynamic:${r.id}`, r);
  for (const r of compiled.session) rules.set(`session:${r.id}`, r);
  const sources = new Map(compiled.sources.map((s) => [`${s.list}:${s.ruleId}`, s]));

  const out = new Map<string, AppliedEffect & { priority: number }>();
  for (const info of matched) {
    const list = RULESET_LIST[info.rule.rulesetId];
    if (!list) continue;
    const key = `${list}:${info.rule.ruleId}`;
    const rule = rules.get(key);
    const source = sources.get(key);
    const profile = source ? profiles.get(source.profileId) : undefined;
    if (!rule || !source || !profile) continue;
    effectsOf(rule, source.kind).forEach((raw, i) => {
      const itemId = source.itemIds[i] ?? source.itemIds[0] ?? null;
      const effect: Effect =
        raw.type === 'header' ? { ...raw, header: headerLabel(profile, itemId, raw.header) } : raw;
      const effectKey = `${key}:${i}`;
      const existing = out.get(effectKey);
      if (existing) {
        existing.hits += 1;
        existing.lastMatchedAt = Math.max(existing.lastMatchedAt, info.timeStamp);
        return;
      }
      out.set(effectKey, {
        profileId: profile.id,
        profileName: profile.name,
        color: profile.color,
        kind: source.kind,
        itemId,
        effect,
        hits: 1,
        lastMatchedAt: info.timeStamp,
        priority: source.activationIndex,
      });
    });
  }
  return [...out.values()]
    .sort((a, b) => a.priority - b.priority || b.lastMatchedAt - a.lastMatchedAt)
    .map(({ priority: _priority, ...effect }) => effect);
}
