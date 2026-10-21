/** Inline messages per row: local validation plus the service worker's compile warnings. */
import type { Profile, Warning } from '@headerbench/core';
import { fragileRequestHeaderWarning, profileIssues } from '@headerbench/core';

export interface RowIssue {
  tone: 'error' | 'warning';
  message: string;
}

export type IssueMap = Map<string, RowIssue[]>;

function rowMessage(w: Warning): string {
  return w.code === 'PRO_PAUSED' ? 'Paused: this rule needs Pro.' : w.message;
}

/**
 * Most INVALID_ITEM warnings repeat local validation (and may be one save behind), so only the
 * ones local checks cannot produce are kept.
 */
function fromCompilerOnly(w: Warning): boolean {
  return (
    w.code !== 'INVALID_ITEM' || /^(Chrome rejected|An earlier row|After variables)/.test(w.message)
  );
}

/** Validation runs locally so messages update while typing; warnings arrive after the save. */
export function rowIssues(profile: Profile, warnings: readonly Warning[]): IssueMap {
  const map: IssueMap = new Map();
  const add = (itemId: string, issue: RowIssue): void => {
    const list = map.get(itemId) ?? [];
    if (!list.some((i) => i.message === issue.message)) list.push(issue);
    map.set(itemId, list);
  };
  for (const issue of profileIssues(profile)) {
    add(issue.itemId, { tone: 'error', message: issue.message });
  }
  // The compiler warns about these too, but only after the save; say it while typing.
  for (const mod of profile.requestHeaders) {
    const fragile = mod.op === 'remove' ? null : fragileRequestHeaderWarning(mod.name);
    if (fragile) add(mod.id, { tone: 'warning', message: fragile });
  }
  for (const w of warnings) {
    if (w.profileId !== profile.id || !fromCompilerOnly(w)) continue;
    for (const itemId of w.itemIds) {
      add(itemId, { tone: w.severity === 'error' ? 'error' : 'warning', message: rowMessage(w) });
    }
  }
  return map;
}
