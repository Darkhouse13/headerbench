import type { Profile } from '@headerbench/core';
import { exportFileName, exportJson, newProfile, originsFor } from '@headerbench/core';
import {
  Braces,
  Download,
  Gem,
  Layers,
  Plus,
  SearchCheck,
  Settings,
  ShieldCheck,
  Upload,
} from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { useAccess } from '../access';
import { useActivation } from '../activation';
import { Banner, Button, EmptyState, Switch } from '../components/controls';
import { Logo } from '../components/Logo';
import { Toasts } from '../components/Toasts';
import { useSnapshot, useStore } from '../context';
import { ImportDialog } from '../dialogs/ImportDialog';
import { proSummary } from '../format';
import { PermissionsPage } from '../pages/PermissionsPage';
import { ProPage } from '../pages/ProPage';
import { SettingsPage } from '../pages/SettingsPage';
import { TestUrlPage } from '../pages/TestUrlPage';
import { VariablesPage } from '../pages/VariablesPage';
import { ProfileEditor } from './ProfileEditor';
import type { Route } from './router';
import { navigate, profileHash, useRoute } from './router';
import { Sidebar } from './Sidebar';

interface NavItem {
  label: string;
  icon: LucideIcon;
  hash: string;
  active: (r: Route) => boolean;
}

const NAV: NavItem[] = [
  { label: 'Profiles', icon: Layers, hash: '#/', active: (r) => r.page === 'profiles' },
  { label: 'Test a URL', icon: SearchCheck, hash: '#/test', active: (r) => r.page === 'test' },
  { label: 'Variables', icon: Braces, hash: '#/variables', active: (r) => r.page === 'variables' },
  {
    label: 'Permissions',
    icon: ShieldCheck,
    hash: '#/permissions',
    active: (r) => r.page === 'permissions',
  },
  { label: 'Settings', icon: Settings, hash: '#/settings', active: (r) => r.page === 'settings' },
];

function TopBar({ route }: { route: Route }) {
  const store = useStore();
  const snapshot = useSnapshot();
  const { platform } = store;
  const paused = store.state.settings.paused;
  return (
    <header class="topbar">
      <a class="topbar__brand" href="#/">
        <Logo size={24} />
        <span>Headerbench</span>
      </a>
      <nav class="topbar__nav" aria-label="Main">
        {NAV.map((item) => (
          <a
            key={item.hash}
            href={item.hash}
            class="topbar__link"
            aria-current={item.active(route) ? 'page' : undefined}
            title={item.label}
          >
            <item.icon class="icon" size={18} aria-hidden="true" />
            <span class="topbar__label">{item.label}</span>
          </a>
        ))}
      </nav>
      <span class="grow" />
      <div class="topbar__actions">
        <Button variant="text" icon={Upload} onClick={() => navigate('#/import')}>
          Import
        </Button>
        <Button
          variant="text"
          icon={Download}
          disabled={store.state.profiles.length === 0}
          onClick={() => platform.download(exportFileName(platform.now()), exportJson(store.state))}
        >
          Export
        </Button>
        <a
          class="topbar__pro"
          href="#/pro"
          aria-current={route.page === 'pro' ? 'page' : undefined}
        >
          <Gem class="icon" size={16} aria-hidden="true" />
          <span>{snapshot.pro.pro ? proSummary(snapshot.pro, platform.now()) : 'Get Pro'}</span>
        </a>
        <span class="topbar__divider" aria-hidden="true" />
        <span class="topbar__state">{paused ? 'All paused' : 'Rules on'}</span>
        <Switch
          checked={!paused}
          label={paused ? 'Resume all profiles' : 'Pause all profiles'}
          onChange={(on) => void store.call({ type: 'setPaused', paused: !on })}
        />
      </div>
    </header>
  );
}

