import type { EnvTag, Profile } from '@headerbench/core';
import { ENV_TAGS, PROFILE_COLORS, badgeFor } from '@headerbench/core';
import { Check, Copy, Download, Pipette, Trash2 } from 'lucide-preact';
import { Button, Field, Segmented } from '../components/controls';
import { ENV_LABELS } from '../format';

/** Names for PROFILE_COLORS, for screen readers. */
const COLOR_NAMES: Record<string, string> = {
  '#1a73e8': 'Blue',
  '#188038': 'Green',
  '#c5221f': 'Red',
  '#b06000': 'Orange',
  '#8430ce': 'Purple',
  '#007b83': 'Teal',
  '#5f6368': 'Grey',
};

interface Props {
  profile: Profile;
  onChange: (patch: Partial<Profile>) => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}

export function ProfileSettings({ profile, onChange, onDuplicate, onExport, onDelete }: Props) {
  const customColor = !PROFILE_COLORS.includes(profile.color);
  return (
    <div class="panel">
      <section class="panel__section form-grid">
        <Field label="Name" htmlFor="profile-name">
          <input
            id="profile-name"
            class="input"
            value={profile.name}
            maxLength={80}
            onInput={(e) => onChange({ name: e.currentTarget.value })}
          />
        </Field>
        <Field
          label="Badge"
          htmlFor="profile-badge"
          help={`Shown on the toolbar icon while this profile is the only one on. Empty uses "${badgeFor(profile.name)}".`}
        >
          <input
            id="profile-badge"
            class="input input--badge"
            value={profile.badge}
            maxLength={2}
            onInput={(e) => onChange({ badge: e.currentTarget.value.slice(0, 2) })}
          />
        </Field>
        <div class="field">
          <span class="field__label" id="profile-color-label">
            Colour
          </span>
          <div class="swatches" role="radiogroup" aria-labelledby="profile-color-label">
            {PROFILE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={profile.color === c}
                aria-label={COLOR_NAMES[c] ?? c}
                class="swatch"
                style={{ background: c }}
                onClick={() => onChange({ color: c })}
              >
                {profile.color === c && <Check class="icon" size={16} aria-hidden="true" />}
              </button>
            ))}
            <label
              class={customColor ? 'swatch swatch--custom is-selected' : 'swatch swatch--custom'}
              style={customColor ? { background: profile.color, color: '#ffffff' } : undefined}
              title="Custom colour"
            >
              <Pipette class="icon" size={14} aria-hidden="true" />
              <span class="sr-only">Custom colour</span>
              <input
                type="color"
                value={profile.color}
                onInput={(e) => onChange({ color: e.currentTarget.value.toLowerCase() })}
              />
            </label>
          </div>
        </div>
        <div class="field">
          <span class="field__label">Environment</span>
          <Segmented<EnvTag>
            label="Environment"
            value={profile.env}
            options={ENV_TAGS.map((e) => ({ value: e, label: ENV_LABELS[e] }))}
            onChange={(env) => onChange({ env })}
          />
          <span class="field__help">
            A tag shown next to the name. Turning on a Prod profile asks for confirmation first.
          </span>
        </div>
      </section>
      <section class="panel__section">
        <h2>Manage</h2>
        <div class="row row--wrap">
          <Button icon={Copy} onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button icon={Download} onClick={onExport}>
            Export this profile
          </Button>
          <Button icon={Trash2} variant="danger" onClick={onDelete}>
            Delete profile
          </Button>
        </div>
      </section>
    </div>
  );
}
