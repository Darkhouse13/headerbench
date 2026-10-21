import type { Match, Method, ResourceType } from '@headerbench/core';
import { METHODS, RESOURCE_TYPES } from '@headerbench/core';
import type { LucideIcon } from 'lucide-preact';
import { CircleCheck, CircleHelp, CircleMinus, SearchCheck, ShieldAlert } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { activeProfiles } from '../../activations';
import type { TestUrlResult } from '../../messages';
import { Banner, Button, EmptyState, Field, Issue } from '../components/controls';
import { useStore } from '../context';
import { METHOD_LABELS, RESOURCE_TYPE_LABELS, describeEffect, plural } from '../format';

/** Host permission for every port and path of an origin such as `http://localhost:5173`. */
function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

function originLabelOf(pattern: string | null): string {
  return /^[^:]+:\/\/([^/]+)\//.exec(pattern ?? '')?.[1] ?? 'it';
}

/** What the tester concluded about one rule. */
function verdict(match: Match): { icon: LucideIcon; label: string; modifier: string | null } {
  if (match.applied) return { icon: CircleCheck, label: 'Applies', modifier: 'match--applied' };
  if (!match.previewed) {
    return { icon: CircleHelp, label: "Can't preview", modifier: 'match--unknown' };
  }
  return { icon: CircleMinus, label: 'Does not apply', modifier: null };
}

function MatchRow({ match }: { match: Match }) {
  const { action, detail } = describeEffect(match.effect);
  const { icon: Icon, label, modifier } = verdict(match);
  return (
    <li class={modifier ? `match ${modifier}` : 'match'}>
      <Icon class="icon match__icon" size={18} aria-label={label} />
      <div class="grow">
        <div class="match__action">{action}</div>
        {detail && <div class="match__detail mono">{detail}</div>}
        {match.reason && <div class="match__reason">{match.reason}</div>}
        {match.notes.map((note) => (
          <Issue key={note} tone="info">
            {note}
          </Issue>
        ))}
        {match.warnings.map((w, i) => (
          <Issue key={i} tone={w.severity === 'error' ? 'error' : 'warning'}>
            {w.message}
          </Issue>
        ))}
      </div>
    </li>
  );
}

/** The request a result answers, as it was sent. */
interface Tested {
  url: string;
  method: Method;
  resourceType: ResourceType;
  /** The sending page, when one was given. */
  initiator?: string;
}

