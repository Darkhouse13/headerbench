#!/usr/bin/env node
// Builds the store flavour and zips extension/dist into <repo>/dist/headerbench-<version>.zip for
// the Chrome Web Store and Edge. Refuses to build without a production licence key
// (HB_LICENSE_PUBLIC_KEY, docs/DEPLOY.md §1) and refuses E2E builds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { bundleKeyProblems, releaseKeyProblem } from '../../scripts/release-key.mjs';

function fail(message) {
  process.stderr.write(`npm run package: ${message}\n`);
  process.exit(1);
}

const keyProblem = releaseKeyProblem(process.env.HB_LICENSE_PUBLIC_KEY);
if (keyProblem) fail(keyProblem);

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(extensionDir, 'dist');
const outDir = join(extensionDir, '..', 'dist');

const env = { ...process.env };
delete env.HB_E2E;
execFileSync('npx', ['vite', 'build'], { cwd: extensionDir, env, stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
if (manifest.host_permissions) {
  fail('refusing to package an E2E build: manifest.json has host_permissions.');
}
const bundleProblems = bundleKeyProblems(distDir, process.env.HB_LICENSE_PUBLIC_KEY);
if (bundleProblems.length > 0) fail(`refusing to package: ${bundleProblems.join('; ')}.`);

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
process.stdout.write(`Wrote ${relative(process.cwd(), zipPath)}\n`);
