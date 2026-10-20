// Guards against shipping a store build that trusts the development licence key, whose private
// half is committed in the test fixtures (anyone could mint Pro keys for it).
// Used by extension/scripts/package.mjs and scripts/check-manifest.mjs. See docs/DEPLOY.md §1.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_LICENSE_PUBLIC_KEY } from '@headerbench/core';

export { DEV_LICENSE_PUBLIC_KEY };

const HOW_TO =
  'Generate the production keypair once with `node scripts/gen-license-key.mjs` (docs/DEPLOY.md §1), ' +
  'keep LICENSE_PRIVATE_KEY on the server, and build with HB_LICENSE_PUBLIC_KEY=<the public hex>.';

/** Null when `raw` is a usable production public key, else what is wrong and how to fix it. */
export function releaseKeyProblem(raw) {
  const key = (raw ?? '').trim().toLowerCase();
  if (key === '')
    return `HB_LICENSE_PUBLIC_KEY is not set, so this build would trust the development licence key. ${HOW_TO}`;
  if (!/^[0-9a-f]{64}$/.test(key))
    return `HB_LICENSE_PUBLIC_KEY must be 64 hex characters. ${HOW_TO}`;
  if (key === DEV_LICENSE_PUBLIC_KEY) {
    return `HB_LICENSE_PUBLIC_KEY is the development key, whose private half is public in the test fixtures. ${HOW_TO}`;
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

/** Problems with the built bundle in `distDir`: it must embed `key` and never the dev key. */
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
