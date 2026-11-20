import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Dedicated unit-test config, separate from vite.config.ts (which pulls in the
 * PWA plugin and is only meant for building the app).
 *
 * Node environment keeps the suite fast: unit tests here exercise pure logic
 * only (money formatting, date helpers, the demo adapter's routing, zustand
 * store transitions) — no DOM, no component rendering.
 *
 * Run with: npm test  (or: npx vitest run --config vitest.config.ts)
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
  },
});
