/** Hash routes for app.html, e.g. `#/profile/<id>/filters`, `#/test?url=…`, `#/settings`. */
import { useEffect, useState } from 'preact/hooks';

export const PROFILE_TABS = [
  'request',
  'response',
  'filters',
  'redirects',
  'mocks',
  'settings',
] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

export type Route =
  | { page: 'profiles'; profileId: string | null; tab: ProfileTab }
  | { page: 'test'; url: string }
  | { page: 'variables' | 'permissions' | 'settings' | 'pro' | 'import' };

export function parseHash(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'profile': {
      const tab = PROFILE_TABS.find((t) => t === parts[2]) ?? 'request';
      return { page: 'profiles', profileId: parts[1] ?? null, tab };
    }
    case 'test':
      return { page: 'test', url: new URLSearchParams(query).get('url') ?? '' };
    case 'variables':
    case 'permissions':
    case 'settings':
    case 'pro':
    case 'import':
      return { page: parts[0] };
    default:
      return { page: 'profiles', profileId: null, tab: 'request' };
  }
}

export function profileHash(profileId: string, tab: ProfileTab = 'request'): string {
  return `#/profile/${encodeURIComponent(profileId)}${tab === 'request' ? '' : `/${tab}`}`;
}

export function navigate(hash: string, replace = false): void {
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  return route;
}
