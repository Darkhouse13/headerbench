import type { Profile } from '@headerbench/core';
import { GripVertical, Plus, Search } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { reorderProfiles } from '../../activations';
import type { ActivationControls } from '../activation';
import { EnvChip, IconButton, ProfileMark, Switch } from '../components/controls';
import { useStore } from '../context';
import { profileName } from '../format';
import { profileHash } from './router';

interface Props {
  selectedId: string | null;
  controls: ActivationControls;
  onCreate: () => void;
}

export function Sidebar({ selectedId, controls, onCreate }: Props) {
  const store = useStore();
  const state = store.state;
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const onIds = new Set(state.settings.activations.map((a) => a.profileId));
  const q = query.trim().toLowerCase();
  const visible = state.profiles
    .map((profile, index) => ({ profile, index }))
    .filter(({ profile }) => q === '' || profile.name.toLowerCase().includes(q));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement;
      const typing = target.closest('input, textarea, select, [contenteditable]');
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const drop = (to: number): void => {
    if (dragging !== null && dragging !== to) store.update((s) => reorderProfiles(s, dragging, to));
    setDragging(null);
    setOver(null);
  };

  const item = ({ profile, index }: { profile: Profile; index: number }) => {
    const classes = ['side-item'];
    if (profile.id === selectedId) classes.push('is-selected');
    if (over === index && dragging !== null && dragging !== index) {
      classes.push(dragging < index ? 'is-drop-below' : 'is-drop-above');
    }
    if (dragging === index) classes.push('is-dragging');
    return (
      <li
        key={profile.id}
        class={classes.join(' ')}
        draggable={q === ''}
        onDragStart={(e) => {
          setDragging(index);
          e.dataTransfer?.setData('text/plain', profile.id);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(index);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          drop(index);
        }}
      >
        <a
          class="side-item__link"
          href={profileHash(profile.id)}
          aria-current={profile.id === selectedId ? 'page' : undefined}
        >
          <GripVertical class="icon side-item__grip" size={16} aria-hidden="true" />
          <ProfileMark profile={profile} small />
          <span class="grow truncate">{profileName(profile)}</span>
          <EnvChip env={profile.env} />
        </a>
        <Switch
          small
          checked={onIds.has(profile.id)}
          label={profileName(profile)}
          onChange={(next) => void (next ? controls.turnOn(profile) : controls.turnOff(profile))}
        />
      </li>
    );
  };

  return (
    <aside class="sidebar" aria-label="Profiles">
      <div class="sidebar__head">
        <h2>Profiles</h2>
        <span class="grow" />
        <IconButton icon={Plus} label="New profile" onClick={onCreate} />
      </div>
      {state.profiles.length > 0 && (
        <div class="sidebar__search">
          <Search class="icon" size={16} aria-hidden="true" />
          <input
            ref={search}
            type="search"
            class="input input--dense"
            aria-label="Search profiles (press / to focus)"
            placeholder="Search profiles"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <kbd class="kbd" aria-hidden="true">
            /
          </kbd>
        </div>
      )}
      <ul class="side-list">{visible.map(item)}</ul>
      {q !== '' && visible.length === 0 && (
        <p class="sidebar__note">No profile matches “{query.trim()}”.</p>
      )}
      {state.profiles.length > 1 && (
        <p class="sidebar__note">
          Higher profiles win when two change the same header. Drag to reorder.
        </p>
      )}
    </aside>
  );
}
