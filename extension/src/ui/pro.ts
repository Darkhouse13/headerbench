/** What to tell the user about a Pro-only feature, given their Pro status. */
import type { ProStatus } from '@headerbench/core';
import { TRIAL_DAYS } from '@headerbench/core';
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
