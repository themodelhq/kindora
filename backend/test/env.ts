/**
 * Integration-test environment defaults.
 *
 * Loaded via `setupFiles` in test/jest-e2e.json so it runs BEFORE any test
 * module (and therefore before `app.module.ts` is evaluated — AuthModule
 * .forRoot() reads PROVIDER_MODE at module-evaluation time to decide whether
 * the test-only dev verification controller mounts).
 *
 * Explicit CI/shell env always wins; these are only safe offline defaults:
 *  - PROVIDER_MODE=mock  -> deterministic mock payment adapter + dev auth hook
 *  - REDIS_URL empty     -> queue producer degrades gracefully (no Redis needed)
 *  - JWT_SECRET fixed    -> tokens verifiable inside the test process
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.PROVIDER_MODE = process.env.PROVIDER_MODE ?? 'mock';
process.env.REDIS_URL = process.env.REDIS_URL ?? '';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'kindora-integration-test-secret';

export {};
