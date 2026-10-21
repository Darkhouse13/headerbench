import { render } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import type { RequestType, Reply } from '../src/messages';
import { StoreContext } from '../src/ui/context';
import type { ActiveTab, Platform } from '../src/ui/platform';
import { STATE_KEYS } from '../src/ui/platform';
import { Store } from '../src/ui/store';
import { setup } from './helpers';

/** A Platform backed by a real background running on the fake chrome. */
export function uiSetup(options: { tab?: ActiveTab | null } = {}) {
  const t = setup();
  const opened: string[] = [];
  const platform: Platform = {
    send: (req) => t.bg.dispatch(req) as Promise<Reply<RequestType>> as never,
    onStateChange(listener) {
      const handler = (changes: Record<string, unknown>, area: string): void => {
        if (area === 'local' && STATE_KEYS.some((k) => k in changes)) listener();
      };
      t.api.storage.onChanged.addListener(handler);
      return () => t.api.storage.onChanged.removeListener(handler);
    },
    permissions: {
      contains: (origins) => t.api.permissions.contains({ origins }),
      request: (origins) => t.api.permissions.request({ origins }),
      remove: (origins) => t.api.permissions.remove({ origins }),
      granted: async () => (await t.api.permissions.getAll()).origins,
      onChange(listener) {
        t.api.permissions.onAdded.addListener(listener);
        t.api.permissions.onRemoved.addListener(listener);
        return () => {
          t.api.permissions.onAdded.removeListener(listener);
          t.api.permissions.onRemoved.removeListener(listener);
        };
      },
    },
    activeTab: async () => options.tab ?? null,
    reloadTab: async () => undefined,
    openPage: async (path) => void opened.push(path),
    openUrl: async (url) => void opened.push(url),
    regexProblem: async () => null,
    copyText: async () => undefined,
    download: () => undefined,
    closePopup: () => undefined,
    extensionId: 'testextensionid',
    userAgent: 'Mozilla/5.0 Chrome/141.0.0.0',
    manifestPermissions: ['declarativeNetRequestWithHostAccess', 'storage', 'activeTab', 'alarms'],
    now: () => t.clock.now,
  };
  const store = new Store(platform, 0);
  const mount = async (ui: ComponentChildren) => {
    await store.init();
    return render(<StoreContext.Provider value={store}>{ui}</StoreContext.Provider>);
  };
  return { ...t, platform, store, opened, mount };
}
