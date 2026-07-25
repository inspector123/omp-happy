import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright Electron specs (*.e2e.spec.ts) run via `playwright test`,
    // not vitest — importing @playwright/test under vitest throws.
    exclude: ['**/node_modules/**', '**/out/**', '**/*.e2e.spec.ts'],
  },
});
