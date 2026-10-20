import type { Activation, Profile } from '@headerbench/core';
import { EllipsisVertical, Pencil, ShieldAlert } from 'lucide-preact';
import type { AccessState } from '../access';
import { accessExplainer } from '../access';
import type { ActivationControls } from '../activation';
import { Button, EnvChip, IconButton, ProfileMark, Switch } from '../components/controls';
import type { MenuEntry } from '../components/Menu';
import { Menu } from '../components/Menu';
import { useStore } from '../context';
import { formatTime, rulesSummary, scopeSummary } from '../format';

const HOUR = 60 * 60 * 1000;

interface Props {
  profile: Profile;
  activation: Activation | null;
  access: AccessState | null;
  /** The popup's page, when Chrome also needs access to it; null otherwise. */
  pageLabel: string | null;
  tabId: number | null;
  controls: ActivationControls;
  onGrant: () => Promise<boolean>;
  onEdit: () => void;
}

export function PopupProfileRow({
  profile,
  activation,
  access,
  pageLabel,
  tabId,
  controls,
  onGrant,
  onEdit,
}: Props) {
  const { platform } = useStore();
  const now = platform.now();
  const on = activation !== null;
  const scope = activation?.tabId ?? null;
  const pauseAt = activation?.pauseAt ?? null;

  const meta = on
    ? [
        scope !== null ? 'This tab only' : null,
        pauseAt !== null ? `Pauses at ${formatTime(pauseAt, now)}` : null,
        scopeSummary(profile),
      ]
    : [rulesSummary(profile), scopeSummary(profile)];

  const entries: MenuEntry[] = [
    { kind: 'label', label: 'Applies to' },
    {
      label: 'All tabs',
      checked: on && scope === null,
      onSelect: () => void controls.turnOn(profile, null, pauseAt),
    },
    {
      label: 'This tab only',
      description: tabId === null ? 'Open the popup on a web page to use this' : undefined,
      checked: on && scope !== null,
      disabled: tabId === null,
      onSelect: () => void controls.turnOn(profile, tabId, pauseAt),
    },
    { kind: 'separator' },
    { kind: 'label', label: 'Auto-pause' },
    {
      label: 'Keep on until I turn it off',
      checked: on && pauseAt === null,
      onSelect: () => void controls.turnOn(profile, scope, null),
    },
    {
      label: 'Pause after 1 hour',
      checked: false,
      onSelect: () => void controls.turnOn(profile, scope, platform.now() + HOUR),
    },
    {
      label: 'Pause after 8 hours',
      checked: false,
      onSelect: () => void controls.turnOn(profile, scope, platform.now() + 8 * HOUR),
    },
    { kind: 'separator' },
    { label: 'Edit in editor', icon: Pencil, onSelect: onEdit },
  ];

  const blocked =
    on && access !== null && (access.status === 'needed' || access.status === 'denied');

  return (
    <li class={on ? 'prow prow--on' : 'prow'}>
      <div class="prow__main">
        <ProfileMark profile={profile} />
        <div class="grow">
          <div class="row prow__title">
            <span class="prow__name truncate">{profile.name}</span>
            <EnvChip env={profile.env} />
          </div>
          <div class="prow__meta truncate">{meta.filter(Boolean).join(' · ')}</div>
        </div>
        <Menu
          entries={entries}
          trigger={(props) => (
            <IconButton
              icon={EllipsisVertical}
              small
              label={`Options for ${profile.name}`}
              {...props}
            />
          )}
        />
        <Switch
          checked={on}
          label={on ? `Turn off ${profile.name}` : `Turn on ${profile.name}`}
          onChange={(next) => void (next ? controls.turnOn(profile) : controls.turnOff(profile))}
        />
      </div>
      {blocked && (
        <div
          class={access.status === 'denied' ? 'prow__access prow__access--denied' : 'prow__access'}
        >
          <ShieldAlert class="icon" size={16} aria-hidden="true" />
          <div class="grow stack">
            <span>
              {access.status === 'denied'
                ? `Blocked by Chrome: no site access to ${access.label}.`
                : accessExplainer(access.label, profile, pageLabel)}
            </span>
            <div>
              <Button
                small
                variant={access.status === 'denied' ? 'default' : 'primary'}
                onClick={() => void onGrant()}
              >
                {access.status === 'denied' ? 'Try again' : 'Grant access'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
