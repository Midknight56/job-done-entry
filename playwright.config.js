// End to end tests. Headless only, one browser, one test at a time (this PC runs one browser test at a time).
// Point BASE_URL at a running Worker: `npm run dev:local` serves http://127.0.0.1:8797.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8797',
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
    // A fresh visitor per run for a local Worker with the stand in model (the hosted app ignores it). A cookie, not a
    // header: a header would also go to PayPal's pages, and an unknown header stalls PayPal's checkout.
    storageState: {
      cookies: [
        { name: 'jd_test', value: `run-${process.pid}-${Date.now()}`, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
        // The maintainer's own runs against the hosted app (JD_MAINT set from .deploy.local.json; never committed).
        ...(process.env.JD_MAINT && process.env.BASE_URL?.startsWith('https://')
          ? [{ name: 'jd_maint', value: process.env.JD_MAINT, domain: new URL(process.env.BASE_URL).hostname, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }]
          : []),
      ],
      origins: [],
    },
  },
})
