/**
 * Local echo server for the E2E suite. Binds 127.0.0.1 on an ephemeral port and records every
 * request it receives, so specs assert on what actually reached the server rather than on what
 * the page believes it sent.
 *
 * Routes (any method unless noted):
 * - `/echo/*`            JSON `{ method, path, headers, body }` of the request
 * - `/csp`               JSON, served with a strict Content-Security-Policy and `X-Server: echo`
 * - `/csp-page`          HTML whose inline script only runs if the CSP header was removed
 * - `/harness`           HTML exposing `window.hb` (fetch, XHR, POST, PUT, iframe, image helpers)
 * - `/frame`             small HTML document (for iframe requests)
 * - `/pixel.png`         1x1 PNG (for image requests)
 * - `/activate`          HTML that sends `activate-license` to the extension id in `?ext=`
 * - `/dev`               a plain developer dashboard, used as the page behind the popup screenshot
 *
 * Every request may carry `?tag=<id>`; `waitFor(tag)` resolves with the recorded request.
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  tag: string | null;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface EchoServer {
  /** e.g. `http://127.0.0.1:41234` */
  origin: string;
  port: number;
  /** Same server, addressed as `localhost` (a different host for domain filters). */
  localhostOrigin: string;
  requests: RecordedRequest[];
  /** Requests recorded with this tag, in arrival order. */
  tagged(tag: string): RecordedRequest[];
  /** Resolves with the first request carrying `tag`, or rejects after `timeoutMs`. */
  waitFor(tag: string, timeoutMs?: number): Promise<RecordedRequest>;
  close(): Promise<void>;
}

// 1x1 transparent PNG.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const HARNESS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Echo harness</title></head>
<body>
<p>Headerbench E2E harness</p>
<script>
const q = (path, tag) => path + (path.includes('?') ? '&' : '?') + 'tag=' + encodeURIComponent(tag);
const json = async (res) => ({ status: res.status, url: res.url, text: await res.text(),
  headers: Object.fromEntries(res.headers.entries()) });
window.hb = {
  fetch: (tag, path = '/echo/fetch', init = {}) => fetch(q(path, tag), init).then(json),
  post: (tag, path = '/echo/post') => fetch(q(path, tag), { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag }) }).then(json),
  put: (tag, path = '/echo/put') => fetch(q(path, tag), { method: 'PUT', body: 'put-' + tag }).then(json),
  xhr: (tag, path = '/echo/xhr') => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', q(path, tag));
    x.onload = () => resolve({ status: x.status, text: x.responseText });
    x.onerror = () => reject(new Error('xhr failed'));
    x.send();
  }),
  iframe: (tag) => new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.onload = () => resolve(true);
    f.onerror = () => reject(new Error('iframe failed'));
    f.src = q('/frame', tag);
    document.body.appendChild(f);
  }),
  image: (tag) => new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(true);
    i.onerror = () => reject(new Error('image failed'));
    i.src = q('/pixel.png', tag);
  }),
};
</script>
</body></html>`;

const CSP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>csp-blocked</title></head>
<body><script>document.title = 'csp-removed';</script></body></html>`;

