import { DEV_LICENSE_PUBLIC_KEY } from '@headerbench/core';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildEnv } from '../tooling/env';
import { buildManifest } from '../tooling/manifest';

describe('manifest', () => {
  const store = buildManifest({ version: '1.2.3', e2e: false, apiBase: 'https://headerbench.com' });

  it('asks for no host access and no warning permissions in the store build', () => {
    expect(store.host_permissions).toBeUndefined();
    expect(store.permissions).toEqual([
      'declarativeNetRequestWithHostAccess',
      'storage',
      'activeTab',
      'alarms',
    ]);
    for (const banned of [
      'tabs',
      'debugger',
      'webRequest',
      'declarativeNetRequestFeedback',
      'scripting',
    ]) {
      expect(store.permissions).not.toContain(banned);
    }
    expect(store.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(store.externally_connectable.matches).toEqual(['https://headerbench.com/*']);
    expect(store.version).toBe('1.2.3');
    expect(store.name.length).toBeLessThanOrEqual(75);
    expect(store.description.length).toBeLessThanOrEqual(132);
  });

  it('adds localhost access only in the E2E flavour', () => {
    const e2e = buildManifest({ version: '1.0.0', e2e: true, apiBase: 'https://headerbench.com' });
    expect(e2e.host_permissions).toEqual(['http://127.0.0.1/*', 'http://localhost/*']);
    expect(e2e.permissions).toContain('declarativeNetRequestFeedback');
    expect(e2e.externally_connectable.matches).toContain('http://localhost/*');
  });
});

describe('build env', () => {
  it('defaults to the dev licence key and headerbench.com', () => {
    expect(readBuildEnv({})).toEqual({
      e2e: false,
      licensePublicKey: DEV_LICENSE_PUBLIC_KEY,
      apiBase: 'https://headerbench.com',
    });
  });

  it('reads HB_E2E, HB_LICENSE_PUBLIC_KEY and HB_API_BASE', () => {
    const key = 'AB'.repeat(32);
    expect(
      readBuildEnv({
        HB_E2E: '1',
        HB_LICENSE_PUBLIC_KEY: key,
        HB_API_BASE: 'http://localhost:3000/',
      }),
    ).toEqual({
      e2e: true,
      licensePublicKey: key.toLowerCase(),
      apiBase: 'http://localhost:3000',
    });
  });

  it('refuses unsafe or malformed values', () => {
    expect(() => readBuildEnv({ HB_LICENSE_PUBLIC_KEY: 'abc' })).toThrow(/64 hex/);
    expect(() => readBuildEnv({ HB_API_BASE: 'http://headerbench.com' })).toThrow(/https/);
    expect(() => readBuildEnv({ HB_API_BASE: 'nope' })).toThrow(/not a URL/);
  });
});

describe('store packaging guard', () => {
  const run = (script: string, args: string[], key: string | undefined) => {
    const env = { ...process.env };
    delete env.HB_LICENSE_PUBLIC_KEY;
    if (key !== undefined) env.HB_LICENSE_PUBLIC_KEY = key;
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
  };
  const packageScript = resolve(__dirname, '../scripts/package.mjs');
  const checkScript = resolve(__dirname, '../../scripts/check-manifest.mjs');
  const releaseKeyScript = resolve(__dirname, '../../scripts/release-key.mjs');

  it('refuses to package without a production licence key, before building', () => {
    for (const key of [undefined, '', DEV_LICENSE_PUBLIC_KEY]) {
      const result = run(packageScript, [], key);
      expect(result.status, String(key)).toBe(1);
      expect(result.stderr).toMatch(/HB_LICENSE_PUBLIC_KEY/);
      expect(result.stderr).toMatch(/node scripts\/gen-license-key\.mjs.*DEPLOY\.md §1/);
      expect(result.stdout).not.toMatch(/built in/);
    }
  });

  it('refuses a key other than the production one unless told to', () => {
    const other = 'ab'.repeat(32);
    const result = run(packageScript, [], other);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not the production key \(666897a8…\).*--allow-other-key/);
    expect(result.stdout).not.toMatch(/built in/);
    const check = run(checkScript, [], other);
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/not the production key/);
  });

  it('refuses unknown options', () => {
    const result = run(packageScript, ['--allow-dirt'], 'ab'.repeat(32));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown option --allow-dirt/);
  });

  it('checks a built folder: manifest, API base and licence key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-dist-'));
    const key = 'cd'.repeat(32);
    const good = buildManifest({
      version: '1.0.3',
      e2e: false,
      apiBase: 'https://headerbench.com',
    });
    const problemsFor = (manifest: object, code: string): string[] => {
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      writeFileSync(join(dir, 'sw.js'), code);
      const out = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { distProblems } from ${JSON.stringify(releaseKeyScript)};
           process.stdout.write(JSON.stringify(distProblems(process.argv[1], process.argv[2])));`,
          dir,
          key,
        ],
        { encoding: 'utf8' },
      );
      return JSON.parse(out.stdout) as string[];
    };
    const bundle = (base: string, k: string) =>
      `var LICENSE_PUBLIC_KEY = "${k}";\nvar API_BASE = "${base}";\n`;
    try {
      expect(problemsFor(good, bundle('https://headerbench.com', key))).toEqual([]);
      const local = buildManifest({
        version: '1.0.3',
        e2e: true,
        apiBase: 'http://localhost:3000',
      });
      const problems = problemsFor(local, bundle('http://localhost:3000', DEV_LICENSE_PUBLIC_KEY));
      expect(problems).toEqual([
        expect.stringMatching(/^host_permissions must be absent/),
        'permission "declarativeNetRequestFeedback" must not be requested',
        expect.stringMatching(/^externally_connectable\.matches must be exactly/),
        'the built extension contains the development licence public key',
        'the built extension does not contain HB_LICENSE_PUBLIC_KEY (stale build?)',
        'the built extension talks to http://localhost:3000 instead of https://headerbench.com',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the release manifest check without a production key', () => {
    for (const key of [undefined, DEV_LICENSE_PUBLIC_KEY]) {
      const result = run(checkScript, [], key);
      expect(result.status, String(key)).toBe(1);
      expect(result.stderr).toMatch(/Store build check failed: HB_LICENSE_PUBLIC_KEY/);
    }
    // The CI flag generates a throwaway key, but never accepts the dev key.
    const ci = run(checkScript, ['--throwaway-key'], DEV_LICENSE_PUBLIC_KEY);
    expect(ci.status).toBe(1);
    expect(ci.stderr).toMatch(/development key/);
  });
});
