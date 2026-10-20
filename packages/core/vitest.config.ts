import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        'src/compile.ts': { lines: 90 },
        'src/tester.ts': { lines: 90 },
        'src/import/**': { lines: 90 },
      },
    },
  },
});
