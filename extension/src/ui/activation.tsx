/** Turning profiles on and off, with the confirmation Prod profiles require. */
import type { Profile } from '@headerbench/core';
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
  /** Turns a profile on (or changes its tab scope / auto-pause). Prod profiles ask first. */
  turnOn: (profile: Profile, tabId?: number | null, pauseAt?: number | null) => Promise<void>;
  turnOff: (profile: Profile) => Promise<void>;
  dialog: JSX.Element | null;
}

export interface ActivationOptions {
  /**
   * Runs synchronously inside the click that turns a profile on (or confirms a Prod one), so it
   * can call `chrome.permissions.request`, which needs that user gesture.
   */
  onTurningOn?: (profile: Profile) => void;
}

export function useActivation(options: ActivationOptions = {}): ActivationControls {
  const store = useStore();
  const [pending, setPending] = useState<Pending | null>(null);

  const run = async (p: Pending): Promise<void> => {
    try {
      await store.call({
        type: 'activate',
        profileId: p.profile.id,
        tabId: p.tabId,
        pauseAt: p.pauseAt,
      });
    } catch (error) {
      store.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const turnOn: ActivationControls['turnOn'] = async (profile, tabId = null, pauseAt = null) => {
    const alreadyOn = store.state.settings.activations.some((a) => a.profileId === profile.id);
    const request = { profile, tabId, pauseAt };
    if (profile.env === 'prod' && !alreadyOn) {
      setPending(request);
      return;
    }
    if (!alreadyOn) options.onTurningOn?.(profile);
    await run(request);
  };

  const turnOff: ActivationControls['turnOff'] = async (profile) => {
    try {
      await store.call({ type: 'deactivate', profileId: profile.id });
    } catch (error) {
      store.notify(error instanceof Error ? error.message : String(error), 'error');
    }
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
