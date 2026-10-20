# @headerbench/extension

The Manifest V3 extension: one service worker (`src/sw/`) and one Preact UI rendered as the popup,
the full-page editor (`app.html`) and the welcome page. The rule logic lives in `@headerbench/core`.

## Commands

| Command | What it does |
|---|---|
| `npm run build -w extension` | Store build into `extension/dist/` (unminified, no host permissions) |
| `npm run build:e2e -w extension` | Same with `HB_E2E=1` (see below), into `extension/dist-e2e/` |
| `npm run package` (root) | Store build, then `dist/headerbench-<version>.zip` at the repo root. Fails unless `HB_LICENSE_PUBLIC_KEY` is set to the production key; refuses an E2E build. |
| `npm test -w extension` | Vitest unit and component tests (jsdom, fake `chrome` in `test/chrome-fake.ts`) |

## Build env vars

Read by `tooling/env.ts`, injected into `src/config.ts` through Vite `define`. None is secret.

| Var | Default | Meaning |
|---|---|---|
| `HB_E2E` | unset | `1` builds the test flavour: `host_permissions` for `http://127.0.0.1/*` and `http://localhost/*`, plus `declarativeNetRequestFeedback` so `getMatchedRules` works without a toolbar click, and localhost in `externally_connectable`. Never ship it. |
| `HB_LICENSE_PUBLIC_KEY` | core's `DEV_LICENSE_PUBLIC_KEY` | 64-hex ed25519 public key licences must be signed with. The dev fallback is for dev, unit-test and E2E builds only: `npm run package` and `npm run check:release` fail without the production key (docs/DEPLOY.md §1). |
| `HB_API_BASE` | `https://headerbench.com` | Origin of the licence API and the site allowed to send `activate-license`. https only (http allowed for localhost). |

## Revoked licences

`revoked.json` is an array of licence ids (`lid`) compiled into the build. A key whose `lid` is listed
no longer turns on Pro. Use it for refunded or charged-back lifetime purchases, which never expire on
their own (docs/DEPLOY.md "Refunded lifetime licences").

## Message API

Extension pages talk to the service worker with `chrome.runtime.sendMessage(request)`. The types are
in `src/messages.ts`. Every reply is `{ ok: true, data }` or `{ ok: false, code, error }`. The UI uses
exactly this API, so E2E tests can drive state from any extension page:

```js
const page = await context.newPage();
await page.goto(`chrome-extension://${id}/app.html`);
const send = (msg) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const { data: snap } = await send({ type: 'getState' });
await send({ type: 'saveState', state: { ...snap.state, profiles: [myProfile] }, rev: snap.rev });
await send({ type: 'activate', profileId: myProfile.id, tabId: null, pauseAt: Date.now() + 5000 });
```

| `type` | Fields | `data` |
|---|---|---|
| `getState` | | `Snapshot`: `{ rev, state, pro, warnings, stats, ruleError, sync, hasCorruptData, version }` |
| `saveState` | `state`, `rev` (from the last snapshot) | `Snapshot`. Fails with `conflict` if `rev` is stale, `invalid_state` if malformed. Licence, trial and review fields in `state` are ignored. Starts the trial when the save adds a Pro item. |
| `activate` | `profileId`, `tabId` (number = this tab only, session rules), `pauseAt` (ms or null) | `Snapshot`. One activation per profile; activations follow profile order (= priority). |
| `deactivate` | `profileId` | `Snapshot` |
| `setPaused` | `paused` | `Snapshot` |
| `testUrl` | `url`, `resourceType`, `method`, `tabId?`, `initiator?` (URL of the page that sends the request) | `{ matches, origin, hasHostAccess, pageOrigin, hasPageAccess }` (core `Match[]`). Chrome needs access to both the URL and the initiator. |
| `getMatchesForTab` | `tabId`, `url?` | `{ unavailable: false, applied, explain }` or `{ unavailable: true, reason, explain }` |
| `importText` | `text`, `apply` (false = preview only) | `{ report, summary, profileIds, snapshot }` |
| `applyLicense` | `key` | `{ snapshot, plan, expired, expiresAt, skipped }`; `license_invalid` with a reason otherwise |
| `refreshLicense` | `auto` (true = only when within 14 days of expiry, at most every 6 h) | same as `applyLicense`; errors `subscription_inactive` or `network` keep the old key |
| `startTrial` | | `Snapshot` |
| `setReviewState` | `state`: `shown`, `dismissed` or `rated` | `Snapshot` |
| `getDiagnostics` | | `{ text }` (no header values, variables or licence key) |
| `getCorruptData` / `discardCorruptData` | | `{ json }` / `Snapshot` |

Profiles must be complete `Profile` objects (see `packages/core/src/model.ts`); `newProfile()` from
core builds one. Auto-pause uses one `chrome.alarms` alarm (`headerbench-wake`); unpacked builds may
use delays under 30 s.

From `https://headerbench.com` (`externally_connectable`), the only message is
`chrome.runtime.sendMessage(EXTENSION_ID, { type: 'activate-license', key })`. The reply is
`{ ok: true, plan, expiresAt }` or `{ ok: false, reason }`. Expired keys are refused.

The popup reads the active tab with `chrome.tabs.query`. When it is opened as a page (E2E,
screenshots), `popup.html?tab=<tabId>` points it at another tab.

## Layout

- `tooling/`: env parsing, manifest generator, icon rendering (`assets/icon.svg` → 16/32/48/128 PNG)
- `src/sw/`: `background.ts` (all logic, injectable `chrome`), `store.ts` (state + backup + corrupt
  recovery), `rules.ts` (atomic rule replacement; drops single rules Chrome rejects), `sync.ts`,
  `license.ts`, `badge.ts`, `matches.ts`, `diagnostics.ts`
- `src/ui/`: `store.ts` (snapshot + debounced saves), `access.ts` (site-access flow),
  `popup/`, `editor/`, `pages/`, `welcome/`, `dialogs/`, `components/`, `styles/`
