#!/usr/bin/env node
// Store build guard. Builds extension/dist without HB_E2E, then fails if the manifest asks for
// anything the store listing does not justify (docs/blueprint/ARCHITECTURE.md), or if the bundle
// would trust the development licence key.
//
//   node scripts/check-manifest.mjs                  release check: HB_LICENSE_PUBLIC_KEY must be set
//                                                    to the production key (npm run check:release)
//   node scripts/check-manifest.mjs --throwaway-key  CI check (npm run check:manifest): builds with a
//                                                    freshly generated key when HB_LICENSE_PUBLIC_KEY
//                                                    is unset, so CI needs no secret; still fails on
//                                                    the dev key
//   node scripts/check-manifest.mjs <manifest.json>  checks one manifest file without building, e.g.
//                                                    to see it reject extension/dist-e2e/manifest.json
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateLicenseKeyPair } from '@headerbench/core';
import { bundleKeyProblems, releaseKeyProblem } from './release-key.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FORBIDDEN_PERMISSIONS = ['tabs', 'debugger', 'webRequest', 'declarativeNetRequestFeedback'];
const ALLOWED_EXTERNAL = ['https://headerbench.com/*'];

const args = process.argv.slice(2);
const throwaway = args.includes('--throwaway-key');
let manifestPath = args.find((a) => !a.startsWith('--'));
const problems = [];
if (!manifestPath) {
  const env = { ...process.env };
  delete env.HB_E2E;
  delete env.HB_API_BASE;
  if (throwaway && !(env.HB_LICENSE_PUBLIC_KEY ?? '').trim()) {
    env.HB_LICENSE_PUBLIC_KEY = generateLicenseKeyPair().publicKeyHex;
  }
  const keyProblem = releaseKeyProblem(env.HB_LICENSE_PUBLIC_KEY);
  if (keyProblem) {
    process.stderr.write(`Store build check failed: ${keyProblem}\n`);
    process.exit(1);
  }
  execFileSync('npm', ['run', 'build', '-w', 'extension'], { cwd: root, env, stdio: 'inherit' });
  const distDir = fileURLToPath(new URL('../extension/dist', import.meta.url));
  manifestPath = `${distDir}/manifest.json`;
  problems.push(...bundleKeyProblems(distDir, env.HB_LICENSE_PUBLIC_KEY));
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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

if (problems.length > 0) {
  process.stderr.write(
    `Store manifest check failed:\n${problems.map((p) => `- ${p}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `Store manifest OK: permissions ${JSON.stringify(manifest.permissions)}, no host_permissions, externally_connectable ${JSON.stringify(matches)}${manifestPath.includes('extension/dist/') ? ', no development licence key' : ''}.\n`,
);
