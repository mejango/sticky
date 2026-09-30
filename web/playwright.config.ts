import { defineConfig, devices } from '@playwright/test'
import {
  APP_PORT,
  FIXTURE_PORT,
  SIGNA_PORT,
  deterministicEnv,
  fixtureOrigin,
  signaEnv,
} from './scripts/browser-env.mjs'

const appOrigin = `http://127.0.0.1:${APP_PORT}`
const signaOrigin = `http://127.0.0.1:${SIGNA_PORT}`
// `npm run test:browser:record` reads what the fixture does not hold from the
// live services and keeps it. Live reads are slow, so every wait is longer.
const recording = process.env.STICKY_RECORD === '1'

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  globalTeardown: './test/browser/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: recording ? 1 : process.env.CI ? 2 : undefined,
  timeout: recording ? 600_000 : 90_000,
  expect: { timeout: recording ? 240_000 : 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  outputDir: 'test-results',
  use: {
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/signa.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: appOrigin },
    },
    {
      name: 'signa',
      testMatch: '**/signa.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: signaOrigin,
        // The modeled Signa is a public https origin framing this local app;
        // Chrome's local network checks would stop the frame's navigation
        // from one to the other, which production never has.
        launchOptions: {
          args: [
            '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForNavigations,PrivateNetworkAccessForNavigations',
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: `node test/browser/fail-fast-service.mjs --port ${FIXTURE_PORT}${recording ? ' --record' : ''}`,
      url: `${fixtureOrigin}/health`,
      reuseExistingServer: false,
      timeout: 15_000,
      // A recording run writes what it read on the way out.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: 'npm run start',
      url: `${appOrigin}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { HOSTNAME: '127.0.0.1', PORT: String(APP_PORT), ...deterministicEnv },
    },
    {
      command: 'npm run start',
      url: `${signaOrigin}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { HOSTNAME: '127.0.0.1', PORT: String(SIGNA_PORT), ...signaEnv },
    },
  ],
})