function ProfilesView({
  route,
  importing,
}: {
  route: Extract<Route, { page: 'profiles' }>;
  /** The import dialog is open over the list: show the first profile without changing the URL. */
  importing: boolean;
}) {
  const store = useStore();
  const { platform } = store;
  const state = store.state;
  const first = state.profiles[0];
  const selected =
    state.profiles.find((p) => p.id === route.profileId) ?? (importing ? (first ?? null) : null);
  const onIds = new Set(state.settings.activations.map((a) => a.profileId));
  const { access, allSites, grant, grantAll } = useAccess(
    platform,
    state.profiles.filter((p) => onIds.has(p.id)),
  );
  // Profiles turned on from this page. The editor has no tab, so it cannot ask for the page that
  // sends the requests; those profiles get a note about it.
  const [enabledHere, setEnabledHere] = useState<ReadonlySet<string>>(new Set());
  const controls = useActivation({
    onTurningOn: (profile) => {
      void grant(profile);
      setEnabledHere((prev) => new Set(prev).add(profile.id));
    },
  });

  useEffect(() => {
    if (!selected && first) navigate(profileHash(first.id), true);
  }, [selected, first]);

  const create = (): void => {
    const profile: Profile = newProfile({ existing: store.state.profiles, now: platform.now() });
    store.update((s) => ({ ...s, profiles: [...s.profiles, profile] }));
    navigate(profileHash(profile.id, 'request'));
  };

  return (
    <div class="workspace">
      <Sidebar selectedId={selected?.id ?? null} controls={controls} onCreate={create} />
      <main class="workspace__main">
        {selected ? (
          <ProfileEditor
            key={selected.id}
            profile={selected}
            tab={route.tab}
            access={access.get(selected.id) ?? null}
            pageNote={
              enabledHere.has(selected.id) &&
              onIds.has(selected.id) &&
              !allSites &&
              originsFor(selected).length > 0
            }
            controls={controls}
            onGrant={() => grant(selected)}
            onGrantAll={grantAll}
          />
        ) : (
          state.profiles.length === 0 && (
            <EmptyState
              icon={Layers}
              title="No profiles yet"
              action={
                <div class="row">
                  <Button variant="primary" icon={Plus} onClick={create}>
                    Create a profile
                  </Button>
                  <Button variant="text" icon={Upload} onClick={() => navigate('#/import')}>
                    Import from ModHeader
                  </Button>
                </div>
              }
            >
              A profile is a set of header changes, redirects and blocks for the sites you choose.
              Turn on several at once and decide which one wins.
            </EmptyState>
          )
        )}
      </main>
      {controls.dialog}
    </div>
  );
}

export function AppShell() {
  const store = useStore();
  const snapshot = useSnapshot();
  const route = useRoute();

  useEffect(() => {
    // Renews a yearly licence close to expiry; the service worker rate-limits and skips when not due.
    store.send({ type: 'refreshLicense', auto: true }).catch(() => undefined);
  }, [store]);

  const page =
    route.page === 'import'
      ? { page: 'profiles' as const, profileId: null, tab: 'request' as const }
      : route;

  return (
    <div class="app">
      <TopBar route={route} />
      {snapshot.ruleError && (
        <div class="app__alert">
          <Banner tone="error" title="Chrome did not accept the latest rules">
            {snapshot.ruleError}
          </Banner>
        </div>
      )}
      {page.page === 'profiles' && (
        <ProfilesView route={page} importing={route.page === 'import'} />
      )}
      {page.page !== 'profiles' && (
        <main class="app__page">
          {page.page === 'test' && <TestUrlPage initialUrl={page.url} />}
          {page.page === 'variables' && <VariablesPage />}
          {page.page === 'permissions' && <PermissionsPage />}
          {page.page === 'settings' && <SettingsPage />}
          {page.page === 'pro' && <ProPage />}
        </main>
      )}
      {route.page === 'import' && (
        <ImportDialog
          onClose={() => navigate('#/', true)}
          onImported={(ids) => navigate(ids[0] ? profileHash(ids[0]) : '#/', true)}
        />
      )}
      <Toasts />
    </div>
  );
}
