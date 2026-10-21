import { RefreshCw } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Banner, Button } from './controls';
import { useSnapshot, useStore } from '../context';
import { formatAgo, formatDate } from '../format';

/** Paste a licence key, see what it unlocks, and refresh a yearly key. */
export function LicenseForm({ id }: { id: string }) {
  const store = useStore();
  const { pro, state, licenseRefreshError } = useSnapshot();
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const hasKey = state.settings.licenseKey !== null;

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'success', text: await fn() });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const apply = (): Promise<void> =>
    run(async () => {
      const outcome = await store.call({ type: 'applyLicense', key });
      setKey('');
      const plan = outcome.plan === 'pro_lifetime' ? 'Pro lifetime' : 'Pro yearly';
      if (outcome.expired && outcome.expiresAt !== null) {
        return `${plan} key saved, but it expired on ${formatDate(outcome.expiresAt)}. Use Refresh to renew it.`;
      }
      return outcome.expiresAt === null
        ? `${plan} is active. Thank you.`
        : `${plan} is active until ${formatDate(outcome.expiresAt)}. Thank you.`;
    });

  const refresh = (): Promise<void> =>
    run(async () => {
      const outcome = await store.call({ type: 'refreshLicense', auto: false });
      if (outcome.skipped) return 'Lifetime licences never need refreshing.';
      return outcome.expiresAt === null
        ? 'Licence refreshed.'
        : `Licence refreshed. Active until ${formatDate(outcome.expiresAt)}.`;
    });

  return (
    <div class="stack">
      {hasKey && pro.plan !== null && (
        <div class="row row--wrap">
          <span class="grow">
            {pro.plan === 'pro_lifetime'
              ? 'Pro lifetime licence on this browser.'
              : pro.licenseExpiresAt !== null && pro.licenseExpiresAt > store.platform.now()
                ? `Pro yearly licence, active until ${formatDate(pro.licenseExpiresAt)}.`
                : `Pro yearly licence, expired${pro.licenseExpiresAt ? ` on ${formatDate(pro.licenseExpiresAt)}` : ''}.`}
          </span>
          {pro.plan === 'pro_yearly' && (
            <Button small icon={RefreshCw} disabled={busy} onClick={() => void refresh()}>
              Refresh licence
            </Button>
          )}
        </div>
      )}
      {hasKey && licenseRefreshError && (
        <Banner tone="warning" title="The automatic licence refresh failed">
          {licenseRefreshError.message} Last try{' '}
          {formatAgo(licenseRefreshError.at, store.platform.now())}.
        </Banner>
      )}
      <div class="field">
        <label class="field__label" for={id}>
          {hasKey ? 'Replace licence key' : 'Licence key'}
        </label>
        <textarea
          id={id}
          class="textarea textarea--short mono"
          rows={2}
          spellcheck={false}
          aria-describedby={`${id}-help`}
          value={key}
          onInput={(e) => setKey(e.currentTarget.value)}
        />
        <span class="field__help" id={`${id}-help`}>
          Paste the key from your activation page or receipt email. It starts with HB1. and is
          checked on this device. To renew a yearly key, Headerbench sends only the key to
          headerbench.com, in the 14 days before it ends or when you click Refresh.
        </span>
      </div>
      <div>
        <Button variant="primary" disabled={busy || key.trim() === ''} onClick={() => void apply()}>
          Activate
        </Button>
      </div>
      {message && (
        <Banner tone={message.tone} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </Banner>
      )}
    </div>
  );
}
