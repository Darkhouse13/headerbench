import type { Match, Method, ResourceType } from '@headerbench/core';
import { METHODS, RESOURCE_TYPES } from '@headerbench/core';
import { CircleCheck, CircleMinus, SearchCheck, ShieldAlert } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
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

function MatchRow({ match }: { match: Match }) {
  const { action, detail } = describeEffect(match.effect);
  const Icon = match.applied ? CircleCheck : CircleMinus;
  return (
    <li class={match.applied ? 'match match--applied' : 'match'}>
      <Icon
        class="icon match__icon"
        size={18}
        aria-label={match.applied ? 'Applies' : 'Does not apply'}
      />
      <div class="grow">
        <div class="match__action">{action}</div>
        {detail && <div class="match__detail mono">{detail}</div>}
        {match.reason && <div class="match__reason">{match.reason}</div>}
        {match.warnings.map((w, i) => (
          <Issue key={i} tone={w.severity === 'error' ? 'error' : 'warning'}>
            {w.message}
          </Issue>
        ))}
      </div>
    </li>
  );
}

export function TestUrlPage({ initialUrl }: { initialUrl: string }) {
  const store = useStore();
  const { platform } = store;
  const [url, setUrl] = useState(initialUrl);
  const [resourceType, setResourceType] = useState<ResourceType>('main_frame');
  const [method, setMethod] = useState<Method>('get');
  const [initiator, setInitiator] = useState('');
  const [result, setResult] = useState<TestUrlResult | null>(null);
  const [tested, setTested] = useState('');

  const run = async (): Promise<void> => {
    if (url.trim() === '') return;
    setTested(url.trim());
    const from = initiator.trim();
    setResult(
      await store.call({
        type: 'testUrl',
        url: url.trim(),
        resourceType,
        method,
        ...(from ? { initiator: from } : {}),
      }),
    );
  };

  useEffect(() => {
    if (initialUrl) void run();
    // Runs once for a URL handed over from the popup.
  }, []);

  const host = result?.origin ? new URL(result.origin).host : null;
  const groups = new Map<string, Match[]>();
  for (const m of result?.matches ?? [])
    groups.set(m.profileName, [...(groups.get(m.profileName) ?? []), m]);
  const applied = result?.matches.filter((m) => m.applied).length ?? 0;
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
    if (missing.length === 0) return;
    if (await platform.permissions.request(missing).catch(() => false)) await run();
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
            type="url"
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
              type="url"
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

      {result && result.origin === null && (
        <Banner tone="error">
          Enter a full URL that starts with http:// or https://, for example
          https://api.example.com/v1/users.
        </Banner>
      )}
      {result && result.origin !== null && (
        <section class="card test-results" aria-live="polite">
          <div class="card__section">
            <h2>
              {result.matches.length === 0
                ? 'No rule matches this request'
                : `${plural(applied, 'rule')} would apply to ${host}`}
            </h2>
            <p class="muted mono truncate" title={tested}>
              {METHOD_LABELS[method]} {tested}
            </p>
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
