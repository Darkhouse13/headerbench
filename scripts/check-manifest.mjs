#!/usr/bin/env node
// Store build guard. Builds extension/dist without HB_E2E or HB_API_BASE, then fails if the
// manifest asks for anything the store listing does not justify (docs/blueprint/ARCHITECTURE.md),
// if the bundle talks to anything but https://headerbench.com, or if it would trust the
// development licence key. The checks live in scripts/release-key.mjs, shared with
// `npm run package`.
//
//   node scripts/check-manifest.mjs                  release check (npm run check:release):
//                                                    HB_LICENSE_PUBLIC_KEY must be the production key
//                                                    (add --allow-other-key for another non-dev key)
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
import { distProblems, manifestProblems, releaseKeyProblem } from './release-key.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const throwaway = args.includes('--throwaway-key');
const allowOtherKey = throwaway || args.includes('--allow-other-key');
let manifestPath = args.find((a) => !a.startsWith('--'));
let problems;
if (!manifestPath) {
  const env = { ...process.env };
  delete env.HB_E2E;
  delete env.HB_API_BASE;
  if (throwaway && !(env.HB_LICENSE_PUBLIC_KEY ?? '').trim()) {
    env.HB_LICENSE_PUBLIC_KEY = generateLicenseKeyPair().publicKeyHex;
  }
  const keyProblem = releaseKeyProblem(env.HB_LICENSE_PUBLIC_KEY, { allowOtherKey });
  if (keyProblem) {
    process.stderr.write(`Store build check failed: ${keyProblem}\n`);
    process.exit(1);
  }
  execFileSync('npm', ['run', 'build', '-w', 'extension'], { cwd: root, env, stdio: 'inherit' });
  const distDir = fileURLToPath(new URL('../extension/dist', import.meta.url));
  manifestPath = `${distDir}/manifest.json`;
  problems = distProblems(distDir, env.HB_LICENSE_PUBLIC_KEY);
} else {
  problems = manifestProblems(JSON.parse(readFileSync(manifestPath, 'utf8')));
}

if (problems.length > 0) {
  process.stderr.write(
    `Store manifest check failed:\n${problems.map((p) => `- ${p}`).join('\n')}\n`,
  );
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
process.stdout.write(
  `Store manifest OK: permissions ${JSON.stringify(manifest.permissions)}, no host_permissions, externally_connectable ${JSON.stringify(manifest.externally_connectable?.matches)}${manifestPath.includes('extension/dist/') ? ', API base https://headerbench.com, no development licence key' : ''}.\n`,
);
