# @headerbench/e2e

Playwright tests that load the unpacked extension into headless Chromium and check what a local echo
server actually receives. Run from the repo root with `npm run e2e` (builds core and
`extension/dist-e2e` with `HB_E2E=1`, then runs every spec).

| Path | What |
|---|---|
| `echo-server.ts` | 127.0.0.1, ephemeral port. Records every request (method, headers, body, `?tag=`); serves the `/harness` page (`window.hb.fetch/xhr/post/put/iframe/image`), CSP pages, the `/activate` page for external licence activation, and the `/dev` page behind the popup screenshot. |
| `support/extension.ts` | Launches a fresh Chromium profile per test and drives the extension through its message API (`extension/README.md`). |
| `specs/*.spec.ts` | Request and response headers, filters, priority, tab scope (one tab and several), redirects and blocks (incl. `(?i)` regex and `#fragment` page loads), Pro gating (trial, message API, website activation, Settings paste), background licence refresh on the alarm (against the echo server's `/api/license/refresh`), page loads vs fetches from a page without access, mocks, reload and service-worker restart, ModHeader import through the UI, the popup's "Applied on this tab", auto-pause. |

Env: `PW_CHROMIUM_PATH` points at a specific Chromium binary; otherwise Playwright's own Chromium is
used (`npx playwright install chromium`). `CI=1` uses 2 workers and the GitHub reporter.

Not covered headless: clicking Chrome's site-access prompt (the E2E build grants localhost in its
manifest instead), the toolbar popup's `activeTab` grant (the E2E build adds
`declarativeNetRequestFeedback`), and `runtime.onStartup` after a browser restart (on relaunch, Chromium treats a `--load-extension`
extension as newly installed: the welcome page reopens and `onStartup` never fires).
