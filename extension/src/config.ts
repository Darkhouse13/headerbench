/**
 * Build-time configuration. Values are injected by Vite `define` from the env vars documented in
 * extension/README.md (HB_E2E, HB_LICENSE_PUBLIC_KEY, HB_API_BASE). Nothing here is secret.
 */
import revoked from '../revoked.json';

declare const __HB_E2E__: boolean;
declare const __HB_LICENSE_PUBLIC_KEY__: string;
declare const __HB_API_BASE__: string;
declare const __HB_VERSION__: string;

/** True only in the E2E flavour, which also grants localhost host permissions in the manifest. */
export const E2E_BUILD: boolean = __HB_E2E__;
/** Hex ed25519 public key that licence keys must be signed with. */
export const LICENSE_PUBLIC_KEY: string = __HB_LICENSE_PUBLIC_KEY__;
/** Origin of the website and licence API, without a trailing slash. */
export const API_BASE: string = __HB_API_BASE__;
export const VERSION: string = __HB_VERSION__;

/** Pages allowed to send `activate-license` (mirrors manifest `externally_connectable`). */
export const EXTERNAL_ORIGINS: readonly string[] = [
  new URL(API_BASE).origin,
  ...(E2E_BUILD ? ['http://localhost', 'http://127.0.0.1'] : []),
];

export const PRO_URL = `${API_BASE}/pro`;
export const SUPPORT_EMAIL = 'support@headerbench.com';

/**
 * Licence ids (`lid`) that no longer turn on Pro: refunded or charged-back lifetime purchases,
 * which cannot expire on their own. Edit extension/revoked.json before a release (docs/DEPLOY.md).
 */
export const REVOKED_LICENSES: readonly string[] = (revoked as unknown[]).filter(
  (lid): lid is string => typeof lid === 'string',
);
