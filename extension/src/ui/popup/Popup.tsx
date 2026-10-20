import type { Profile } from '@headerbench/core';
import { activeActivations, newProfile, originsFor, pageOrigin } from '@headerbench/core';
import { Layers, PanelsTopLeft, Plus, Upload } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { pageHost, useAccess } from '../access';
import { useActivation } from '../activation';
import { Banner, Button, EmptyState, IconButton, Switch } from '../components/controls';
import { Logo } from '../components/Logo';
import { Toasts } from '../components/Toasts';
import { useSnapshot, useStore } from '../context';
import type { ActiveTab } from '../platform';
import { AppliedOnTab } from './AppliedOnTab';
import { PopupFooter } from './PopupFooter';
import { PopupProfileRow } from './PopupProfileRow';

export function Popup() {
  const store = useStore();
  const snapshot = useSnapshot();
  const { platform } = store;
  const state = store.state;
  const paused = state.settings.paused;
  const [tab, setTab] = useState<ActiveTab | null | undefined>(undefined);
  const onIds = new Set(state.settings.activations.map((a) => a.profileId));
  const onProfiles = state.profiles.filter((p) => onIds.has(p.id));
  // Chrome changes a request only if Headerbench can access the page that sends it, too.
  const page = tab?.url ? pageOrigin(tab.url) : null;
  const host = pageHost(tab?.url ?? null);
  const { access, pageGranted, grant } = useAccess(platform, onProfiles, page);
  const activation = useActivation({ onTurningOn: (profile) => void grant(profile) });
  const pageLabel = pageGranted === false ? host : null;
  // An active profile that changes requests from this tab, while the tab's page is not granted.
  const needsPage =
    pageGranted === false &&
    tab != null &&
    host !== null &&
    !paused &&
    activeActivations(state, platform.now()).some((a) => {
      const profile = state.profiles.find((p) => p.id === a.profileId);
      return (
        profile !== undefined &&
        (a.tabId === null || a.tabId === tab.id) &&
        originsFor(profile).length > 0
      );
    });

  useEffect(() => {
    platform.activeTab().then(setTab, () => setTab(null));
  }, [platform]);

  const open = (path: string): void => {
    void platform.openPage(path).then(() => platform.closePopup());
  };

  const createProfile = async (): Promise<void> => {
    const profile: Profile = newProfile({ existing: store.state.profiles, now: platform.now() });
    store.update((s) => ({ ...s, profiles: [...s.profiles, profile] }));
    await store.flush();
    open(`app.html#/profile/${profile.id}`);
  };

  return (
    <div class="popup">
      <header class="popup__head">
        <Logo size={20} />
        <span class="popup__brand">Headerbench</span>
        <span class="grow" />
        <span class="popup__state" aria-hidden="true">
          {paused ? 'Paused' : 'On'}
        </span>
        <Switch
          checked={!paused}
          label={paused ? 'Resume all profiles' : 'Pause all profiles'}
          onChange={(on) => void store.call({ type: 'setPaused', paused: !on })}
        />
        <IconButton icon={PanelsTopLeft} label="Open editor" onClick={() => open('app.html')} />
      </header>

      <main class="popup__body">
        {paused && (
          <div class="popup__notice">
            <Banner
              tone="warning"
              actions={
                <Button small onClick={() => void store.call({ type: 'setPaused', paused: false })}>
                  Resume
                </Button>
              }
            >
              All profiles are paused. Requests are not being changed.
            </Banner>
          </div>
        )}
        {snapshot.ruleError && (
          <div class="popup__notice">
            <Banner tone="error">{snapshot.ruleError}</Banner>
          </div>
        )}

        <section class="popup__section" aria-labelledby="popup-profiles">
          <div class="section-head">
            <h2 id="popup-profiles">Profiles</h2>
            {state.profiles.length > 0 && (
              <IconButton
                icon={Plus}
                small
                label="New profile"
                onClick={() => void createProfile()}
              />
            )}
          </div>
          {state.profiles.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No profiles yet"
              action={
                <div class="stack popup__empty-actions">
                  <Button variant="primary" icon={Plus} onClick={() => void createProfile()}>
                    Create a profile
                  </Button>
                  <Button variant="text" icon={Upload} onClick={() => open('app.html#/import')}>
                    Import from ModHeader
                  </Button>
                </div>
              }
            >
              A profile is a set of header changes for the sites you choose.
            </EmptyState>
          ) : (
            <ul class="plist">
              {state.profiles.map((profile) => (
                <PopupProfileRow
                  key={profile.id}
                  profile={profile}
                  activation={
                    state.settings.activations.find((a) => a.profileId === profile.id) ?? null
                  }
                  access={access.get(profile.id) ?? null}
                  pageLabel={pageLabel}
                  tabId={tab?.id ?? null}
                  controls={activation}
                  onGrant={() => grant(profile)}
                  onEdit={() => open(`app.html#/profile/${profile.id}`)}
                />
              ))}
            </ul>
          )}
        </section>

        {tab && state.profiles.length > 0 && (
          <AppliedOnTab
            tab={tab}
            pageAccess={
              needsPage && page !== null
                ? {
                    host: host as string,
                    grant: () => platform.permissions.request([page]).catch(() => false),
                  }
                : null
            }
            onTest={(url) => open(`app.html#/test?url=${encodeURIComponent(url)}`)}
          />
        )}
      </main>

      <PopupFooter onOpen={open} />
      {activation.dialog}
      <Toasts />
    </div>
  );
}
