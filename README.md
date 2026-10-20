# Headerbench

Headerbench is a Manifest V3 extension for Chrome and Edge that adds, changes and removes HTTP request and response headers, redirects and blocks requests, and imports ModHeader profiles.

This repository holds the source of the extension as published on the [Chrome Web Store](https://chromewebstore.google.com/detail/mpmbdokflhbfmcpggmheiakdhnbbockd). It is source available under the PolyForm Shield licence, not open source (see [Licence](#licence)).

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequestWithHostAccess` | Applies your header, redirect and block rules through Chrome's own rule engine. Rules only touch sites you have granted. |
| `storage` | Saves profiles and settings in this browser. |
| `activeTab` | Lets the popup show which rules applied on the tab you opened it on, at that moment only. |
| `alarms` | Turns profiles off when their auto-pause time comes, and checks trial and licence expiry. |

There is no install-time host access: the manifest has no `host_permissions`, and the extension cannot see or change any site after install. `https://*/*` and `http://*/*` are listed as `optional_host_permissions` only so that each profile can ask for its own sites (plus the page sending the requests, which Chrome also requires) when you turn it on. You can review and revoke every grant on the Permissions page. The store build is checked for this in CI: `npm run check:manifest` fails on `host_permissions`, `tabs`, `debugger`, `webRequest` or `declarativeNetRequestFeedback`.

## Network

No analytics, no telemetry, no remote code. Everything that runs ships in the package, unminified.

The extension makes one network request, and only for a Pro yearly licence:

- `POST https://headerbench.com/api/license/refresh` with the licence key as the body. It is sent when you click Refresh under Settings > Licence, or automatically when you open the editor page and the key expires within 14 days (at most once every 6 hours). Free users and lifetime licences never send it. Code: `extension/src/sw/license.ts` (`requestRefresh`) and `refreshLicense` in `extension/src/sw/background.ts`.

Other traffic you might see:

- With Pro sync turned on (off by default), profiles and variables are written to `chrome.storage.sync`, which Chrome syncs through your Google account. Headerbench runs no sync server.
- `https://headerbench.com` may send the extension a licence key after a purchase (`externally_connectable`, message `activate-license`). That is the only page allowed to message it.
- Links you click (the Pro page, the store review page) open in a normal tab.

Licence keys are Ed25519-signed and verified offline (`packages/core/src/license.ts`).

## Build from source

Requires Node 22.12 or later.

```bash
npm ci
npm run build          # writes extension/dist, load it unpacked from chrome://extensions
```

`npm run build` embeds the development licence public key. Its private half is in `packages/core/test/fixtures/dev-license-key.ts` so the tests can sign keys, which means anyone could mint Pro keys for a build that trusts it. The store build is made with `HB_LICENSE_PUBLIC_KEY` set to the production public key, and `npm run package` and `npm run check:release` refuse to run without a non-dev key (`scripts/release-key.mjs`).

To compare your build with the store package:

```bash
curl -L -o headerbench.crx "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=141.0&acceptformat=crx2,crx3&x=id%3Dmpmbdokflhbfmcpggmheiakdhnbbockd%26uc"
mkdir store && unzip -q headerbench.crx -d store    # warns about the CRX header; that is expected
export HB_LICENSE_PUBLIC_KEY=$(grep -rhoE 'LICENSE_PUBLIC_KEY = "[0-9a-f]{64}"' store/assets | grep -oE '[0-9a-f]{64}')
git checkout v$(node -p 'require("./store/manifest.json").version')
npm ci && npm run build -w extension
diff -r extension/dist store
```

For 1.0.2 the only differences are the ones the store adds: `update_url` in `manifest.json` and the `_metadata/` folder.

## Tests

```bash
npm run lint
npm run typecheck
npm test               # Vitest: core rule compiler, importers, licence checks, service worker, UI
npm run e2e            # Playwright: loads the unpacked extension in headless Chromium against a local echo server
```

The E2E suite needs a Chromium for Playwright (`npx playwright install chromium`, or set `PW_CHROMIUM_PATH`). It uses a test build (`extension/dist-e2e`) with localhost host access; never load that one for daily use.

## Layout

- `packages/core`: platform-free logic: data model, compiler to `declarativeNetRequest` rules, URL tester, ModHeader importers, licence verification.
- `extension`: service worker (`src/sw`), Preact UI for the popup, editor and welcome page (`src/ui`), build tooling and the manifest generator (`tooling`). See `extension/README.md`.
- `e2e`: Playwright specs.
- `scripts`: the store-build guards.

Some code comments point to internal design notes that are not in this repository.

## Licence

[PolyForm Shield 1.0.0](LICENSE). In plain words: you can read the code, build it, run it, and change it for your own use or your company's. You cannot use it to ship a product that competes with Headerbench, including republishing it on an extension store. The licence text is what counts.

## Bugs and security

Open a [GitHub issue](../../issues) or write to support@headerbench.com. Report security problems privately to the same address (see [SECURITY.md](SECURITY.md)).
