/** "Applied on this tab": what Chrome reports it changed on the current tab, or why nothing did. */
import type { Match } from '@headerbench/core';
import { RefreshCw, RotateCw, SearchCheck, ShieldAlert } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { activeProfiles } from '../../activations';
import type { TabMatches } from '../../messages';
import { Button, IconButton, Issue } from '../components/controls';
import { useStore } from '../context';
import { describeEffect, plural } from '../format';
import type { ActiveTab } from '../platform';

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null;
  } catch {
    return null;
  }
}

function explanation(explain: Match[], anyOn: boolean, host: string): string {
  const blocked = explain.find((m) => !m.applied && m.reason);
  if (blocked?.reason) return blocked.reason;
  if (!anyOn) return 'No profile is on. Turn one on above.';
  return `No profile that is on covers ${host}.`;
}

export interface PageAccess {
  /** Hostname of the tab's page. */
  host: string;
  /** Asks Chrome for the page. Must be called from a click handler. */
  grant: () => Promise<boolean>;
}

export function AppliedOnTab({
  tab,
  pageAccess,
  onTest,
}: {
  tab: ActiveTab;
  /** Set when a profile that is on changes requests but Chrome has no access to this page. */
  pageAccess: PageAccess | null;
  onTest: (url: string) => void;
}) {
  const store = useStore();
  const [result, setResult] = useState<TabMatches | 'error' | null>(null);
  const host = hostOf(tab.url);
  const anyOn = activeProfiles(store.state, store.platform.now()).length > 0;

  const load = useCallback(() => {
    setResult(null);
    store
      .send({ type: 'getMatchesForTab', tabId: tab.id, ...(tab.url ? { url: tab.url } : {}) })
      .then(setResult, () => setResult('error'));
  }, [store, tab.id, tab.url]);

  useEffect(load, [load]);

  return (
    <section class="popup__section applied" aria-labelledby="popup-applied">
      <div class="section-head">
        <h2 id="popup-applied">Applied on this tab</h2>
        {host && <span class="applied__host truncate">{host}</span>}
        <span class="grow" />
        <IconButton icon={RefreshCw} small label="Check again" onClick={load} />
      </div>
      {pageAccess && (
        <div class="applied__access">
          <ShieldAlert class="icon" size={16} aria-hidden="true" />
          <div class="grow stack">
            <span>
              Chrome only lets Headerbench change requests sent from pages it can access. Grant
              access to {pageAccess.host}?
            </span>
            <div>
              <Button
                small
                variant="primary"
                onClick={() => void pageAccess.grant().then((ok) => ok && load())}
              >
                Grant
              </Button>
            </div>
          </div>
        </div>
      )}
      <div class="applied__body">{renderBody()}</div>
    </section>
  );

  function renderBody() {
    if (tab.url && !host) {
      return (
        <Issue tone="info">Chrome does not let extensions change requests on this page.</Issue>
      );
    }
    if (result === null) return <p class="muted">Checking this tab…</p>;
    if (result === 'error') {
      return (
        <Issue tone="error">
          Headerbench could not read this tab. Reload the popup to try again.
        </Issue>
      );
    }
    if (result.unavailable) {
      return (
        <div class="stack">
          <Issue tone="info">{result.reason}</Issue>
          {tab.url && (
            <div>
              <Button small icon={SearchCheck} onClick={() => onTest(tab.url as string)}>
                Test this URL instead
              </Button>
            </div>
          )}
        </div>
      );
    }
    if (result.applied.length > 0) {
      return (
        <ul class="applied__list">
          {result.applied.map((a, i) => {
            const { action, detail } = describeEffect(a.effect);
            return (
              <li key={i} class="applied__item">
                <span class="dot" style={{ background: a.color }} aria-hidden="true" />
                <div class="grow">
                  <div class="applied__action truncate">{action}</div>
                  {detail && (
                    <div class="applied__detail mono truncate" title={detail}>
                      {detail}
                    </div>
                  )}
                </div>
                <div class="applied__by" title={`${plural(a.hits, 'request')} matched`}>
                  {a.profileName}
                </div>
              </li>
            );
          })}
        </ul>
      );
    }
    const wouldApply = result.explain.some((m) => m.applied);
    if (wouldApply) {
      return (
        <div class="stack">
          <p class="muted">Your rules match this page, but it loaded before they were on.</p>
          <div>
            <Button
              small
              icon={RotateCw}
              onClick={() => void store.platform.reloadTab(tab.id).then(load)}
            >
              Reload the page
            </Button>
          </div>
        </div>
      );
    }
    return (
      <p class="muted">
        Nothing applied since this page loaded.{' '}
        {explanation(result.explain, anyOn, host ?? 'this page')}
      </p>
    );
  }
}
