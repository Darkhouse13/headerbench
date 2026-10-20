import { TRIAL_DAYS } from '@headerbench/core';
import { Braces, Check, ExternalLink, FileJson, RefreshCcw, Regex } from 'lucide-preact';
import { PRO_URL } from '../../config';
import { Banner, Button } from '../components/controls';
import { LicenseForm } from '../components/LicenseForm';
import { useSnapshot, useStore } from '../context';
import { proSummary } from '../format';

const FEATURES = [
  {
    icon: FileJson,
    title: 'Mock responses',
    text: 'Return your own JSON or text for an API call, without a server.',
  },
  {
    icon: Regex,
    title: 'Regex redirects',
    text: 'Capture parts of a URL and reuse them, e.g. send a production bundle to localhost.',
  },
  {
    icon: Braces,
    title: 'Shared variables',
    text: 'Write {{token}} once and use it in every profile. Change it in one place.',
  },
  {
    icon: RefreshCcw,
    title: 'Sync across devices',
    text: 'Your profiles follow you to every Chrome signed in to your account.',
  },
];

export function ProPage() {
  const store = useStore();
  const { pro } = useSnapshot();
  const { platform } = store;
  const now = platform.now();
  const licensed = pro.pro && pro.source === 'license';
  const canTrial = pro.trialEndsAt === null && pro.source !== 'license';
  const canUpgrade = licensed && pro.plan === 'pro_yearly';

  return (
    <div class="page">
      <header class="page__head">
        <h1>Headerbench Pro</h1>
        <p class="muted">
          Mock API responses, regex redirects, shared variables and sync across devices. Free
          features stay free and unlimited.
        </p>
      </header>

      <Banner
        tone={pro.pro ? 'success' : 'neutral'}
        title={proSummary(pro, now)}
        actions={
          (canTrial && (
            <Button small variant="primary" onClick={() => void store.call({ type: 'startTrial' })}>
              Start {TRIAL_DAYS}-day free trial
            </Button>
          )) ||
          (canUpgrade && (
            <Button
              small
              variant="text"
              icon={ExternalLink}
              onClick={() => void platform.openUrl(PRO_URL)}
            >
              Switch to lifetime
            </Button>
          ))
        }
      >
        {canTrial
          ? 'The trial needs no card and no account. It also starts by itself the first time you add a Pro rule.'
          : 'If Pro lapses, Pro rules pause. Nothing is deleted, and free features keep working.'}
      </Banner>

      <section class="features">
        {FEATURES.map((f) => (
          <div key={f.title} class="feature">
            <f.icon class="icon" size={20} aria-hidden="true" />
            <div>
              <h3>{f.title}</h3>
              <p class="muted">{f.text}</p>
            </div>
          </div>
        ))}
      </section>

      {!licensed && <Plans onBuy={() => void platform.openUrl(PRO_URL)} />}

      <section class="card card__section stack" aria-labelledby="pro-licence">
        <h2 id="pro-licence">{licensed ? 'Your licence key' : 'Already bought Pro?'}</h2>
        <LicenseForm id="pro-licence-key" />
      </section>
    </div>
  );
}

function Plans({ onBuy }: { onBuy: () => void }) {
  return (
    <>
      <section class="plans" aria-label="Plans">
        <div class="plan card">
          <div class="plan__head">
            <h2>Yearly</h2>
          </div>
          <div class="plan__price">
            $36<span class="muted"> / year</span>
          </div>
          <p class="muted">Renews yearly. Cancel anytime from your receipt email.</p>
          <ul class="plan__list">
            <li>
              <Check class="icon" size={16} aria-hidden="true" />
              All Pro features
            </li>
            <li>
              <Check class="icon" size={16} aria-hidden="true" />
              30-day refund, no questions
            </li>
          </ul>
          <Button variant="primary" icon={ExternalLink} onClick={onBuy}>
            Buy on headerbench.com
          </Button>
        </div>
        <div class="plan card">
          <div class="plan__head">
            <h2>Lifetime</h2>
          </div>
          <div class="plan__price">
            $79<span class="muted"> once</span>
          </div>
          <p class="muted">All Pro features, current and future, for this major version.</p>
          <ul class="plan__list">
            <li>
              <Check class="icon" size={16} aria-hidden="true" />
              No renewals
            </li>
            <li>
              <Check class="icon" size={16} aria-hidden="true" />
              30-day refund, no questions
            </li>
          </ul>
          <Button icon={ExternalLink} onClick={onBuy}>
            Buy on headerbench.com
          </Button>
        </div>
      </section>
      <p class="muted small">
        Paddle.com is our reseller and merchant of record, and handles tax and invoices. After
        checkout, the activation page sends the licence key to Headerbench, or you can paste it
        below.
      </p>
    </>
  );
}
