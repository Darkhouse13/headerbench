# @headerbench/extension

The Manifest V3 extension: one service worker (`src/sw/`) and one Preact UI rendered as the popup,
the full-page editor (`app.html`) and the welcome page. The rule logic lives in `@headerbench/core`.

## Commands

| Command | What it does |
|---|---|
| `npm run build -w extension` | Store build into `extension/dist/` (unminified, no host permissions) |
| `npm run build:e2e -w extension` | Same with `HB_E2E=1` (see below), into `extension/dist-e2e/` |
| `npm run package` (root) | Store build, then `dist/headerbench-<version>.zip` and `dist/headerbench-<version>.txt` (git commit, clean/dirty) at the repo root. Fails unless `HB_LICENSE_PUBLIC_KEY` is the production key in `scripts/release-key.mjs` (`--allow-other-key` to override) and the git tree is clean (`--allow-dirty`). Ignores `HB_E2E` and `HB_API_BASE`, then checks the built folder like `check:release`. `--out-dir <dir>` writes elsewhere. Same sources and version give a byte-identical zip. |
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
| `getState` | | `Snapshot`: `{ rev, state, pro, warnings, stats, ruleError, sync, licenseRefreshError, hasCorruptData, version }`. `licenseRefreshError` is `{ at, code, message }` or null: the last automatic licence refresh that failed (cleared on success or when a key is applied). |
| `saveState` | `state`, `rev` (from the last snapshot) | `Snapshot`. Fails with `conflict` if `rev` is stale, `invalid_state` if malformed, `storage_full` when Chrome's 10 MB is used up (nothing saved). Licence, trial and review fields in `state` are ignored. Starts the trial when the save adds a Pro item, unless a licence key (even an expired one) is stored. A profile re-added after a delete (undo) gets a fresh `updatedAt`. |
| `activate` | `profileId`, `tabId` (number = this tab, session rules; null = all tabs), `pauseAt` (ms or null) | `Snapshot`. `tabId: null` replaces all of the profile's activations. A tab id adds that tab and keeps the profile's other tabs (same tab again updates its `pauseAt`); it replaces a global activation. Activations follow profile order (= priority). |
| `deactivate` | `profileId`, `tabId?` | `Snapshot`. Without `tabId`: off everywhere. With `tabId`: only that tab's activation is removed (a global activation is not touched). |
| `setPaused` | `paused` | `Snapshot` |
| `testUrl` | `url`, `resourceType`, `method`, `tabId?`, `initiator?` (URL of the page that sends the request) | `{ matches, origin, hasHostAccess, pageOrigin, hasPageAccess }` (core `Match[]`). Chrome needs access to both the URL and the initiator. |
| `getMatchesForTab` | `tabId`, `url?` | `{ unavailable: false, applied, explain }` or `{ unavailable: true, reason, explain }` |
| `importText` | `text`, `apply` (false = preview only) | `{ report, summary, profileIds, snapshot }` |
| `applyLicense` | `key` | `{ snapshot, plan, expired, expiresAt, skipped }`; `license_invalid` with a reason otherwise |
| `refreshLicense` | `auto` (true = only for a yearly key in its last 14 days before expiry, at most every 6 h; failures are also stored as `licenseRefreshError`) | same as `applyLicense`; errors `subscription_inactive` or `network` keep the old key. A newer key for the same licence is accepted even if it ends sooner (the server caps yearly keys at 60 days). |
| `startTrial` | | `Snapshot`. No-op when a licence key is stored, even an expired one. |
| `setReviewState` | `state`: `shown`, `dismissed` or `rated` | `Snapshot` |
| `getDiagnostics` | | `{ text }` (no header values, variables or licence key) |
| `getCorruptData` / `discardCorruptData` | | `{ json }` / `Snapshot` |

Profiles must be complete `Profile` objects (see `packages/core/src/model.ts`); `newProfile()` from
core builds one. Auto-pause uses one `chrome.alarms` alarm (`headerbench-wake`); unpacked builds may
use delays under 30 s. A second alarm, `headerbench-license` (every 6 h, re-armed on install, update
and browser start), refreshes a yearly licence in its last 14 days; it makes no request otherwise.
Install, update and browser start check too. The request is `POST /api/license/refresh` with only
the key.

Error codes: `invalid_request`, `invalid_state`, `storage_full`, `conflict` (reply carries the latest
`snapshot`), `not_found`, `license_invalid`, `subscription_inactive`, `network`, `internal`.

`chrome.storage.local` keys besides `state`, `state.backup`, `state.corrupt` and `rev`: `runtime`
(rule errors, rejected and split rules), `syncStatus`, `licenseRefreshError`, `syncTombstones`,
`syncVariablesUpdatedAt`, `syncOrderUpdatedAt`, `deviceId`, `licenseRefreshAttemptAt`. Pages that re-read the snapshot on
storage changes should watch `licenseRefreshError` too. `state.backup` is skipped when the state is
over 4 MB. A damaged current-schema `state` is repaired in place when no profile is lost (else the
backup is used); either way the raw blob goes to `state.corrupt`.

## Sync

Pro sync mirrors profiles and variables to `chrome.storage.sync` (meta `hb.meta` with `v: 1`, so 1.0.2
can still read it; chunks `hb.0…`). The payload is v2: `{ v: 2, profiles, variables, deleted,
variablesUpdatedAt, orderUpdatedAt }` (v1 payloads decode with no tombstones and stamps 0). Nothing is ever replaced wholesale:
every push reads the mirror, merges, saves the merge locally and writes it back only if the mirror
lacks something; a change from another device is merged the same way. Merge rules (`mergeRemote` in
`src/sw/sync.ts`): profiles union by id, newer `updatedAt` wins (ties settle the same on every
device); a tombstone deletes a profile only if newer than its `updatedAt`; tombstones are kept 30
days; variables come as one list from the side with the newer `variablesUpdatedAt` (union on a tie).
Profile order is rule priority: it comes from the side with the newer `orderUpdatedAt` (stamped
when a save changes the relative order of existing profiles; adds and deletes don't), so an edit
made elsewhere never undoes a reorder. On a tie a push keeps the local order and a remote change
the remote one. A profile only one side has stays next to the profile it followed there.
Sync becoming active for any reason (toggle, licence, trial) merges before the first push, and
browser start catches up. Activations stay local; those of profiles a merge removed are dropped.

From `https://headerbench.com` (`externally_connectable`), the only message is
`chrome.runtime.sendMessage(EXTENSION_ID, { type: 'activate-license', key })`. The reply is
`{ ok: true, plan, expiresAt }` or `{ ok: false, reason }`. Expired keys are refused.

The popup reads the active tab with `chrome.tabs.query`. When it is opened as a page (E2E,
screenshots), `popup.html?tab=<tabId>` points it at another tab.

## Layout

- `tooling/`: env parsing, manifest generator, icon rendering (`assets/icon.svg` → 16/32/48/128 PNG)
- `src/sw/`: `background.ts` (all logic, injectable `chrome`), `store.ts` (state + backup + corrupt
  recovery), `rules.ts` (atomic rule replacement; splits a rejected header rule per header name, drops
  the whole rule once two of its parts are refused (a bad condition), drops single rules Chrome
  rejects; gives up after 20 refused compiled rules per list), `sync.ts` (payload, merge, tombstones),
  `license.ts`, `badge.ts`, `matches.ts`, `diagnostics.ts`
- `src/ui/`: `store.ts` (snapshot + debounced saves), `access.ts` (site-access flow),
  `popup/`, `editor/`, `pages/`, `welcome/`, `dialogs/`, `components/`, `styles/`