export function TestUrlPage({ initialUrl }: { initialUrl: string }) {
  const store = useStore();
  const { platform } = store;
  const [url, setUrl] = useState(initialUrl);
  const [resourceType, setResourceType] = useState<ResourceType>('main_frame');
  const [method, setMethod] = useState<Method>('get');
  const [initiator, setInitiator] = useState('');
  const [result, setResult] = useState<TestUrlResult | null>(null);
  const [tested, setTested] = useState<Tested | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest test is shown, whatever order the answers arrive in.
  const latest = useRef(0);

  /** The request the form describes, for `target` (the URL field by default). */
  const fromForm = (target = url): Tested => {
    const from = initiator.trim();
    return { url: target.trim(), method, resourceType, ...(from ? { initiator: from } : {}) };
  };

  const run = async (request: Tested = fromForm()): Promise<void> => {
    if (request.url === '') return;
    const id = ++latest.current;
    try {
      const answer = await store.call({ type: 'testUrl', ...request });
      if (id !== latest.current) return;
      setResult(answer);
      setTested(request);
      setError(null);
    } catch (e) {
      if (id !== latest.current) return;
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    // A URL handed over from the popup, also while this page is already open.
    setUrl(initialUrl);
    if (initialUrl) void run(fromForm(initialUrl));
    // Only a new URL in the address bar starts a test; form edits wait for the Test button.
  }, [initialUrl]);

  const host = result?.origin ? new URL(result.origin).host : null;
  const groups = new Map<string, Match[]>();
  for (const m of result?.matches ?? [])
    groups.set(m.profileName, [...(groups.get(m.profileName) ?? []), m]);
  const applied = result?.matches.filter((m) => m.applied).length ?? 0;
  const unknown = result?.matches.filter((m) => !m.previewed).length ?? 0;
  const missing =
    result?.origin != null
      ? [
          ...(result.hasHostAccess ? [] : [originPattern(result.origin)]),
          ...(result.hasPageAccess || result.pageOrigin === null ? [] : [result.pageOrigin]),
        ]
      : [];
  const needsAccess =
    result !== null &&
    missing.length > 0 &&
    result.matches.some(
      (m) => m.effect.type === 'header' || m.effect.type === 'redirect' || m.effect.type === 'mock',
    );
  const anyOn = activeProfiles(store.state, platform.now()).length > 0;

  const grant = async (): Promise<void> => {
    if (missing.length === 0 || tested === null) return;
    // Re-run the request the result answers, not whatever the form holds now.
    if (await platform.permissions.request(missing).catch(() => false)) await run(tested);
  };

  const heading = (): string => {
    if (result?.matches.length === 0) return 'No rule matches this request';
    const summary = `${plural(applied, 'rule')} would apply to ${host}`;
    return unknown > 0 ? `${summary}, ${unknown} can't be previewed` : summary;
  };

  return (
    <div class="page">
      <header class="page__head">
        <h1>Test a URL</h1>
        <p class="muted">
          See which rules of the profiles that are on would change a request, and why others would
          not.
        </p>
      </header>
      <form
        class="card card__section test-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field label="URL" htmlFor="test-url">
          <input
            id="test-url"
            class="input mono"
            type="text"
            inputMode="url"
            spellcheck={false}
            autocomplete="off"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </Field>
        <Field label="Request type" htmlFor="test-type">
          <select
            id="test-type"
            class="select"
            value={resourceType}
            onChange={(e) => setResourceType(e.currentTarget.value as ResourceType)}
          >
            {RESOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {RESOURCE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Method" htmlFor="test-method">
          <select
            id="test-method"
            class="select"
            value={method}
            onChange={(e) => setMethod(e.currentTarget.value as Method)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <div class="test-form__from">
          <Field
            label="Sent from page (optional)"
            htmlFor="test-initiator"
            help="Chrome changes a request only if Headerbench can also access the page that sends it."
          >
            <input
              id="test-initiator"
              class="input mono"
              type="text"
              inputMode="url"
              spellcheck={false}
              autocomplete="off"
              placeholder="http://localhost:5173/"
              value={initiator}
              onInput={(e) => setInitiator(e.currentTarget.value)}
            />
          </Field>
        </div>
        <Button type="submit" variant="primary" icon={SearchCheck} disabled={url.trim() === ''}>
          Test
        </Button>
      </form>

      {error && (
        <Banner tone="error" title="The test did not run">
          {error}
        </Banner>
      )}
      {result && result.origin === null && (
        <Banner tone="error">
          Enter a full URL that starts with http:// or https://, for example
          https://api.example.com/v1/users.
        </Banner>
      )}
      {result && result.origin !== null && (
        <section class="card test-results" aria-live="polite">
          <div class="card__section">
            <h2>{heading()}</h2>
            {tested && (
              <p class="muted mono truncate" title={tested.url}>
                {METHOD_LABELS[tested.method]} {tested.url} ·{' '}
                {RESOURCE_TYPE_LABELS[tested.resourceType]}
              </p>
            )}
          </div>
          {needsAccess && (
            <div class="card__section">
              <Banner
                tone="warning"
                icon={ShieldAlert}
                actions={
                  <Button small variant="primary" onClick={() => void grant()}>
                    Grant access
                  </Button>
                }
              >
                {result.hasHostAccess
                  ? `Headerbench has no access to the page that sends this request (${originLabelOf(result.pageOrigin)}), so Chrome skips header changes and redirects.`
                  : `Headerbench has no access to ${host}, so Chrome skips header changes and redirects there.`}
              </Banner>
            </div>
          )}
          {result.matches.length === 0 ? (
            <div class="card__section">
              <EmptyState
                icon={SearchCheck}
                title={anyOn ? `Nothing covers ${host}` : 'No profile is on'}
              >
                {anyOn
                  ? 'None of the profiles that are on match this URL, request type and method. Check their filters.'
                  : 'Turn on a profile to test its rules against this URL.'}
              </EmptyState>
            </div>
          ) : (
            [...groups.entries()].map(([name, matches]) => (
              <div class="card__section" key={name}>
                <h3 class="test-results__profile">{name}</h3>
                <ul class="match-list">
                  {matches.map((m, i) => (
                    <MatchRow key={i} match={m} />
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}
