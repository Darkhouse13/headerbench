import { newProfile } from '@headerbench/core';
import { ChevronRight, FilePlus2, FileUp, Pin, ShieldCheck } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Logo } from '../components/Logo';
import { Toasts } from '../components/Toasts';
import { useStore } from '../context';
import { ImportDialog } from '../dialogs/ImportDialog';

export function Welcome() {
  const store = useStore();
  const [importing, setImporting] = useState(false);

  const openEditor = (hash: string): void => {
    location.href = `app.html${hash}`;
  };

  const startBlank = async (): Promise<void> => {
    const profile = newProfile({ existing: store.state.profiles, now: store.platform.now() });
    store.update((s) => ({ ...s, profiles: [...s.profiles, profile] }));
    await store.flush();
    openEditor(`#/profile/${profile.id}`);
  };

  return (
    <div class="welcome">
      <main class="welcome__inner">
        <div class="welcome__brand">
          <Logo size={32} />
          <span>Headerbench</span>
        </div>
        <h1>Headerbench is installed</h1>
        <p class="welcome__lead">
          Change HTTP request and response headers, redirect or block requests, for the sites you
          choose. How do you want to start?
        </p>

        <div class="choices">
          <button type="button" class="choice" onClick={() => setImporting(true)}>
            <span class="choice__icon">
              <FileUp class="icon" size={24} aria-hidden="true" />
            </span>
            <span class="grow">
              <span class="choice__title">Import from ModHeader</span>
              <span class="choice__text">
                Bring over the profiles you exported from ModHeader as a .json file. You see what
                will be imported before anything is saved.
              </span>
            </span>
            <ChevronRight class="icon choice__chevron" size={20} aria-hidden="true" />
          </button>
          <button type="button" class="choice" onClick={() => void startBlank()}>
            <span class="choice__icon">
              <FilePlus2 class="icon" size={24} aria-hidden="true" />
            </span>
            <span class="grow">
              <span class="choice__title">Start with a blank profile</span>
              <span class="choice__text">
                Create a profile, add a header such as Authorization or X-Api-Key, then choose the
                sites it applies to.
              </span>
            </span>
            <ChevronRight class="icon choice__chevron" size={20} aria-hidden="true" />
          </button>
        </div>

        <ul class="welcome__notes">
          <li>
            <ShieldCheck class="icon" size={18} aria-hidden="true" />
            <span>
              Headerbench has no access to any site yet. When you turn on a profile, it asks Chrome
              for access to the sites that profile changes and the page you're using it on, nothing
              more. It collects nothing and sends nothing anywhere.
            </span>
          </li>
          <li>
            <Pin class="icon" size={18} aria-hidden="true" />
            <span>
              Pin Headerbench from the puzzle-piece menu in the toolbar. Its badge then shows which
              profile is on.
            </span>
          </li>
        </ul>
        <p class="welcome__footnote">Headerbench is not affiliated with ModHeader.</p>
      </main>
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(ids) => openEditor(ids[0] ? `#/profile/${ids[0]}` : '#/')}
        />
      )}
      <Toasts />
    </div>
  );
}
