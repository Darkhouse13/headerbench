/** Service worker entry: wires the background logic to the real `chrome` API. */
import {
  API_BASE,
  E2E_BUILD,
  EXTERNAL_ORIGINS,
  LICENSE_PUBLIC_KEY,
  REVOKED_LICENSES,
  VERSION,
} from '../config';
import { createBackground } from './background';

createBackground({
  chrome,
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
  userAgent: navigator.userAgent,
  config: {
    licensePublicKey: LICENSE_PUBLIC_KEY,
    revokedLicenses: REVOKED_LICENSES,
    apiBase: API_BASE,
    version: VERSION,
    externalOrigins: EXTERNAL_ORIGINS,
    e2e: E2E_BUILD,
  },
}).register();
