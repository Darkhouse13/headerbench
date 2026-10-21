/** Display text derived from real state. */
import type {
  Effect,
  EnvTag,
  FilterKind,
  Method,
  Profile,
  ProStatus,
  ResourceType,
} from '@headerbench/core';
import { ALL_ORIGINS } from '@headerbench/core';

/** A profile's name for display and labels; never empty. */
export function profileName(profile: Profile): string {
  return profile.name.trim() || 'Untitled profile';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const ENV_LABELS: Record<EnvTag, string> = {
  none: 'None',
  local: 'Local',
  dev: 'Dev',
  staging: 'Staging',
  prod: 'Prod',
};

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  main_frame: 'Page (document)',
  sub_frame: 'Iframe',
  xmlhttprequest: 'Fetch / XHR',
  script: 'Script',
  stylesheet: 'Stylesheet',
  image: 'Image',
  font: 'Font',
  media: 'Media',
  websocket: 'WebSocket',
  ping: 'Ping / beacon',
  csp_report: 'CSP report',
  object: 'Plugin object',
  webtransport: 'WebTransport',
  webbundle: 'Web bundle',
  other: 'Other',
};

export const METHOD_LABELS: Record<Method, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
  connect: 'CONNECT',
  other: 'Other',
};

export const FILTER_KIND_LABELS: Record<FilterKind, string> = {
  domain: 'Domain',
  urlFilter: 'URL pattern',
  regex: 'Regex',
};

/** Short description of what a rule does, e.g. "Set X-Api-Key". */
export function describeEffect(effect: Effect): { action: string; detail: string | null } {
  switch (effect.type) {
    case 'header': {
      const where = effect.direction === 'response' ? 'response header ' : '';
      const verb =
        effect.operation === 'set' ? 'Set' : effect.operation === 'append' ? 'Append to' : 'Remove';
      return {
        action: `${verb} ${where}${effect.header}`,
        detail: effect.operation === 'remove' ? null : (effect.value ?? null),
      };
    }
    case 'redirect':
      return { action: 'Redirect', detail: effect.to };
    case 'block':
      return { action: 'Block the request', detail: null };
    case 'mock':
      return {
        action: 'Mock the response',
        detail: `${formatBytes(effect.bytes)} of ${effect.contentType || 'data'}, status 200`,
      };
    case 'exclude':
      return { action: 'Excluded by a filter', detail: null };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

/** "api.example.com", "api.example.com and 2 more", or "All sites". */
export function scopeSummary(profile: Profile): string {
  const includes = profile.filters.filter((f) => f.enabled && !f.exclude && f.value.trim());
  const [first] = includes;
  if (!first) return 'All sites';
  const label = first.value.trim();
  return includes.length === 1 ? label : `${label} and ${includes.length - 1} more`;
}

export function ruleCount(profile: Profile): number {
  return (
    profile.requestHeaders.length +
    profile.responseHeaders.length +
    profile.redirects.length +
    profile.blocks.length +
    profile.mocks.length
  );
}

/** "3 headers, 1 redirect" or "No rules yet". */
export function rulesSummary(profile: Profile): string {
  const parts: string[] = [];
  const headers = profile.requestHeaders.length + profile.responseHeaders.length;
  if (headers > 0) parts.push(plural(headers, 'header'));
  if (profile.redirects.length > 0) parts.push(plural(profile.redirects.length, 'redirect'));
  if (profile.blocks.length > 0) parts.push(plural(profile.blocks.length, 'block'));
  if (profile.mocks.length > 0) parts.push(plural(profile.mocks.length, 'mock'));
  return parts.length > 0 ? parts.join(', ') : 'No rules yet';
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString();

/** "14:30" today, "Tue 09:00" this week, otherwise "Oct 21". */
export function formatTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, new Date(now))) return time;
  if (Math.abs(ms - now) < 6 * 24 * 3600 * 1000) {
    return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatAgo(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function daysLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / (24 * 3600 * 1000)));
}

