/** Turning profiles on and off, with the confirmation Prod profiles require. */
import type { Activation, Profile } from '@headerbench/core';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { ConfirmDialog } from './components/Dialog';
import { useStore } from './context';
import { scopeSummary } from './format';

interface Pending {
  profile: Profile;
  tabId: number | null;
  pauseAt: number | null;
}

export interface ActivationControls {
  /**
   * Turns a profile on (or changes its tab scope / auto-pause). When that widens where it
   * applies, Prod profiles ask first and `onTurningOn` runs.
   */
  turnOn: (profile: Profile, tabId?: number | null, pauseAt?: number | null) => Promise<void>;
  /** Turns a profile off everywhere, or only in `tabId`. */
  turnOff: (profile: Profile, tabId?: number) => Promise<void>;
  dialog: JSX.Element | null;
}

export interface ActivationOptions {
  /**
   * Runs synchronously inside the click that turns a profile on (or confirms a Prod one), so it
   * can call `chrome.permissions.request`, which needs that user gesture.
   */
  onTurningOn?: (profile: Profile) => void;
}

/**
 * Whether turning a profile on in `tabId` (null: all tabs) reaches requests it does not reach
 * yet: all tabs while it has no all-tabs activation, or a tab it is not on in.
 */
export function widens(
  activations: readonly Activation[],
  profileId: string,
  tabId: number | null,
): boolean {
  const own = activations.filter((a) => a.profileId === profileId);
  if (own.some((a) => a.tabId === null)) return false;
  return tabId === null || !own.some((a) => a.tabId === tabId);
}

export function useActivation(options: ActivationOptions = {}): ActivationControls {
  const store = useStore();
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async (p: Pending): Promise<void> => {
    await store.run({
      type: 'activate',
      profileId: p.profile.id,
      tabId: p.tabId,
      pauseAt: p.pauseAt,
    });
  };

  const turnOn: ActivationControls['turnOn'] = async (profile, tabId = null, pauseAt = null) => {
    const request = { profile, tabId, pauseAt };
    if (widens(store.state.settings.activations, profile.id, tabId)) {
      if (profile.env === 'prod') {
        setPending(request);
        return;
      }
      options.onTurningOn?.(profile);
    }
    await run(request);
  };

  const turnOff: ActivationControls['turnOff'] = async (profile, tabId) => {
    await store.run({
      type: 'deactivate',
      profileId: profile.id,
      ...(tabId === undefined ? {} : { tabId }),
    });
  };

  const dialog = pending ? (
    <ConfirmDialog
      title="Turn on a production profile?"
      confirmLabel="Turn on"
      danger
      onCancel={() => setPending(null)}
      onConfirm={() => {
        const request = pending;
        setPending(null);
        options.onTurningOn?.(request.profile);
        void run(request);
      }}
    >
      <p>
        <strong>{pending.profile.name}</strong> is tagged Prod. While it is on, its rules change
        real requests to{' '}
        {scopeSummary(pending.profile).toLowerCase() === 'all sites'
          ? 'every site'
          : scopeSummary(pending.profile)}
        .
      </p>
    </ConfirmDialog>
  ) : null;

  return { turnOn, turnOff, dialog };
}
