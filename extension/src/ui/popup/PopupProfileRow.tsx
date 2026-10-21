import type { Activation, Profile } from '@headerbench/core';
import { EllipsisVertical, Pencil, ShieldAlert } from 'lucide-preact';
import type { AccessState } from '../access';
import { accessExplainer } from '../access';
import type { ActivationControls } from '../activation';
import { useState } from 'preact/hooks';
import { Dialog } from '../components/Dialog';
import { Button, EnvChip, IconButton, ProfileMark, Switch } from '../components/controls';
import type { MenuEntry } from '../components/Menu';
import { Menu } from '../components/Menu';
import { useStore } from '../context';
import { formatTime, plural, profileName, rulesSummary, scopeSummary } from '../format';

const HOUR = 60 * 60 * 1000;

interface Props {
  profile: Profile;
  /** The profile's activations: one global one, or one per tab it is on in. */
  activations: Activation[];
  access: AccessState | null;
  /** The popup's page, when Chrome also needs access to it; null otherwise. */
  pageLabel: string | null;
  tabId: number | null;
  controls: ActivationControls;
  onGrant: () => Promise<boolean>;
  onEdit: () => void;
}

/** Where a profile is on, from the popup's tab's point of view. */
function tabScope(activations: readonly Activation[], tabId: number | null) {
  const global = activations.find((a) => a.tabId === null) ?? null;
  const here = tabId === null ? null : (activations.find((a) => a.tabId === tabId) ?? null);
  const tabs = activations.filter((a) => a.tabId !== null).length;
  return {
    global,
    here,
    tabs,
    /** On for requests from this tab. */
    on: global !== null || here !== null,
    /** The activation whose auto-pause applies to this tab. */
    current: global ?? here,
  };
}

/** The menu's label for scoping the profile to the popup's tab. */
function thisTabLabel(scope: ReturnType<typeof tabScope>): string {
  if (scope.here !== null) return scope.tabs > 1 ? 'This tab' : 'This tab only';
  return scope.tabs > 0 ? 'This tab too' : 'This tab only';
}

function scopeLabel(scope: ReturnType<typeof tabScope>): string | null {
  if (scope.global !== null || scope.tabs === 0) return null;
  if (scope.here === null) return `On in ${plural(scope.tabs, 'other tab')}`;
  return scope.tabs === 1 ? 'This tab only' : `This tab and ${plural(scope.tabs - 1, 'other')}`;
}

export function PopupProfileRow({
  profile,
  activations,
  access,
  pageLabel,
  tabId,
  controls,
  onGrant,
  onEdit,
}: Props) {
  const { platform } = useStore();
  const [choosing, setChoosing] = useState(false);
  const now = platform.now();
  const scope = tabScope(activations, tabId);
  const { on } = scope;
  const pauseAt = scope.current?.pauseAt ?? null;
  // Tab-scoped changes apply to this tab; a global profile keeps its scope.
  const target = scope.global === null && tabId !== null && scope.here !== null ? tabId : null;
  const where = scopeLabel(scope);

  const meta = on
    ? [
        where,
        pauseAt !== null ? `Pauses at ${formatTime(pauseAt, now)}` : null,
        scopeSummary(profile),
      ]
    : [where ?? rulesSummary(profile), scopeSummary(profile)];

  const turnOff = (): Promise<void> =>
    scope.global === null && tabId !== null
      ? controls.turnOff(profile, tabId)
      : controls.turnOff(profile);

  const offElsewhere =
    scope.global === null && scope.here === null && scope.tabs > 0
      ? scope.tabs === 1
        ? 'Turn off in the other tab'
        : `Turn off in ${scope.tabs} other tabs`
      : scope.global === null && scope.tabs > 1
        ? `Turn off in all ${scope.tabs} tabs`
        : null;

  const entries: MenuEntry[] = [
    { kind: 'label', label: 'Applies to' },
    {
      label: 'All tabs',
      checked: scope.global !== null,
      onSelect: () => void controls.turnOn(profile, null, pauseAt),
    },
    {
      label: thisTabLabel(scope),
      description: tabId === null ? 'Open the popup on a web page to use this' : undefined,
      checked: scope.global === null && scope.here !== null,
      disabled: tabId === null,
      onSelect: () => void controls.turnOn(profile, tabId, pauseAt),
    },
    { kind: 'separator' },
    {
      kind: 'label',
      label:
        on && pauseAt !== null
          ? `Auto-pause · pauses at ${formatTime(pauseAt, now)}`
          : 'Auto-pause',
    },
    {
      label: 'Keep on until I turn it off',
      checked: on && pauseAt === null,
      onSelect: () => void controls.turnOn(profile, target, null),
    },
    {
      label: 'Pause after 1 hour',
      checked: false,
      onSelect: () => void controls.turnOn(profile, target, platform.now() + HOUR),
    },
    {
      label: 'Pause after 8 hours',
      checked: false,
      onSelect: () => void controls.turnOn(profile, target, platform.now() + 8 * HOUR),
    },
    { kind: 'separator' },
    ...(offElsewhere
      ? [{ label: offElsewhere, onSelect: () => void controls.turnOff(profile) }]
      : []),
    { label: 'Edit in editor', icon: Pencil, onSelect: onEdit },
  ];

  // On in other tabs but not this one: switching it on asks which scope to widen to.
  const askScope = scope.global === null && scope.here === null && scope.tabs > 0 && tabId !== null;
  const switchOn = (): void => {
    if (askScope) setChoosing(true);
    else void controls.turnOn(profile);
  };
  const choose = (choice: number | null): void => {
    setChoosing(false);
    void controls.turnOn(profile, choice);
  };

  const blocked =
    on && access !== null && (access.status === 'needed' || access.status === 'denied');
  const name = profileName(profile);

  return (
    <li class={on ? 'prow prow--on' : 'prow'}>
      <div class="prow__main">
        <ProfileMark profile={profile} />
        <div class="grow">
          <div class="row prow__title">
            <span class="prow__name truncate">{name}</span>
            <EnvChip env={profile.env} />
          </div>
          <div class="prow__meta truncate">{meta.filter(Boolean).join(' · ')}</div>
        </div>
        <Menu
          entries={entries}
          trigger={(props) => (
            <IconButton icon={EllipsisVertical} small label={`Options for ${name}`} {...props} />
          )}
        />
        <Switch
          checked={on}
          label={name}
          onChange={(next) => (next ? switchOn() : void turnOff())}
        />
      </div>
      {choosing && (
        <Dialog
          title={`Turn on ${name}`}
          small
          onClose={() => setChoosing(false)}
          footer={
            <>
              <button type="button" class="btn btn--text" onClick={() => setChoosing(false)}>
                Cancel
              </button>
              <button type="button" class="btn" onClick={() => choose(null)}>
                All tabs
              </button>
              <button type="button" class="btn btn--primary" onClick={() => choose(tabId)}>
                This tab too
              </button>
            </>
          }
        >
          <p>
            It is on in {plural(scope.tabs, 'other tab')}. Add this tab, or turn it on in every tab?
          </p>
        </Dialog>
      )}
      {blocked && (
        <div
          class={access.status === 'denied' ? 'prow__access prow__access--denied' : 'prow__access'}
        >
          <ShieldAlert class="icon" size={16} aria-hidden="true" />
          <div class="grow stack">
            <span>
              {access.status === 'denied'
                ? `Site access not granted for ${access.label}.`
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
