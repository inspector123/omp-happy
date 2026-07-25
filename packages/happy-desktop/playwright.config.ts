import { defineConfig } from '@playwright/test';

// Playwright Electron e2e. Self-skipping unless HD_LIVE=1 (see tests/ui.e2e.spec.ts).
export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.e2e.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
});
