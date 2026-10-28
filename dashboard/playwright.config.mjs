import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 45_000,
  // A missing baseline is a failure; only the explicit update command creates it.
  updateSnapshots: 'none',
  snapshotPathTemplate: process.env.LOCAL_VISUAL_CAPTURE_DIR
    ? `${process.env.LOCAL_VISUAL_CAPTURE_DIR}/{projectName}/{arg}{ext}`
    : `{testDir}/__screenshots__/${process.platform === 'linux' ? 'linux-ci' : (process.env.CI ? 'macos-ci' : '{platform}')}/{projectName}/{arg}{ext}`,
  expect: { timeout: 10_000, toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 100,
    stylePath: './tests/visual/screenshot.css' } },
  use: {
    baseURL: 'http://127.0.0.1:8877',
    browserName: 'chromium',
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light',
    reducedMotion: 'reduce', serviceWorkers: 'block',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }], ['./scripts/visual-coverage-reporter.mjs']],
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'pnpm exec vite preview --config vite.visual.config.mjs',
    url: 'http://127.0.0.1:8877', reuseExistingServer: false, timeout: 120_000,
  },
});
