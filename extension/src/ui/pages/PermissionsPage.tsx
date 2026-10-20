import { originsFor } from '@headerbench/core';
import { Globe, LockKeyhole, ShieldCheck } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, EmptyState } from '../components/controls';
import { originsOverlap } from '../access';
import { useStore } from '../context';
import { groupGrants, originsLabel } from '../format';

const PERMISSION_REASONS: Record<string, string> = {
  declarativeNetRequestWithHostAccess:
    "Applies your header, redirect and block rules through Chrome's own rule engine, only to requests between the sites listed above.",
  storage: 'Saves your profiles and settings in this browser.',
  activeTab: 'Shows what applied on the tab you open Headerbench on, only at that moment.',
  alarms: 'Turns profiles off when their auto-pause time comes.',
  declarativeNetRequestFeedback:
    'Reads which rules matched. Test builds only; the store version does not ask for it.',
};

export function PermissionsPage() {
  const store = useStore();
  const { platform } = store;
  const [origins, setOrigins] = useState<string[] | null>(null);

  useEffect(() => {
    const load = (): void => void platform.permissions.granted().then(setOrigins);
    load();
    return platform.permissions.onChange(load);
  }, [platform]);

  const usedBy = (granted: string[]): string[] =>
    store.state.profiles
      .filter((p) =>
        originsFor(p).some((needed) => granted.some((origin) => originsOverlap(needed, origin))),
      )
      .map((p) => p.name);

  const revoke = async (granted: string[]): Promise<void> => {
    const removed = await platform.permissions.remove(granted).catch(() => false);
    if (!removed)
      store.notify(
        `Chrome kept access to ${originsLabel(granted)} because this build requires it.`,
        'error',
      );
  };

  return (
    <div class="page">
      <header class="page__head">
        <h1>Permissions</h1>
        <p class="muted">
          Chrome lets Headerbench change a request only when both the site it goes to and the page
          that sends it are listed below. You granted each one when you turned on a profile or used
          the popup on a page, and you can take any of them back.
        </p>
      </header>

      <section class="card" aria-labelledby="perm-sites">
        <div class="card__section">
          <h2 id="perm-sites">Site access</h2>
        </div>
        {origins === null ? (
          <div class="card__section muted">Reading permissions…</div>
        ) : origins.length === 0 ? (
          <div class="card__section">
            <EmptyState icon={Globe} title="No site access granted">
              When you turn on a profile, Headerbench asks Chrome for access to the sites that
              profile changes and the page you're using it on, nothing more.
            </EmptyState>
          </div>
        ) : (
          <ul class="perm-list">
            {groupGrants(origins).map((grant) => {
              const users = usedBy(grant.origins);
              return (
                <li key={grant.origins.join(' ')} class="perm-item">
                  <Globe class="icon" size={18} aria-hidden="true" />
                  <div class="grow">
                    <div>{grant.label}</div>
                    <div class="small muted mono">{grant.origins.join(', ')}</div>
                    <div class="small muted">
                      {users.length > 0
                        ? `Changed by ${users.join(', ')}`
                        : 'No profile changes requests to this site. Keep it if you use Headerbench on its pages.'}
                    </div>
                  </div>
                  <Button small variant="danger" onClick={() => void revoke(grant.origins)}>
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section class="card" aria-labelledby="perm-always">
        <div class="card__section">
          <h2 id="perm-always">Always granted</h2>
          <p class="muted">None of these shows a warning when you install Headerbench.</p>
        </div>
        <ul class="perm-list">
          {platform.manifestPermissions.map((p) => (
            <li key={p} class="perm-item">
              <LockKeyhole class="icon" size={18} aria-hidden="true" />
              <div class="grow">
                <div class="mono">{p}</div>
                <div class="small muted">
                  {PERMISSION_REASONS[p] ?? 'Required by Chrome for this build.'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="card card__section privacy">
        <ShieldCheck class="icon" size={20} aria-hidden="true" />
        <p>
          Headerbench reads no page content, has no analytics and loads no remote code. Its only
          network request renews a Pro licence when you click Refresh, or when an open Headerbench
          page sees the licence is about to expire.
        </p>
      </section>
    </div>
  );
}
