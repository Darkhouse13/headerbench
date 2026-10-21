/**
 * In-memory fake of the chrome.* APIs Headerbench uses. Behaviour mirrors Chrome where tests
 * depend on it: storage change events, storage quota errors, atomic rule replacement, rule
 * rejection, permissions, alarms. Two fakes can share one sync area to model two devices.
 */
type Listener<A extends unknown[]> = (...args: A) => unknown;

class FakeEvent<A extends unknown[]> {
  readonly listeners = new Set<Listener<A>>();
  addListener(fn: Listener<A>): void {
    this.listeners.add(fn);
  }
  removeListener(fn: Listener<A>): void {
    this.listeners.delete(fn);
  }
  hasListener(fn: Listener<A>): boolean {
    return this.listeners.has(fn);
  }
  emit(...args: A): void {
    for (const fn of this.listeners) fn(...args);
  }
}

type Items = Record<string, unknown>;
type Change = { oldValue?: unknown; newValue?: unknown };

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export class FakeArea {
  data: Items = {};
  /** Number of `set` calls, to check write throttling. */
  writes = 0;
  /** When set, a `set` that would make the area hold more bytes fails like Chrome's quota. */
  quotaBytes: number | null = null;
  private readonly listeners: FakeEvent<[Record<string, Change>, string]>[] = [];
  constructor(private readonly name: string) {}
  /** Change events go to every fake sharing this area (each device sees every write). */
  subscribe(onChanged: FakeEvent<[Record<string, Change>, string]>): this {
    this.listeners.push(onChanged);
    return this;
  }
  private emit(changes: Record<string, Change>): void {
    for (const event of this.listeners) event.emit(changes, this.name);
  }
  bytes(data: Items = this.data): number {
    return Object.entries(data).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
  }
  async get(keys?: string | string[] | null): Promise<Items> {
    if (keys === null || keys === undefined) return clone(this.data);
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Items = {};
    for (const k of list) if (k in this.data) out[k] = clone(this.data[k]);
    return out;
  }
  async set(items: Items): Promise<void> {
    if (this.quotaBytes !== null && this.bytes({ ...this.data, ...items }) > this.quotaBytes) {
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    this.writes++;
    const changes: Record<string, Change> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.data[k], newValue: clone(v) };
      this.data[k] = clone(v);
    }
    this.emit(changes);
  }
  async remove(keys: string | string[]): Promise<void> {
    const removed = new Set(Array.isArray(keys) ? keys : [keys]);
    const changes: Record<string, Change> = {};
    for (const k of removed) changes[k] = { oldValue: this.data[k] };
    this.data = Object.fromEntries(Object.entries(this.data).filter(([k]) => !removed.has(k)));
    this.emit(changes);
  }
}

export interface DnrRuleLike {
  id: number;
  priority: number;
  action: {
    type: string;
    requestHeaders?: { header: string }[];
    responseHeaders?: { header: string }[];
  };
  condition: { regexFilter?: string; tabIds?: number[] };
}

export interface AlarmInfo {
  when?: number;
  delayInMinutes?: number;
  periodInMinutes?: number;
}

