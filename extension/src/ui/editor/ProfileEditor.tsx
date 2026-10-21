import type { Profile, Warning } from '@headerbench/core';
import { exportFileName, exportJson, newId } from '@headerbench/core';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  EllipsisVertical,
  ShieldAlert,
  Trash2,
} from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { moveProfile, sortActivations } from '../../activations';
import type { AccessState } from '../access';
import { accessExplainer } from '../access';
import type { ActivationControls } from '../activation';
import {
  Banner,
  Button,
  EnvChip,
  IconButton,
  ProChip,
  ProfileMark,
  Switch,
} from '../components/controls';
import { ConfirmDialog } from '../components/Dialog';
import { Menu } from '../components/Menu';
import { useSnapshot, useStore } from '../context';
import { formatTime, plural, profileName, ruleCount, rulesSummary, scopeSummary } from '../format';
import { FiltersTab } from './FiltersTab';
import { HeaderTable } from './HeaderTable';
import { rowIssues } from './issues';
import { MocksTab } from './MocksTab';
import { ProfileSettings } from './ProfileSettings';
import { RedirectsTab } from './RedirectsTab';
import type { ProfileTab } from './router';
import { navigate, profileHash } from './router';

interface Props {
  profile: Profile;
  tab: ProfileTab;
  access: AccessState | null;
  /** Turned on here, where there is no tab: say that Chrome also needs the sending page. */
  pageNote: boolean;
  controls: ActivationControls;
  onGrant: () => Promise<boolean>;
  onGrantAll: () => Promise<boolean>;
}

/** The tab that a tablist key moves to (arrows wrap, Home/End jump), or null for other keys. */
export function tabKey<T>(key: string, ids: readonly T[], current: T): T | null {
  const i = ids.indexOf(current);
  switch (key) {
    case 'ArrowRight':
      return ids[(i + 1) % ids.length] ?? null;
    case 'ArrowLeft':
      return ids[(i - 1 + ids.length) % ids.length] ?? null;
    case 'Home':
      return ids[0] ?? null;
    case 'End':
      return ids[ids.length - 1] ?? null;
    default:
      return null;
  }
}

/** Profile-level warnings shown as banners (row-level ones appear inline). */
function profileBanners(warnings: Warning[], profileId: string): Warning[] {
  return warnings.filter((w) => w.profileId === profileId && w.code === 'PRO_PAUSED');
}

