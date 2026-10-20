/** Toolbar badge: `II` grey when paused, the profile's letter in its colour, or a count. */
import type { State } from '@headerbench/core';
import { badgeFor as defaultBadge } from '@headerbench/core';
import { activeProfiles } from '../activations';

export interface Badge {
  text: string;
  color: string;
  title: string;
}

export const BADGE_GREY = '#5f6368';
export const BADGE_BLUE = '#1a73e8';

export function computeBadge(state: State, now: number): Badge {
  if (state.settings.paused) {
    return { text: 'II', color: BADGE_GREY, title: 'Headerbench: all profiles paused' };
  }
  const active = activeProfiles(state, now);
  const [only] = active;
  if (!only) return { text: '', color: BADGE_BLUE, title: 'Headerbench: no profile on' };
  if (active.length === 1) {
    return {
      text: only.badge.trim() || defaultBadge(only.name),
      color: only.color,
      title: `Headerbench: ${only.name} is on`,
    };
  }
  return {
    text: String(active.length),
    color: BADGE_BLUE,
    title: `Headerbench: ${active.length} profiles on (${active.map((p) => p.name).join(', ')})`,
  };
}

type Action = Pick<
  typeof chrome.action,
  'setBadgeText' | 'setBadgeBackgroundColor' | 'setBadgeTextColor' | 'setTitle'
>;

export async function applyBadge(action: Action, badge: Badge): Promise<void> {
  await Promise.all([
    action.setBadgeText({ text: badge.text }),
    action.setBadgeBackgroundColor({ color: badge.color }),
    action.setBadgeTextColor({ color: '#ffffff' }),
    action.setTitle({ title: badge.title }),
  ]);
}