/** `sync`: share another fake's sync area, as two devices signed in to one Chrome profile. */
export function createChromeFake(options: { sync?: FakeArea } = {}) {
  const storageChanged = new FakeEvent<[Record<string, Change>, string]>();
  const granted = new Set<string>();
  const permAdded = new FakeEvent<[unknown]>();
  const permRemoved = new FakeEvent<[unknown]>();
  const fake = {
    dynamicRules: [] as DnrRuleLike[],
    sessionRules: [] as DnrRuleLike[],
    /** Regexes Chrome refuses, as RE2 would. */
    rejectRegex: new Set<string>(),
    /** Header names (lower case) Chrome refuses in a modifyHeaders rule. */
    rejectHeader: new Set<string>(),
    /** When set, every update of that list fails with this message (no rule id in it). */
    failList: { dynamicRules: null as string | null, sessionRules: null as string | null },
    /** Number of update calls per list. */
    updates: { dynamicRules: 0, sessionRules: 0 },
    matched: [] as {
      rule: { ruleId: number; rulesetId: string };
      tabId: number;
      timeStamp: number;
    }[],
    matchedError: null as string | null,
    badge: { text: '', color: '', title: '' },
    alarms: new Map<string, AlarmInfo>(),
    createdTabs: [] as string[],
    granted,
    /** Answer for the next permissions.request. */
    grantOnRequest: true,
    requests: [] as string[][],
  };

  const replace =
    (list: 'dynamicRules' | 'sessionRules') =>
    async (options: { removeRuleIds?: number[]; addRules?: DnrRuleLike[] }): Promise<void> => {
      fake.updates[list]++;
      const failure = fake.failList[list];
      if (failure) throw new Error(failure);
      for (const rule of options.addRules ?? []) {
        if (rule.condition.regexFilter && fake.rejectRegex.has(rule.condition.regexFilter)) {
          throw new Error(`Rule with id ${rule.id} specified a non-supported regex.`);
        }
        const headers = [
          ...(rule.action.requestHeaders ?? []),
          ...(rule.action.responseHeaders ?? []),
        ];
        if (headers.some((h) => fake.rejectHeader.has(h.header.toLowerCase()))) {
          throw new Error(`Rule with id ${rule.id} must specify a valid header to be modified.`);
        }
      }
      const remove = new Set(options.removeRuleIds ?? []);
      fake[list] = [
        ...fake[list].filter((r) => !remove.has(r.id)),
        ...clone(options.addRules ?? []),
      ];
    };

  // Chrome's rule: a pattern is covered only when one single pattern contains it, so
  // `https://*/*` plus `http://*/*` do not cover `*://host/*`.
  const parse = (pattern: string): { schemes: string[]; host: string } | null => {
    const m = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
    if (!m) return null;
    return { schemes: m[1] === '*' ? ['http', 'https'] : [m[1] as string], host: m[2] as string };
  };
  const contains = (outer: string, inner: string): boolean => {
    const o = parse(outer);
    const i = parse(inner);
    if (!o || !i || !i.schemes.every((s) => o.schemes.includes(s))) return false;
    if (o.host === '*' || o.host === i.host) return true;
    if (!o.host.startsWith('*.')) return false;
    const base = o.host.slice(2);
    const host = i.host.startsWith('*.') ? i.host.slice(2) : i.host;
    return host === base || host.endsWith(`.${base}`);
  };
  const OPTIONAL_HOSTS = ['https://*/*', 'http://*/*'];
  const covers = (pattern: string): boolean => [...granted].some((g) => contains(g, pattern));

  const chromeApi = {
    runtime: {
      id: 'testextensionid',
      onInstalled: new FakeEvent<[{ reason: string }]>(),
      onStartup: new FakeEvent<[]>(),
      onMessage: new FakeEvent<[unknown, { id?: string }, (r: unknown) => void]>(),
      onMessageExternal: new FakeEvent<
        [unknown, { origin?: string; url?: string }, (r: unknown) => void]
      >(),
      getURL: (path: string) => `chrome-extension://testextensionid/${path}`,
      getManifest: () => ({
        permissions: ['declarativeNetRequestWithHostAccess', 'storage', 'activeTab', 'alarms'],
      }),
    },
    storage: {
      local: new FakeArea('local').subscribe(storageChanged),
      sync: (options.sync ?? new FakeArea('sync')).subscribe(storageChanged),
      onChanged: storageChanged,
    },
    declarativeNetRequest: {
      getDynamicRules: async () => clone(fake.dynamicRules),
      getSessionRules: async () => clone(fake.sessionRules),
      updateDynamicRules: replace('dynamicRules'),
      updateSessionRules: replace('sessionRules'),
      getMatchedRules: async (filter: { tabId: number }) => {
        if (fake.matchedError) throw new Error(fake.matchedError);
        return { rulesMatchedInfo: fake.matched.filter((m) => m.tabId === filter.tabId) };
      },
      isRegexSupported: async ({ regex }: { regex: string }) =>
        fake.rejectRegex.has(regex)
          ? { isSupported: false, reason: 'syntaxError' }
          : { isSupported: true },
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => void (fake.badge.text = text),
      setBadgeBackgroundColor: async ({ color }: { color: string }) =>
        void (fake.badge.color = color),
      setBadgeTextColor: async () => undefined,
      setTitle: async ({ title }: { title: string }) => void (fake.badge.title = title),
    },
    alarms: {
      create: async (name: string, info: AlarmInfo) => void fake.alarms.set(name, info),
      get: async (name: string) => {
        const info = fake.alarms.get(name);
        if (!info) return undefined;
        return {
          name,
          scheduledTime: info.when ?? 0,
          ...(info.periodInMinutes !== undefined ? { periodInMinutes: info.periodInMinutes } : {}),
        };
      },
      clear: async (name: string) => fake.alarms.delete(name),
      onAlarm: new FakeEvent<[{ name: string }]>(),
    },
    commands: { onCommand: new FakeEvent<[string]>() },
    tabs: {
      create: async ({ url }: { url: string }) => void fake.createdTabs.push(url),
      onRemoved: new FakeEvent<[number]>(),
    },
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => origins.every(covers),
      request: async ({ origins }: { origins: string[] }) => {
        fake.requests.push(origins);
        if (!origins.every((o) => OPTIONAL_HOSTS.some((m) => contains(m, o))))
          throw new Error('Only permissions specified in the manifest may be requested.');
        if (!fake.grantOnRequest) return false;
        origins.forEach((o) => granted.add(o));
        permAdded.emit({ origins });
        return true;
      },
      remove: async ({ origins }: { origins: string[] }) => {
        origins.forEach((o) => granted.delete(o));
        permRemoved.emit({ origins });
        return true;
      },
      getAll: async () => ({ origins: [...granted] }),
      onAdded: permAdded,
      onRemoved: permRemoved,
    },
  };
  return { chrome: chromeApi as unknown as typeof chrome, fake, api: chromeApi };
}

export type ChromeFake = ReturnType<typeof createChromeFake>;
