import type { Theme } from '@headerbench/core';
import { ClipboardCopy, Download, Keyboard, Mail, Trash2 } from 'lucide-preact';
import { SUPPORT_EMAIL } from '../../config';
import { Banner, Button, Segmented, Switch } from '../components/controls';
import { LicenseForm } from '../components/LicenseForm';
import { useSnapshot, useStore } from '../context';
import { formatBytes, formatTime } from '../format';
import { navigate } from '../editor/router';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function SettingsPage() {
  const store = useStore();
  const snapshot = useSnapshot();
  const { platform } = store;
  const settings = store.state.settings;
  const setSettings = (patch: Partial<typeof settings>): void =>
    store.update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));

  const diagnostics = async (): Promise<string> =>
    (await store.call({ type: 'getDiagnostics' })).text;

  const copyDiagnostics = async (): Promise<void> => {
    await platform.copyText(await diagnostics());
    store.notify('Diagnostics copied. They contain no header values, variables or licence key.');
  };

  const reportProblem = async (): Promise<void> => {
    const body = `What happened, and what did you expect?\n\n\n---\n${await diagnostics()}`;
    const href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Headerbench problem')}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  };

  const downloadCorrupt = async (): Promise<void> => {
    const { json } = await store.call({ type: 'getCorruptData' });
    if (json) platform.download('headerbench-unreadable-data.json', json);
  };

  return (
    <div class="page">
      <header class="page__head">
        <h1>Settings</h1>
      </header>

      {snapshot.hasCorruptData && (
        <Banner
          tone="warning"
          title="Some saved data could not be read"
          actions={
            <>
              <Button small icon={Download} onClick={() => void downloadCorrupt()}>
                Download it
              </Button>
              <Button
                small
                variant="text"
                icon={Trash2}
                onClick={() => void store.call({ type: 'discardCorruptData' })}
              >
                Discard
              </Button>
            </>
          }
        >
          Headerbench restored your last good save and kept the unreadable copy. Download it if you
          want to send it to support.
        </Banner>
      )}

      <section class="card" aria-labelledby="set-appearance">
        <div class="card__section setting">
          <div class="grow">
            <h2 id="set-appearance">Appearance</h2>
            <p class="muted">System follows your computer's light or dark setting.</p>
          </div>
          <Segmented
            label="Theme"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => setSettings({ theme })}
          />
        </div>
        <div class="card__section setting">
          <div class="grow">
            <h2 id="set-sync">Sync across devices</h2>
            <p class="muted">
              Copies your profiles and variables to the other Chrome browsers signed in to your
              Google account, through Chrome sync. Pro.
            </p>
            {settings.sync && (
              <p class={snapshot.sync.error ? 'small issue--warning' : 'small muted'}>
                {snapshot.sync.error ??
                  (snapshot.sync.lastSyncedAt
                    ? `Last synced ${formatTime(snapshot.sync.lastSyncedAt, platform.now())}, ${formatBytes(snapshot.sync.bytes)} of 100 KB.`
                    : 'Waiting for the first sync.')}
              </p>
            )}
          </div>
          {snapshot.pro.pro || settings.sync ? (
            <Switch
              checked={settings.sync}
              label={settings.sync ? 'Turn off sync' : 'Turn on sync'}
              onChange={(sync) => setSettings({ sync })}
            />
          ) : (
            <Button small onClick={() => navigate('#/pro')}>
              Get Pro
            </Button>
          )}
        </div>
        <div class="card__section setting">
          <Keyboard class="icon" size={20} aria-hidden="true" />
          <div class="grow">
            <h2>Keyboard shortcut</h2>
            <p class="muted">
              <kbd class="kbd">Alt</kbd> + <kbd class="kbd">Shift</kbd> + <kbd class="kbd">H</kbd>{' '}
              pauses or resumes all profiles, unless you changed it.
            </p>
          </div>
          <Button small onClick={() => void platform.openUrl('chrome://extensions/shortcuts')}>
            Change shortcut
          </Button>
        </div>
      </section>

      <section class="card card__section stack" aria-labelledby="set-licence">
        <h2 id="set-licence">Licence</h2>
        <LicenseForm id="settings-licence" />
      </section>

      <section class="card" aria-labelledby="set-support">
        <div class="card__section">
          <h2 id="set-support">Support</h2>
          <p class="muted">
            Written support at {SUPPORT_EMAIL}, usually within one business day. Diagnostics list
            versions, rule counts, warnings and granted sites, never your header values.
          </p>
        </div>
        <div class="card__section row row--wrap">
          <Button icon={ClipboardCopy} onClick={() => void copyDiagnostics()}>
            Copy diagnostics
          </Button>
          <Button icon={Mail} onClick={() => void reportProblem()}>
            Report a problem
          </Button>
          <span class="grow" />
          <span class="muted small">Headerbench {snapshot.version}</span>
        </div>
      </section>
    </div>
  );
}
