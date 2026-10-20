/** Generates manifest.json. The store flavour has no `host_permissions`; see ARCHITECTURE.md "Extension". */

export const ICON_SIZES = [16, 32, 48, 128] as const;

export interface ManifestOptions {
  version: string;
  e2e: boolean;
  apiBase: string;
}

export interface Manifest {
  manifest_version: 3;
  name: string;
  short_name: string;
  description: string;
  version: string;
  minimum_chrome_version: string;
  permissions: string[];
  optional_host_permissions: string[];
  host_permissions?: string[];
  background: { service_worker: string; type: 'module' };
  action: { default_popup: string; default_title: string; default_icon: Record<string, string> };
  options_page: string;
  commands: Record<string, { suggested_key?: { default: string }; description: string }>;
  externally_connectable: { matches: string[] };
  icons: Record<string, string>;
}

/** Local origins the E2E flavour may touch without a permission prompt (headless cannot click one). */
export const E2E_HOSTS = ['http://127.0.0.1/*', 'http://localhost/*'];

const iconPath = (size: number): string => `icons/icon-${size}.png`;

export function buildManifest(options: ManifestOptions): Manifest {
  const icons = Object.fromEntries(ICON_SIZES.map((s) => [String(s), iconPath(s)]));
  const manifest: Manifest = {
    manifest_version: 3,
    name: 'Headerbench - Modify HTTP Headers & Requests',
    short_name: 'Headerbench',
    description:
      'Add, modify and remove HTTP request and response headers. Redirects, CORS and mocks. No tracking. Imports ModHeader profiles.',
    version: options.version,
    minimum_chrome_version: '128',
    permissions: ['declarativeNetRequestWithHostAccess', 'storage', 'activeTab', 'alarms'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    background: { service_worker: 'sw.js', type: 'module' },
    action: {
      default_popup: 'popup.html',
      default_title: 'Headerbench',
      default_icon: { '16': iconPath(16), '32': iconPath(32) },
    },
    options_page: 'app.html',
    commands: {
      'toggle-pause': {
        suggested_key: { default: 'Alt+Shift+H' },
        description: 'Pause or resume all profiles',
      },
    },
    externally_connectable: { matches: [`${options.apiBase}/*`] },
    icons,
  };
  if (options.e2e) {
    manifest.host_permissions = [...E2E_HOSTS];
    // Lets getMatchedRules work without the activeTab grant a headless run cannot give.
    manifest.permissions.push('declarativeNetRequestFeedback');
    manifest.externally_connectable.matches.push(...E2E_HOSTS);
  }
  return manifest;
}
