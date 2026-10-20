/**
 * Neutral review prompt (docs/blueprint/LAUNCH.md): after an active profile has been used on 3
 * separate days, the popup footer asks once. "Not now" or "Rate" hide it for good. No incentive,
 * no sentiment gate.
 */
import type { Settings, State } from '@headerbench/core';
import { activeActivations } from '@headerbench/core';

export const REVIEW_DAYS_NEEDED = 3;

/** Local calendar day, `YYYY-MM-DD`. */
export function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Records today as an active day when a profile is applying rules. Returns the updated state, or
 * null when nothing changed (so callers can skip a write).
 */
export function recordActiveDay(state: State, now: number): State | null {
  const review = state.settings.review;
  if (review.state === 'dismissed' || review.state === 'rated') return null;
  if (review.activeDays.length >= REVIEW_DAYS_NEEDED) return null;
  if (state.settings.paused || activeActivations(state, now).length === 0) return null;
  const today = localDay(now);
  if (review.activeDays.includes(today)) return null;
  const activeDays = [...review.activeDays, today].slice(-REVIEW_DAYS_NEEDED);
  return { ...state, settings: { ...state.settings, review: { ...review, activeDays } } };
}

export function shouldShowReview(settings: Settings): boolean {
  const { state, activeDays } = settings.review;
  return (state === 'pending' || state === 'shown') && activeDays.length >= REVIEW_DAYS_NEEDED;
}

/** Store review page for this build: Edge Add-ons when running in Edge, else the Chrome Web Store. */
export function reviewUrl(extensionId: string, userAgent: string): string {
  return userAgent.includes('Edg/')
    ? `https://microsoftedge.microsoft.com/addons/detail/${extensionId}`
    : `https://chromewebstore.google.com/detail/${extensionId}/reviews`;
}
