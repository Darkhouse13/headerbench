#!/usr/bin/env node
// Builds the store flavour and zips extension/dist into <repo>/dist/headerbench-<version>.zip for
// the Chrome Web Store and Edge, plus headerbench-<version>.txt (git commit and clean/dirty flag;
// kept outside the zip so the zip stays byte-reproducible from the same sources).
//
// Refuses to build unless HB_LICENSE_PUBLIC_KEY is the production key in scripts/release-key.mjs
// (docs/DEPLOY.md §1) and the git tree is clean. After building it checks the output like
// scripts/check-manifest.mjs: no host_permissions or forbidden permissions, externally_connectable
// and API base exactly https://headerbench.com, the right licence key and never the dev key.
// HB_E2E and HB_API_BASE are ignored.
//
//   node scripts/package.mjs [--allow-other-key] [--allow-dirty] [--out-dir <dir>]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { distProblems, releaseKeyProblem } from '../../scripts/release-key.mjs';

function fail(message) {
  process.stderr.write(`npm run package: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const KNOWN = new Set(['--allow-other-key', '--allow-dirty', '--out-dir']);
for (const arg of args) {
  if (arg.startsWith('--') && !KNOWN.has(arg)) fail(`unknown option ${arg}.`);
}
const allowOtherKey = args.includes('--allow-other-key');
const allowDirty = args.includes('--allow-dirty');
const outDirArg = args.includes('--out-dir') ? args[args.indexOf('--out-dir') + 1] : undefined;
if (args.includes('--out-dir') && (!outDirArg || outDirArg.startsWith('--'))) {
  fail('--out-dir needs a directory.');
}

const key = (process.env.HB_LICENSE_PUBLIC_KEY ?? '').trim().toLowerCase();
const keyProblem = releaseKeyProblem(key, { allowOtherKey });
if (keyProblem) fail(keyProblem);

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(extensionDir, '..');
const distDir = join(extensionDir, 'dist');
const outDir = outDirArg ? resolve(outDirArg) : join(repoDir, 'dist');

const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const changes = git('status', '--porcelain');
if (changes && !allowDirty) {
  fail(
    `the git tree has uncommitted changes, so the zip would not match commit ${commit.slice(0, 12)}. ` +
      `Commit them, or pass --allow-dirty for a test build.\n${changes}`,
  );
}

const env = { ...process.env, HB_LICENSE_PUBLIC_KEY: key };
delete env.HB_E2E;
delete env.HB_API_BASE;
execFileSync('npx', ['vite', 'build'], { cwd: extensionDir, env, stdio: 'inherit' });

const problems = distProblems(distDir, key);
if (problems.length > 0) fail(`refusing to package:\n${problems.map((p) => `- ${p}`).join('\n')}`);
const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));

function collect(dir, files = {}) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path, files);
    else files[relative(distDir, path).split(sep).join('/')] = readFileSync(path);
  }
  return files;
}

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `headerbench-${manifest.version}.zip`);
writeFileSync(zipPath, zipSync(collect(distDir), { level: 9, mtime: new Date('2026-01-01') }));
const infoPath = join(outDir, `headerbench-${manifest.version}.txt`);
writeFileSync(
  infoPath,
  [
    `version: ${manifest.version}`,
    `commit: ${commit}`,
    `tree: ${changes ? 'dirty (built with --allow-dirty)' : 'clean'}`,
    `licence key: ${key.slice(0, 8)}…`,
    '',
  ].join('\n'),
);
process.stdout.write(
  `Wrote ${relative(process.cwd(), zipPath)} and ${relative(process.cwd(), infoPath)}\n`,
);
