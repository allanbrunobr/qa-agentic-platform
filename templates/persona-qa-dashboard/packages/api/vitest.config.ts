import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // src/routes/__tests__ holds node:test suites run via `node --import tsx --test`.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/routes/__tests__/**'],
    // T-05: measured with `vitest run --coverage`, no threshold yet. The node:test route suites above
    // are not part of this run, so files under src/routes read lower than they are.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/__tests__/**'],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
})