export function ProfileEditor({
  profile,
  tab,
  access,
  pageNote,
  controls,
  onGrant,
  onGrantAll,
}: Props) {
  const store = useStore();
  const snapshot = useSnapshot();
  const { platform } = store;
  const state = store.state;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const activations = state.settings.activations.filter((a) => a.profileId === profile.id);
  const activation = activations.find((a) => a.tabId === null) ?? activations[0] ?? null;
  const on = activation !== null;
  const issues = useMemo(() => rowIssues(profile, snapshot.warnings), [profile, snapshot.warnings]);
  const index = state.profiles.findIndex((p) => p.id === profile.id);
  const name = profileName(profile);

  const change = (patch: Partial<Profile>): void =>
    store.updateProfile(profile.id, (p) => ({ ...p, ...patch }));

  const duplicate = (): void => {
    const now = platform.now();
    const copy: Profile = {
      ...structuredClone(profile),
      id: newId(),
      name: `${profile.name} copy`,
      createdAt: now,
      updatedAt: now,
    };
    store.update((s) => {
      const profiles = [...s.profiles];
      profiles.splice(index + 1, 0, copy);
      return { ...s, profiles };
    });
    navigate(profileHash(copy.id, tab));
  };

  const exportProfile = (): void =>
    platform.download(
      exportFileName(platform.now()),
      exportJson(state, { profileIds: [profile.id] }),
    );

  const remove = (): void => {
    setConfirmDelete(false);
    const next = state.profiles[index + 1] ?? state.profiles[index - 1];
    const removed = profile;
    const removedActivations = activations;
    store.update((s) => ({
      ...s,
      profiles: s.profiles.filter((p) => p.id !== removed.id),
      settings: {
        ...s.settings,
        activations: s.settings.activations.filter((a) => a.profileId !== removed.id),
      },
    }));
    navigate(next ? profileHash(next.id) : '#/', true);
    store.notify(`Deleted ${name}.`, 'info', {
      label: 'Undo',
      run: () => {
        store.update((s) => {
          if (s.profiles.some((p) => p.id === removed.id)) return s;
          const profiles = [...s.profiles];
          profiles.splice(Math.min(index, profiles.length), 0, removed);
          const activations = [...s.settings.activations, ...removedActivations];
          return sortActivations({ ...s, profiles, settings: { ...s.settings, activations } });
        });
        navigate(profileHash(removed.id, tab), true);
      },
    });
  };

  const status = on
    ? [
        activation.tabId !== null ? `On in ${plural(activations.length, 'tab')}` : 'On',
        activation.pauseAt !== null
          ? `pauses at ${formatTime(activation.pauseAt, platform.now())}`
          : null,
      ]
        .filter(Boolean)
        .join(', ')
    : 'Off';

  const tabs: { id: ProfileTab; label: string; count?: number; pro?: boolean }[] = [
    { id: 'request', label: 'Request headers', count: profile.requestHeaders.length },
    { id: 'response', label: 'Response headers', count: profile.responseHeaders.length },
    { id: 'filters', label: 'Filters', count: profile.filters.length },
    {
      id: 'redirects',
      label: 'Redirects & blocks',
      count: profile.redirects.length + profile.blocks.length,
    },
    { id: 'mocks', label: 'Mocks', count: profile.mocks.length, pro: true },
    { id: 'settings', label: 'Profile settings' },
  ];
  const blocked =
    on && access !== null && (access.status === 'needed' || access.status === 'denied');
  const getPro = (): void => navigate('#/pro');

  return (
    <div class="pe">
      <div class="pe__head">
        <ProfileMark profile={profile} />
        <div class="grow">
          <div class="row">
            <h1 class="truncate">{name}</h1>
            <EnvChip env={profile.env} />
          </div>
          <div class="muted truncate">
            {scopeSummary(profile)} ·{' '}
            {ruleCount(profile) === 0 ? rulesSummary(profile) : plural(ruleCount(profile), 'rule')}
          </div>
        </div>
        <span class={on ? 'pe__status pe__status--on' : 'pe__status'}>{status}</span>
        <Switch
          checked={on}
          label={name}
          onChange={(next) => void (next ? controls.turnOn(profile) : controls.turnOff(profile))}
        />
        <Menu
          entries={[
            { label: 'Duplicate', icon: Copy, onSelect: duplicate },
            { label: 'Export this profile', icon: Download, onSelect: exportProfile },
            {
              label: 'Move up (higher priority)',
              icon: ArrowUp,
              disabled: index <= 0,
              onSelect: () => store.update((s) => moveProfile(s, profile.id, -1)),
            },
            {
              label: 'Move down',
              icon: ArrowDown,
              disabled: index >= state.profiles.length - 1,
              onSelect: () => store.update((s) => moveProfile(s, profile.id, 1)),
            },
            { kind: 'separator' },
            {
              label: 'Delete profile',
              icon: Trash2,
              danger: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
          trigger={(props) => (
            <IconButton icon={EllipsisVertical} label="More actions" {...props} />
          )}
        />
      </div>

      {blocked && (
        <Banner
          tone={access.status === 'denied' ? 'error' : 'warning'}
          icon={ShieldAlert}
          title={access.status === 'denied' ? 'Site access not granted' : 'Site access needed'}
          actions={
            <>
              <Button small variant="primary" onClick={() => void onGrant()}>
                {access.status === 'denied' ? 'Try again' : 'Grant access'}
              </Button>
              {access.label !== 'all sites' && (
                <Button small onClick={() => void onGrantAll()}>
                  Allow on all sites
                </Button>
              )}
            </>
          }
        >
          {accessExplainer(access.label, profile)}
        </Banner>
      )}
      {on && !blocked && pageNote && (
        <Banner
          tone="info"
          actions={
            <Button small onClick={() => void onGrantAll()}>
              Allow on all sites
            </Button>
          }
        >
          Requests sent from other sites (like your localhost app) also need access to that site.
          Open Headerbench's popup on that page to allow it, or allow all sites.
        </Banner>
      )}
      {profileBanners(snapshot.warnings, profile.id).map((w, i) => (
        <Banner
          key={i}
          tone="warning"
          actions={
            <Button small onClick={getPro}>
              Get Pro
            </Button>
          }
        >
          {w.message}
        </Banner>
      ))}

      <div
        class="tabs"
        role="tablist"
        aria-label="Profile sections"
        onKeyDown={(e) => {
          const target = tabKey(
            e.key,
            tabs.map((t) => t.id),
            tab,
          );
          if (target === null) return;
          e.preventDefault();
          navigate(profileHash(profile.id, target), true);
          document.getElementById(`tab-${target}`)?.focus();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            class="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="profile-panel"
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => navigate(profileHash(profile.id, t.id), true)}
          >
            {t.label}
            {t.pro && <ProChip />}
            {t.count !== undefined && t.count > 0 && <span class="tab__count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div class="pe__panel" role="tabpanel" id="profile-panel" aria-labelledby={`tab-${tab}`}>
        {(tab === 'request' || tab === 'response') && (
          <HeaderTable
            key={`${profile.id}-${tab}`}
            profile={profile}
            direction={tab}
            issues={issues}
            onChange={(mods) =>
              change(tab === 'request' ? { requestHeaders: mods } : { responseHeaders: mods })
            }
          />
        )}
        {tab === 'filters' && <FiltersTab profile={profile} issues={issues} onChange={change} />}
        {tab === 'redirects' && (
          <RedirectsTab
            profile={profile}
            issues={issues}
            pro={snapshot.pro}
            onChange={change}
            onGetPro={getPro}
          />
        )}
        {tab === 'mocks' && (
          <MocksTab
            profile={profile}
            issues={issues}
            pro={snapshot.pro}
            onChange={change}
            onGetPro={getPro}
          />
        )}
        {tab === 'settings' && (
          <ProfileSettings
            profile={profile}
            onChange={change}
            onDuplicate={duplicate}
            onExport={exportProfile}
            onDelete={() => setConfirmDelete(true)}
          />
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        >
          <p>
            {ruleCount(profile) > 0
              ? `Its ${rulesSummary(profile)} are removed from this browser. Export it first if you may need it again.`
              : 'This profile has no rules yet. It is removed from this browser.'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