const ACTIVATE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Activate</title></head>
<body><pre id="out">pending</pre>
<script>
const params = new URLSearchParams(location.search);
const out = document.getElementById('out');
window.activate = (key) => new Promise((resolve) => {
  if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
    resolve({ ok: false, reason: 'chrome.runtime is not exposed to this page' });
    return;
  }
  chrome.runtime.sendMessage(params.get('ext'), { type: 'activate-license', key }, (reply) => {
    resolve(reply ?? { ok: false, reason: chrome.runtime.lastError?.message ?? 'no reply' });
  });
}).then((reply) => { out.textContent = JSON.stringify(reply); return reply; });
</script></body></html>`;

/** A deliberately plain internal dashboard: the page a developer has open behind the popup. */
const DEV_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Orders · Northwind admin</title>
<style>
  :root { color-scheme: light; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; }
  body { margin: 0; background: #f6f7f9; }
  header { display: flex; align-items: center; gap: 24px; height: 56px; padding: 0 32px; background: #fff; border-bottom: 1px solid #e3e6ea; }
  header strong { font-size: 15px; }
  header nav { display: flex; gap: 20px; color: #59636e; }
  header nav span:first-child { color: #1f2328; font-weight: 600; }
  main { padding: 28px 32px; max-width: 760px; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  p.sub { margin: 0 0 20px; color: #59636e; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #eef0f2; }
  th { font-weight: 600; color: #59636e; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; background: #fafbfc; }
  td.num { font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: #e8f3ec; color: #1a7f37; }
  .pill.wait { background: #fff4d6; color: #8a5a00; }
</style></head>
<body>
<header><strong>Northwind admin</strong><nav><span>Orders</span><span>Customers</span><span>Payouts</span></nav></header>
<main>
<h1>Orders</h1>
<p class="sub">Staging data · refreshed from api.staging.example.com</p>
<table>
<thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead>
<tbody>
<tr><td>#10482</td><td>Ines Laurent</td><td class="num">€128.40</td><td><span class="pill">Paid</span></td></tr>
<tr><td>#10481</td><td>Kenji Mori</td><td class="num">€54.00</td><td><span class="pill wait">Pending</span></td></tr>
<tr><td>#10480</td><td>Ada Okafor</td><td class="num">€212.15</td><td><span class="pill">Paid</span></td></tr>
<tr><td>#10479</td><td>Lucas Petit</td><td class="num">€19.90</td><td><span class="pill">Paid</span></td></tr>
<tr><td>#10478</td><td>Maya Chen</td><td class="num">€87.30</td><td><span class="pill wait">Pending</span></td></tr>
</tbody></table>
</main>
<script>
  // What the real app does on load: one call to the staging API and one to the local BFF.
  const api = new URLSearchParams(location.search).get('api');
  if (api) fetch(api + '/v2/orders?limit=5').catch(() => undefined);
  fetch('/echo/bff/session?tag=bff').catch(() => undefined);
</script>
</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export async function startEchoServer(): Promise<EchoServer> {
  const requests: RecordedRequest[] = [];
  const waiters = new Map<string, ((r: RecordedRequest) => void)[]>();

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const record: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        tag: url.searchParams.get('tag'),
        headers: req.headers,
        body,
      };
      requests.push(record);
      if (record.tag) {
        for (const resolve of waiters.get(record.tag) ?? []) resolve(record);
        waiters.delete(record.tag);
      }

      const path = url.pathname;
      if (path.startsWith('/echo')) {
        send(
          res,
          200,
          'application/json',
          JSON.stringify({ method: record.method, path, headers: req.headers, body }),
        );
      } else if (path === '/csp') {
        send(res, 200, 'application/json', '{"csp":true}', {
          'Content-Security-Policy': "default-src 'none'",
          'X-Server': 'echo',
        });
      } else if (path === '/csp-page') {
        send(res, 200, 'text/html; charset=utf-8', CSP_PAGE, {
          'Content-Security-Policy': "script-src 'none'",
        });
      } else if (path === '/harness') {
        send(res, 200, 'text/html; charset=utf-8', HARNESS);
      } else if (path === '/frame') {
        send(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>frame</title><p>frame');
      } else if (path === '/pixel.png') {
        send(res, 200, 'image/png', PIXEL);
      } else if (path === '/activate') {
        send(res, 200, 'text/html; charset=utf-8', ACTIVATE_PAGE);
      } else if (path === '/dev') {
        send(res, 200, 'text/html; charset=utf-8', DEV_PAGE);
      } else {
        send(res, 404, 'text/plain', 'not found');
      }
    })().catch((error: unknown) => {
      send(res, 500, 'text/plain', String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    localhostOrigin: `http://localhost:${port}`,
    port,
    requests,
    tagged: (tag) => requests.filter((r) => r.tag === tag),
    waitFor(tag, timeoutMs = 5000) {
      const seen = requests.find((r) => r.tag === tag);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`The echo server never received a request tagged "${tag}"`)),
          timeoutMs,
        );
        const list = waiters.get(tag) ?? [];
        list.push((r) => {
          clearTimeout(timer);
          resolve(r);
        });
        waiters.set(tag, list);
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
