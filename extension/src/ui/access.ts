/**
 * Site-access flow (ARCHITECTURE.md "Permissions flow"). Chrome applies header and redirect rules
 * only with host access to both the request URL and the page that sends it (the initiator), so
 * turning a profile on asks for the sites it changes plus, in the popup, the page it is opened on.
 * A profile that is on but lacks access to its sites is "needed" until the user grants it; a
 * refused request makes it "denied" ("Blocked by Chrome"), with a retry.
 * `chrome.permissions.request` must run inside the click.
 */
import type { Profile } from '@headerbench/core';
import { ALL_ORIGINS, originsFor } from '@headerbench/core';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { originsLabel } from './format';
import type { Platform } from './platform';

export type AccessState =
  | { status: 'checking' }
  | { status: 'granted' }
  | { status: 'needed' | 'denied'; origins: string[]; label: string };

export async function checkAccess(platform: Platform, profile: Profile): Promise<AccessState> {
  const origins = originsFor(profile);
  if (origins.length === 0 || (await platform.permissions.contains(origins))) {
    return { status: 'granted' };
  }
  return { status: 'needed', origins, label: originsLabel(origins) };
}

/** Asks Chrome for the origins. Must be called directly from a click handler. */
export async function requestAccess(platform: Platform, origins: string[]): Promise<boolean> {
  try {
    return await platform.permissions.request(origins);
  } catch {
    return false;
  }
}

/** The sites a profile changes plus the page it is used on, as one permission request. */
export function originsToRequest(profile: Profile, page: string | null): string[] {
  const origins = originsFor(profile);
  if (origins.length === 0 || page === null || origins.includes(page)) return origins;
  if (ALL_ORIGINS.every((o) => origins.includes(o))) return origins;
  return [...origins, page];
}

/**
 * Why Headerbench asks for access. `pageLabel` names the page the popup is open on when Chrome
 * also needs access to it (it sends the requests); null when it is granted or unknown.
 */
export function accessExplainer(
  label: string,
  profile: Profile,
  pageLabel: string | null = null,
): string {
  const headers = [...profile.requestHeaders, ...profile.responseHeaders].some((m) => m.enabled);
  const what = headers ? 'change its headers' : 'apply its rules';
  const page =
    pageLabel !== null && label !== 'all sites'
      ? ` and to this page (${pageLabel}), which sends the requests,`
      : '';
  if (label !== 'all sites')
    return `Headerbench needs access to ${label}${page} to ${what}. It reads nothing.`;
  const unscoped = headers && !profile.filters.some((f) => f.enabled && !f.exclude);
  return unscoped
    ? `Headerbench needs access to all sites to ${what}, because this profile has no domain filter. It reads nothing. Add a domain filter to ask for less.`
    : `Headerbench needs access to all sites to ${what}, because a regex or URL pattern in this profile can match any site. It reads nothing.`;
}

/** Hostname for a page URL, for copy such as "Grant access to localhost?". */
export function pageHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/** True when two host-permission patterns can match a common URL. */
export function originsOverlap(a: string, b: string): boolean {
  const parse = (p: string): { scheme: string; host: string } | null => {
    const m = /^(\*|https?):\/\/([^/]+)\//.exec(p);
    return m ? { scheme: m[1] as string, host: m[2] as string } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  if (x.scheme !== '*' && y.scheme !== '*' && x.scheme !== y.scheme) return false;
  const covers = (wild: string, host: string): boolean =>
    wild === '*' ||
    wild === host ||
    (wild.startsWith('*.') && (host === wild.slice(2) || host.endsWith(wild.slice(1))));
  return covers(x.host, y.host) || covers(y.host, x.host);
}

/**
 * Access state for each listed profile (normally the ones that are on), kept fresh when Chrome's
 * permissions change. `page` is the host pattern of the page the popup is open on (null in the
 * editor): `grant` then asks for it in the same request. `grant` and `grantAll` must be called
 * from a click handler.
 */
export function useAccess(
  platform: Platform,
  profiles: readonly Profile[],
  page: string | null = null,
): {
  access: Map<string, AccessState>;
  /** Whether Chrome has access to `page`; null while unknown or without a page. */
  pageGranted: boolean | null;
  /** Whether Headerbench may already change requests on all sites. */
  allSites: boolean;
  grant: (profile: Profile) => Promise<boolean>;
  grantAll: () => Promise<boolean>;
} {
  const [access, setAccess] = useState<Map<string, AccessState>>(new Map());
  const [pageGranted, setPageGranted] = useState<boolean | null>(null);
  const [allSites, setAllSites] = useState(false);
  const [denied, setDenied] = useState<Set<string>>(new Set());
  const key = profiles.map((p) => `${p.id}:${originsFor(p).join(',')}`).join('|');

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const [entries, pageOk, all] = await Promise.all([
        Promise.all(profiles.map(async (p) => [p.id, await checkAccess(platform, p)] as const)),
        page === null ? Promise.resolve(null) : platform.permissions.contains([page]),
        platform.permissions.contains([...ALL_ORIGINS]),
      ]);
      if (cancelled) return;
      setAccess(new Map(entries));
      setPageGranted(pageOk);
      setAllSites(all);
    };
    void run();
    const off = platform.permissions.onChange(() => void run());
    return () => {
      cancelled = true;
      off();
    };
    // `key` captures the profiles' ids and origins; the array identity changes every render.
  }, [platform, key, page]);

  const grant = useCallback(
    async (profile: Profile): Promise<boolean> => {
      const origins = originsToRequest(profile, page);
      if (origins.length === 0) return true;
      const ok = await requestAccess(platform, origins);
      setDenied((prev) => {
        const next = new Set(prev);
        if (ok) next.delete(profile.id);
        else next.add(profile.id);
        return next;
      });
      if (ok) {
        setAccess((prev) => new Map(prev).set(profile.id, { status: 'granted' }));
        if (page !== null) setPageGranted(true);
      }
      return ok;
    },
    [platform, page],
  );

  const grantAll = useCallback(async (): Promise<boolean> => {
    const ok = await requestAccess(platform, [...ALL_ORIGINS]);
    if (ok) setAllSites(true);
    return ok;
  }, [platform]);

  const merged = new Map<string, AccessState>();
  for (const p of profiles) {
    const state = access.get(p.id) ?? { status: 'checking' };
    merged.set(
      p.id,
      state.status === 'needed' && denied.has(p.id) ? { ...state, status: 'denied' } : state,
    );
  }
  return { access: merged, pageGranted, allSites, grant, grantAll };
}
