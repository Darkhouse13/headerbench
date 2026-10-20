import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { readBuildEnv } from './tooling/env.ts';
import type { BuildEnv } from './tooling/env.ts';
import { renderIcons } from './tooling/icons.ts';
import { buildManifest } from './tooling/manifest.ts';
import pkg from './package.json' with { type: 'json' };

const root = fileURLToPath(new URL('.', import.meta.url));

/** Emits manifest.json and the PNG icons next to the bundle. */
function extensionFiles(env: BuildEnv): Plugin {
  return {
    name: 'headerbench-extension-files',
    apply: 'build',
    generateBundle() {
      const manifest = buildManifest({ version: pkg.version, e2e: env.e2e, apiBase: env.apiBase });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
      for (const icon of renderIcons(resolve(root, 'assets/icon.svg'))) {
        this.emitFile({ type: 'asset', fileName: icon.fileName, source: icon.source });
      }
    },
  };
}

export default defineConfig(() => {
  const env = readBuildEnv(process.env);
  return {
    root,
    base: '',
    publicDir: false,
    define: {
      __HB_E2E__: JSON.stringify(env.e2e),
      __HB_LICENSE_PUBLIC_KEY__: JSON.stringify(env.licensePublicKey),
      __HB_API_BASE__: JSON.stringify(env.apiBase),
      __HB_VERSION__: JSON.stringify(pkg.version),
    },
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    // npm hoists Preact 11 for peer ranges (lucide-preact, testing-library); everything must share
    // this package's Preact 10, or hooks break.
    resolve: { dedupe: ['preact'] },
    plugins: [extensionFiles(env)],
    build: {
      // The E2E flavour has localhost host access; it never shares a folder with the store build.
      outDir: env.e2e ? 'dist-e2e' : 'dist',
      emptyOutDir: true,
      target: 'chrome128',
      // Unminified on purpose: reviewers and users can read what ships (STACK.md).
      minify: false,
      cssMinify: false,
      modulePreload: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: {
          sw: resolve(root, 'src/sw/index.ts'),
          popup: resolve(root, 'popup.html'),
          app: resolve(root, 'app.html'),
          welcome: resolve(root, 'welcome.html'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name].js'),
          // The UI bundle is `ui.js`; code shared with the service worker goes to `shared-*.js`.
          chunkFileNames: (chunk) =>
            chunk.name === 'main' ? 'assets/ui.js' : 'assets/shared-[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['test/setup.ts'],
      server: { deps: { inline: ['lucide-preact', '@testing-library/preact'] } },
      coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], reporter: ['text-summary'] },
    },
  };
});
