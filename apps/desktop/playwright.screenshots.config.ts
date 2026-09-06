import { defineConfig } from '@playwright/test'

/**
 * Deterministic visual-regression runner (plan Todo 6).
 *
 * Marketing/docs capture stays in `e2e/capture-screenshots.spec.ts` and is
 * invoked separately via `pnpm --filter hubfetch-desktop test:screenshots`.
 * This config never hits live Hub data: the spec boots a local fixture
 * server, a frozen HF cache, and a pre-seeded downloads DB.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'visual-regression.spec.ts',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate: '{testDir}/visual-regression.snapshots/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'device',
      maxDiffPixels: 0,
      threshold: 0.1
    }
  },
  use: {
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
