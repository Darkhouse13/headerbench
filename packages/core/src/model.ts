/** Headerbench data model. Normative source: docs/blueprint/ARCHITECTURE.md "Data model". */

export const SCHEMA_VERSION = 1;

export type HeaderOp = 'set' | 'append' | 'remove';
export interface HeaderMod {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
  op: HeaderOp;
  comment: string;
}

/** `urlFilter` uses DNR urlFilter syntax (`||`, `|`, `^`, `*`). */
export type FilterKind = 'domain' | 'urlFilter' | 'regex';
export interface UrlFilter {
  id: string;
  enabled: boolean;
  kind: FilterKind;
  value: string;
  exclude: boolean;
}

export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other';
export type Method =
  'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'connect' | 'other';

export const RESOURCE_TYPES: readonly ResourceType[] = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];
export const METHODS: readonly Method[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'connect',
  'other',
];

/** kind `regex` is a Pro feature. */
export interface RedirectRule {
  id: string;
  enabled: boolean;
  kind: 'url' | 'urlFilter' | 'regex';
  from: string;
  to: string;
  comment: string;
}
export interface BlockRule {
  id: string;
  enabled: boolean;
  kind: 'urlFilter' | 'regex';
  pattern: string;
  comment: string;
}
/** Pro feature. */
export interface MockRule {
  id: string;
  enabled: boolean;
  kind: 'urlFilter' | 'regex';
  pattern: string;
  contentType: string;
  body: string;
  comment: string;
}

export type EnvTag = 'none' | 'local' | 'dev' | 'staging' | 'prod';
export const ENV_TAGS: readonly EnvTag[] = ['none', 'local', 'dev', 'staging', 'prod'];

export interface Profile {
  id: string;
  name: string;
  /** 1–2 characters shown on the toolbar badge. */
  badge: string;
  /** `#rrggbb` */
  color: string;
  env: EnvTag;
  requestHeaders: HeaderMod[];
  responseHeaders: HeaderMod[];
  /** No enabled include filter means all URLs. */
  filters: UrlFilter[];
  /** Empty means ALL types (the compiler lists them explicitly; DNR's default skips main_frame). */
  resourceTypes: ResourceType[];
  /** Empty means all methods. */
  methods: Method[];
  redirects: RedirectRule[];
  blocks: BlockRule[];
  mocks: MockRule[];
  createdAt: number;
  updatedAt: number;
}

/** Pro feature. `name` matches `[A-Za-z_][A-Za-z0-9_]*`. */
export interface Variable {
  id: string;
  name: string;
  value: string;
}

/** `tabId` set means the profile is tab-scoped (compiled to session rules). */
export interface Activation {
  profileId: string;
  tabId: number | null;
  pauseAt: number | null;
}

export type ReviewState = 'pending' | 'shown' | 'dismissed' | 'rated';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  paused: boolean;
  /** ORDER = PRIORITY (index 0 is highest). */
  activations: Activation[];
  variables: Variable[];
  /** Pro. */
  sync: boolean;
  theme: Theme;
  trialStartedAt: number | null;
  licenseKey: string | null;
  review: {
    /** YYYY-MM-DD, at most 3 kept. */
    activeDays: string[];
    state: ReviewState;
  };
}

export interface State {
  schemaVersion: number;
  profiles: Profile[];
  settings: Settings;
}

/** Badge colours offered for new profiles (Material 600 tones; all reach 4.5:1 against white text). */
export const PROFILE_COLORS: readonly string[] = [
  '#1a73e8',
  '#188038',
  '#c5221f',
  '#b06000',
  '#8430ce',
  '#007b83',
  '#5f6368',
];

export function newId(): string {
  return crypto.randomUUID();
}

export function defaultSettings(): Settings {
  return {
    paused: false,
    activations: [],
    variables: [],
    sync: false,
    theme: 'system',
    trialStartedAt: null,
    licenseKey: null,
    review: { activeDays: [], state: 'pending' },
  };
}

export function defaultState(): State {
  return { schemaVersion: SCHEMA_VERSION, profiles: [], settings: defaultSettings() };
}

/** Derives a badge from a profile name: its first letter or digit, upper-cased. */
export function badgeFor(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toUpperCase() : 'H';
}

export interface NewProfileOptions {
  name?: string;
  /** Used to pick the next unused colour and a default "Profile N" name. */
  existing?: readonly Profile[];
  now?: number;
}

export function newProfile(options: NewProfileOptions = {}): Profile {
  const existing = options.existing ?? [];
  const now = options.now ?? Date.now();
  const name = options.name?.trim() || `Profile ${existing.length + 1}`;
  const used = new Set(existing.map((p) => p.color));
  const color =
    PROFILE_COLORS.find((c) => !used.has(c)) ??
    PROFILE_COLORS[existing.length % PROFILE_COLORS.length] ??
    '#1a73e8';
  return {
    id: newId(),
    name,
    badge: badgeFor(name),
    color,
    env: 'none',
    requestHeaders: [],
    responseHeaders: [],
    filters: [],
    resourceTypes: [],
    methods: [],
    redirects: [],
    blocks: [],
    mocks: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function newHeaderMod(partial: Partial<Omit<HeaderMod, 'id'>> = {}): HeaderMod {
  return {
    id: newId(),
    enabled: partial.enabled ?? true,
    name: partial.name ?? '',
    value: partial.value ?? '',
    op: partial.op ?? 'set',
    comment: partial.comment ?? '',
  };
}
