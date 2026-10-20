/**
 * Minimal declarativeNetRequest rule types. Structurally compatible with
 * `chrome.declarativeNetRequest.Rule` (string literal unions match @types/chrome's
 * template-literal enum types), so core stays free of any chrome.* dependency.
 */
import type { Method, ResourceType } from './model.js';

export type DnrHeaderOperation = 'set' | 'append' | 'remove';

export interface DnrModifyHeaderInfo {
  header: string;
  operation: DnrHeaderOperation;
  value?: string;
}

export interface DnrRedirect {
  url?: string;
  regexSubstitution?: string;
}

export type DnrActionType = 'block' | 'redirect' | 'allow' | 'modifyHeaders';

export interface DnrRuleAction {
  type: DnrActionType;
  redirect?: DnrRedirect;
  requestHeaders?: DnrModifyHeaderInfo[];
  responseHeaders?: DnrModifyHeaderInfo[];
}

export interface DnrRuleCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  resourceTypes?: ResourceType[];
  requestMethods?: Method[];
  tabIds?: number[];
}

export interface DnrRule {
  id: number;
  priority: number;
  action: DnrRuleAction;
  condition: DnrRuleCondition;
}

/** Chrome limits (research/06-pareto.md §1) and the safety margins the compiler enforces. */
export const DNR_LIMITS = {
  /** Chrome: MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES = 5,000 (modifyHeaders and redirect are unsafe). */
  maxUnsafeRules: 4500,
  /** Chrome: MAX_NUMBER_OF_REGEX_RULES = 1,000. */
  maxRegexRules: 900,
} as const;
