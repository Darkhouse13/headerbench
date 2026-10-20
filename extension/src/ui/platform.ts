/**
 * Everything the UI needs from the browser, behind one interface so components can be tested
 * with a fake. `chromePlatform()` is the real implementation.
 */
import type { Reply, RequestOf, RequestType } from '../messages';

export interface ActiveTab {
  id: number;
  /** Null when Chrome does not share the URL (no activeTab grant). */
  url: string | null;
}

export interface Platform {
  send<T extends RequestType>(req: RequestOf<T>): Promise<Reply<T>>;
  /** Called when the service worker persisted new state or status. Returns an unsubscribe. */
  onStateChange(listener: () => void): () => void;
  permissions: {
    contains(origins: string[]): Promise<boolean>;
    request(origins: string[]): Promise<boolean>;
    remove(origins: string[]): Promise<boolean>;
    granted(): Promise<string[]>;
    onChange(listener: () => void): () => void;
  };
  activeTab(): Promise<ActiveTab | null>;
  reloadTab(tabId: number): Promise<void>;
  /** Opens an extension page such as `app.html#/settings`. */
  openPage(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** Null when Chrome's RE2 engine accepts the regex, else the reason. */
  regexProblem(regex: string): Promise<string | null>;
  copyText(text: string): Promise<void>;
  download(fileName: string, text: string): void;
  /** Closes the popup after navigating away; a no-op on full pages. */
  closePopup(): void;
  extensionId: string;
  userAgent: string;
  manifestPermissions: string[];
  now(): number;
}

const STATE_KEYS = ['state', 'runtime', 'syncStatus', 'state.corrupt'];

function tabFromQuery(): number | null {
  // The popup can be opened as a regular page (E2E, store screenshots) and pointed at a tab.
  const raw = new URLSearchParams(location.search).get('tab');
  return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
}

export function chromePlatform(isPopup: boolean): Platform {
  return {
    send: (req) => chrome.runtime.sendMessage(req),
    onStateChange(listener) {
      const handler = (changes: Record<string, unknown>, area: string): void => {
        if (area === 'local' && STATE_KEYS.some((k) => k in changes)) listener();
      };
      chrome.storage.onChanged.addListener(handler);
      return () => chrome.storage.onChanged.removeListener(handler);
    },
    permissions: {
      contains: (origins) =>
        origins.length === 0 ? Promise.resolve(true) : chrome.permissions.contains({ origins }),
      request: (origins) => chrome.permissions.request({ origins }),
      remove: (origins) => chrome.permissions.remove({ origins }),
      granted: async () => (await chrome.permissions.getAll()).origins ?? [],
      onChange(listener) {
        chrome.permissions.onAdded.addListener(listener);
        chrome.permissions.onRemoved.addListener(listener);
        return () => {
          chrome.permissions.onAdded.removeListener(listener);
          chrome.permissions.onRemoved.removeListener(listener);
        };
      },
    },
    async activeTab() {
      const forced = tabFromQuery();
      if (forced !== null) {
        const tab = await chrome.tabs.get(forced).catch(() => null);
        return tab ? { id: forced, url: tab.url ?? null } : null;
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || tab.url?.startsWith(chrome.runtime.getURL(''))) return null;
      return { id: tab.id, url: tab.url ?? null };
    },
    reloadTab: (tabId) => chrome.tabs.reload(tabId),
    async openPage(path) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
    },
    async openUrl(url) {
      await chrome.tabs.create({ url });
    },
    async regexProblem(regex) {
      const result = await chrome.declarativeNetRequest.isRegexSupported({ regex });
      if (result.isSupported) return null;
      return result.reason === 'memoryLimitExceeded'
        ? 'Chrome rejects this regex because it needs too much memory. Simplify it.'
        : 'Chrome cannot run this regex (RE2 syntax: no lookarounds or backreferences).';
    },
    copyText: (text) => navigator.clipboard.writeText(text),
    download(fileName, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    closePopup() {
      if (isPopup) window.close();
    },
    extensionId: chrome.runtime.id,
    userAgent: navigator.userAgent,
    manifestPermissions: chrome.runtime.getManifest().permissions ?? [],
    now: () => Date.now(),
  };
}