/** One line describing the Pro state, for the popup footer and the Pro page. */
export function proSummary(pro: ProStatus, now: number): string {
  if (pro.source === 'license') {
    const plan = pro.plan === 'pro_lifetime' ? 'lifetime' : 'yearly';
    return pro.licenseExpiresAt === null
      ? `Pro (${plan})`
      : `Pro (${plan}), active until ${formatDate(pro.licenseExpiresAt)}`;
  }
  if (pro.source === 'trial' && pro.trialEndsAt !== null) {
    const days = daysLeft(pro.trialEndsAt, now);
    return `Pro trial: ${plural(days, 'day')} left`;
  }
  if (pro.plan !== null) return 'Your Pro licence has expired';
  if (pro.trialEndsAt !== null) return 'Free plan. Your Pro trial has ended';
  return 'Free plan';
}

/** Human label for host-permission patterns: "api.example.com", "all sites". */
export function originsLabel(origins: readonly string[]): string {
  if (origins.some((o) => ALL_ORIGINS.includes(o))) return 'all sites';
  const hosts = [
    ...new Set(
      origins.map((o) => {
        const host = /^[^:]+:\/\/([^/]+)\//.exec(o)?.[1] ?? o;
        return host.replace(/^\*\./, '');
      }),
    ),
  ];
  if (hosts.length <= 2) return hosts.join(' and ');
  return `${hosts.slice(0, 2).join(', ')} and ${hosts.length - 2} more`;
}

/** Label for one granted origin pattern, e.g. "*.example.com (http and https)". */
export function originLabel(origin: string): string {
  if (origin === 'https://*/*') return 'All https:// sites';
  if (origin === 'http://*/*') return 'All http:// sites';
  if (origin === '<all_urls>') return 'All sites';
  const match = /^([^:]+):\/\/([^/]+)\//.exec(origin);
  if (!match) return origin;
  const [, scheme, host] = match as unknown as [string, string, string];
  const where = host.startsWith('*.') ? `Subdomains of ${host.slice(2)}` : host;
  return scheme === '*' ? where : `${where} (${scheme} only)`;
}

export interface SiteGrant {
  label: string;
  /** The granted patterns this row stands for (Revoke removes all of them). */
  origins: string[];
}

/**
 * Granted origins as people think of them: a domain filter asks for `host` and `*.host` over http
 * and https together, so those patterns are one site ("api.example.com and subdomains"). Sorted
 * by host.
 */
export function groupGrants(origins: readonly string[]): SiteGrant[] {
  interface Site {
    exact: Set<string>;
    sub: Set<string>;
    exactOrigins: string[];
    subOrigins: string[];
  }
  const sites = new Map<string, Site>();
  const grants: (SiteGrant & { host: string })[] = [];
  for (const origin of new Set(origins)) {
    const match = /^(\*|https?):\/\/(\*\.)?([^/*]+)\/\*$/.exec(origin);
    if (!match) {
      const host = /^[^:]+:\/\/(?:\*\.)?([^/]+)\//.exec(origin)?.[1] ?? origin;
      grants.push({ host, label: originLabel(origin), origins: [origin] });
      continue;
    }
    const [, scheme, wild, host] = match as unknown as [string, string, string | undefined, string];
    const site = sites.get(host) ?? {
      exact: new Set(),
      sub: new Set(),
      exactOrigins: [],
      subOrigins: [],
    };
    sites.set(host, site);
    const schemes = scheme === '*' ? ['http', 'https'] : [scheme];
    schemes.forEach((sc) => (wild ? site.sub : site.exact).add(sc));
    (wild ? site.subOrigins : site.exactOrigins).push(origin);
  }
  const only = (schemes: Set<string>): string =>
    schemes.size === 2 ? '' : ` (${[...schemes][0] as string} only)`;
  for (const [host, site] of sites) {
    const same =
      site.exact.size === site.sub.size && [...site.exact].every((sc) => site.sub.has(sc));
    if (site.exact.size > 0 && same) {
      grants.push({
        host,
        label: `${host} and subdomains${only(site.exact)}`,
        origins: [...site.exactOrigins, ...site.subOrigins],
      });
      continue;
    }
    if (site.exact.size > 0)
      grants.push({ host, label: `${host}${only(site.exact)}`, origins: site.exactOrigins });
    if (site.sub.size > 0)
      grants.push({
        host,
        label: `Subdomains of ${host}${only(site.sub)}`,
        origins: site.subOrigins,
      });
  }
  return grants
    .sort((a, b) => a.host.localeCompare(b.host))
    .map(({ label, origins: list }) => ({ label, origins: list }));
}
