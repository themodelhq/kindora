import { defineConfig, devices } from '@playwright/test';

/**
 * KINDORA E2E configuration (demo build).
 *
 * Tests run against the DEMO build: the API layer is served by the local demo
 * adapter (src/lib/demo/adapter.ts) with no backend. VITE_DEMO_MODE is baked
 * in at BUILD time, so build with `VITE_DEMO_MODE=1 npm run build` before
 * running `npm run e2e` — the webServer below only starts `vite preview` on
 * the dist/ output.
 *
 * Run with: npm run e2e   (browsers required: npx playwright install chromium)
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Demo flows are sequential by nature (home -> campaigns -> donate).
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --port 3000 --strictPort',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
    env: {
      ...process.env,
      VITE_DEMO_MODE: '1',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
