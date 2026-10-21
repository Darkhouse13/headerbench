// Release guards shared by extension/scripts/package.mjs and scripts/check-manifest.mjs: the
// licence key a store build trusts, and what its built manifest and bundle may contain.
// The development key's private half is committed in the test fixtures (anyone could mint Pro
// keys for it), so a store build must never trust it. See docs/DEPLOY.md §1.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_LICENSE_PUBLIC_KEY } from '@headerbench/core';

export { DEV_LICENSE_PUBLIC_KEY };

/**
 * Public half of the production licence keypair (fingerprint 666897a8…). Public by design: it is
 * compiled into every store build. The private half lives only on the server.
 */
export const PRODUCTION_LICENSE_PUBLIC_KEY =
  '666897a80606feafff451ea55f2a5885d3426e4dc69730d0f933ed295f006296';

/** The only API origin and externally_connectable match a store build may have. */
export const PRODUCTION_API_BASE = 'https://headerbench.com';
export const ALLOWED_EXTERNAL = [`${PRODUCTION_API_BASE}/*`];
export const FORBIDDEN_PERMISSIONS = [
  'tabs',
  'debugger',
  'webRequest',
  'declarativeNetRequestFeedback',
];

const HOW_TO =
  'Generate the production keypair once with `node scripts/gen-license-key.mjs` (docs/DEPLOY.md §1), ' +
  'keep LICENSE_PRIVATE_KEY on the server, and build with HB_LICENSE_PUBLIC_KEY=<the public hex>.';

/**
 * Null when `raw` is a usable store-build public key, else what is wrong and how to fix it.
 * `allowOtherKey` accepts a non-dev key other than the production one (CI throwaway keys, a
 * rotated keypair before this file is updated).
 */
export function releaseKeyProblem(raw, { allowOtherKey = false } = {}) {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === '')
    return `HB_LICENSE_PUBLIC_KEY is not set, so this build would trust the development licence key. ${HOW_TO}`;
  if (!/^[0-9a-f]{64}$/.test(key))
    return `HB_LICENSE_PUBLIC_KEY must be 64 hex characters. ${HOW_TO}`;
  if (key === DEV_LICENSE_PUBLIC_KEY) {
    return `HB_LICENSE_PUBLIC_KEY is the development key, whose private half is public in the test fixtures. ${HOW_TO}`;
  }
  if (!allowOtherKey && key !== PRODUCTION_LICENSE_PUBLIC_KEY) {
    return (
      `HB_LICENSE_PUBLIC_KEY (${key.slice(0, 8)}…) is not the production key (${PRODUCTION_LICENSE_PUBLIC_KEY.slice(0, 8)}…) ` +
      'in scripts/release-key.mjs, so licences sold on headerbench.com would not work. Pass --allow-other-key if this is intended.'
    );
  }
  return null;
}

function scripts(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scripts(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

/** Problems with the built bundle in `distDir`: it must embed `key`, never the dev key. */
export function bundleKeyProblems(distDir, key) {
  const code = scripts(distDir).map((path) => readFileSync(path, 'utf8'));
  const problems = [];
  if (code.some((text) => text.includes(DEV_LICENSE_PUBLIC_KEY))) {
    problems.push('the built extension contains the development licence public key');
  }
  if (!code.some((text) => text.includes(key.trim().toLowerCase()))) {
    problems.push('the built extension does not contain HB_LICENSE_PUBLIC_KEY (stale build?)');
  }
  return problems;
}

/** Problems with the API base compiled into the bundle (src/config.ts `API_BASE`). */
export function bundleApiBaseProblems(distDir) {
  const bases = new Set();
  for (const path of scripts(distDir)) {
    for (const m of readFileSync(path, 'utf8').matchAll(/\bAPI_BASE = "([^"]*)"/g)) bases.add(m[1]);
  }
  if (bases.size === 0) return ['the built extension does not define API_BASE (unexpected bundle)'];
  const wrong = [...bases].filter((base) => base !== PRODUCTION_API_BASE);
  return wrong.length > 0
    ? [`the built extension talks to ${wrong.join(', ')} instead of ${PRODUCTION_API_BASE}`]
    : [];
}

/** Problems with a store manifest: permissions, host access, externally_connectable. */
export function manifestProblems(manifest) {
  const problems = [];
  if ('host_permissions' in manifest) {
    problems.push(
      `host_permissions must be absent, found ${JSON.stringify(manifest.host_permissions)}`,
    );
  }
  const permissions = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
  for (const name of FORBIDDEN_PERMISSIONS) {
    if (permissions.includes(name)) problems.push(`permission "${name}" must not be requested`);
  }
  const matches = manifest.externally_connectable?.matches ?? [];
  if (JSON.stringify(matches) !== JSON.stringify(ALLOWED_EXTERNAL)) {
    problems.push(
      `externally_connectable.matches must be exactly ${JSON.stringify(ALLOWED_EXTERNAL)}, found ${JSON.stringify(matches)}`,
    );
  }
  return problems;
}

/** Every check on a built store `distDir` (manifest, licence key, API base). */
export function distProblems(distDir, key) {
  const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
  return [
    ...manifestProblems(manifest),
    ...bundleKeyProblems(distDir, key),
    ...bundleApiBaseProblems(distDir),
  ];
}
