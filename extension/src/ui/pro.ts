/** What to tell the user about a Pro-only feature, given their Pro status. */
import type { ProStatus, State } from '@headerbench/core';
import { TRIAL_DAYS, hasProItems } from '@headerbench/core';
import { daysLeft, formatDate, plural } from './format';

export interface ProGate {
  tone: 'info' | 'warning';
  text: string;
  /** Show a "Get Pro" action. */
  offerPro: boolean;
}

/** `feature` is a plural noun phrase, e.g. "Mocks". Null when Pro is active through a licence. */
export function proGate(pro: ProStatus, now: number, feature: string): ProGate | null {
  if (pro.source === 'license') return null;
  if (pro.source === 'trial' && pro.trialEndsAt !== null) {
    return {
      tone: 'info',
      text: `Pro trial: ${plural(daysLeft(pro.trialEndsAt, now), 'day')} left. ${feature} work until ${formatDate(pro.trialEndsAt)}.`,
      offerPro: true,
    };
  }
  if (pro.trialEndsAt === null && pro.plan === null) {
    return {
      tone: 'info',
      text: `${feature} are part of Pro. Adding one starts your ${TRIAL_DAYS}-day free trial, no card needed.`,
      offerPro: false,
    };
  }
  return {
    tone: 'warning',
    text: `${feature} are paused because Pro is not active. They are kept and resume when you activate Pro.`,
    offerPro: true,
  };
}

/** The popup warns this long before a yearly licence ends. */
export const EXPIRY_NOTICE_MS = 7 * 24 * 3600 * 1000;

/**
 * One line for the popup when Pro needs attention: a yearly licence that ends within 7 days, or
 * Pro that has ended while profiles still use Pro rules. Null otherwise.
 */
export function proNotice(
  pro: ProStatus,
  state: State,
  now: number,
): { tone: 'info' | 'warning'; text: string } | null {
  if (pro.source === 'license') {
    const ends = pro.licenseExpiresAt;
    if (ends === null || ends - now > EXPIRY_NOTICE_MS) return null;
    return {
      tone: 'info',
      text: `Pro ends on ${formatDate(ends)}. It renews automatically while your subscription is active; open Pro to check.`,
    };
  }
  if (pro.pro || !hasProItems(state)) return null;
  if (pro.plan !== null) {
    return {
      tone: 'warning',
      text: 'Your Pro licence has ended, so Pro rules are paused. Open Pro to refresh the licence or renew.',
    };
  }
  if (pro.trialEndsAt !== null) {
    return {
      tone: 'warning',
      text: 'Your Pro trial has ended, so Pro rules are paused. They are kept and resume with Pro.',
    };
  }
  return null;
}
