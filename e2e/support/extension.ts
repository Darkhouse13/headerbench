/**
 * Launches Chromium with the unpacked extension and drives it through its own message API
 * (extension/README.md "Message API"), exactly as the UI does.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import type { Profile } from '@headerbench/core';
import type {
  Reply,
  RequestOf,
  RequestType,
  ResponseMap,
  Snapshot,
} from '../../extension/src/messages.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The E2E flavour built by `npm run build:e2e -w extension`. */
export const E2E_EXTENSION_DIR = resolve(here, '../../extension/dist-e2e');

export interface LaunchOptions {
  /** Unpacked extension folder. Defaults to the E2E build. */
  extensionDir?: string;
  /** Extra Chromium switches (e.g. `--host-resolver-rules`). */
  args?: string[];
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  /** `prefers-color-scheme` for every page; the extension UI follows it. Defaults to light. */
  colorScheme?: 'light' | 'dark';
}

export class MessageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export class ExtensionHarness {
  private controlPage: Page | null = null;

  private constructor(
    readonly context: BrowserContext,
    readonly id: string,
    private readonly userDataDir: string,
  ) {}

  static async launch(options: LaunchOptions): Promise<ExtensionHarness> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'hb-e2e-'));
    // Developer mode, as on any machine that loads an unpacked extension. Without it Chrome
    // disables a command-line extension that calls chrome.runtime.reload().
    mkdirSync(join(userDataDir, 'Default'));
    writeFileSync(
      join(userDataDir, 'Default', 'Preferences'),
      JSON.stringify({ extensions: { ui: { developer_mode: true } } }),
    );
    const dir = options.extensionDir ?? E2E_EXTENSION_DIR;
    const context = await openContext(userDataDir, dir, options);
    const harness = new ExtensionHarness(context, unpackedExtensionId(dir), userDataDir);
    await harness.waitUntilReady('The extension did not start');
    return harness;
  }

  /**
   * Polls with `getState` until the service worker answers. Used after launch and reload instead of
   * Playwright's `serviceworker` event, which is missed when the worker starts before it listens.
   */
  private async waitUntilReady(failure: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        this.controlPage = null;
        const page = await this.control();
        const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));
        if ((reply as { ok?: boolean } | undefined)?.ok) return;
        last = reply;
      } catch (error) {
        last = error;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${failure} within ${timeoutMs} ms (last: ${String(last)})`);
  }

  url(path: string): string {
    return `chrome-extension://${this.id}/${path}`;
  }

  /** An extension page used to call the message API (the JSON viewer of manifest.json renders no UI). */
  async control(): Promise<Page> {
    if (this.controlPage && !this.controlPage.isClosed()) return this.controlPage;
    const page = await this.context.newPage();
    await page.goto(this.url('manifest.json'));
    this.controlPage = page;
    return page;
  }

  /** Raw reply, for asserting on errors. */
  async request<T extends RequestType>(req: RequestOf<T>): Promise<Reply<T>> {
    const page = await this.control();
    return page.evaluate((m) => chrome.runtime.sendMessage(m), req) as Promise<Reply<T>>;
  }

  async send<T extends RequestType>(req: RequestOf<T>): Promise<ResponseMap[T]> {
    const reply = await this.request(req);
    if (!reply.ok) throw new MessageError(reply.code, reply.error);
    return reply.data;
  }

  snapshot(): Promise<Snapshot> {
    return this.send({ type: 'getState' });
  }

  /** Replaces the profile list (in this order) and returns the new snapshot. */
  async setProfiles(profiles: Profile[]): Promise<Snapshot> {
    const snap = await this.snapshot();
    return this.send({
      type: 'saveState',
      state: { ...snap.state, profiles },
      rev: snap.rev,
    });
  }

  activate(profileId: string, opts: { tabId?: number | null; pauseAt?: number | null } = {}) {
    return this.send({
      type: 'activate',
      profileId,
      tabId: opts.tabId ?? null,
      pauseAt: opts.pauseAt ?? null,
    });
  }

  /** Saves the profiles and turns each one on, everywhere. */
  async apply(...profiles: Profile[]): Promise<Snapshot> {
    let snap = await this.setProfiles(profiles);
    for (const p of profiles) snap = await this.activate(p.id);
    return snap;
  }

  /** Chrome's tab id for a page (the E2E build has host access to localhost, so URLs are visible). */
  async tabId(page: Page): Promise<number> {
    const control = await this.control();
    const target = page.url();
    const { id, seen } = await control.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return {
        id: tabs.find((t) => t.url === url)?.id ?? null,
        seen: tabs.map((t) => t.url ?? '(url hidden)'),
      };
    }, target);
    if (id === null) throw new Error(`No tab found for ${target}. Tabs: ${seen.join(', ')}`);
    return id;
  }

  /**
   * Reloads the extension (as Chrome does on an update) and waits until the new service worker
   * answers messages again.
   */
  async reload(): Promise<void> {
    const control = await this.control();
    await control.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await this.waitUntilReady('The extension did not come back after reload');
  }

  /**
   * Stops the extension's service worker, as Chrome does after 30 s idle. The next message starts a
   * fresh one.
   */
  async restartServiceWorker(): Promise<void> {
    const control = await this.control();
    const cdp = await this.context.newCDPSession(control);
    const prefix = `chrome-extension://${this.id}/`;
    const workerTarget = async (): Promise<string | null> =>
      (await cdp.send('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'service_worker' && t.url.startsWith(prefix),
      )?.targetId ?? null;
    const before = await workerTarget();
    if (!before) throw new Error('The extension has no running service worker');
    await cdp.send('Target.closeTarget', { targetId: before });
    const deadline = Date.now() + 5000;
    while ((await workerTarget()) !== null) {
      if (Date.now() > deadline) throw new Error('The service worker did not stop');
      await new Promise((r) => setTimeout(r, 100));
    }
    await cdp.detach();
    // Any message starts a new worker, which must answer from stored state.
    await this.snapshot();
  }

  async close(): Promise<void> {
    await this.context.close();
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

/** Chrome's id for an unpacked extension: the SHA-256 of its absolute path, hex digits as a-p. */
export function unpackedExtensionId(dir: string): string {
  const hash = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

function openContext(
  userDataDir: string,
  dir: string,
  options: LaunchOptions,
): Promise<BrowserContext> {
  try {
    readFileSync(join(dir, 'manifest.json'));
  } catch {
    throw new Error(`No built extension in ${dir}. Run "npm run build:e2e -w extension" first.`);
  }
  const executablePath = process.env.PW_CHROMIUM_PATH?.trim() || undefined;
  return chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    viewport: options.viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    colorScheme: options.colorScheme ?? 'light',
    args: [
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
      ...(options.args ?? []),
    ],
  });
}

export function launchExtension(options: LaunchOptions = {}): Promise<ExtensionHarness> {
  return ExtensionHarness.launch(options);
}

/**
 * Copies the E2E build to a temp folder with a different manifest. Used by the screenshots to grant
 * realistic sites at install time (headless Chromium cannot click a permission prompt).
 */
export function extensionVariant(
  edit: (manifest: Record<string, unknown>) => Record<string, unknown>,
): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'hb-ext-'));
  cpSync(E2E_EXTENSION_DIR, dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify(edit(manifest), null, 2));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
