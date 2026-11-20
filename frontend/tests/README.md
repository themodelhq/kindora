# Frontend tests

Two layers, two runners:

| Suite | Runner | Scope |
| --- | --- | --- |
| `tests/unit/*.test.ts` | Vitest (node env, `vitest.config.ts`) | Pure logic only — no DOM, no rendering |
| `tests/e2e/*.spec.ts` | Playwright (chromium) | Demo build served by `vite preview` |

## Unit suites

- **`money.test.ts`** — `formatMoney` (NGN/USD symbol + grouping, zero-decimal XOF, bigint input, malformed-currency fallback), `decimalsOf`, `majorValue`/`minorFromMajor` round-trip (including float artifacts), `progressPercent` (zero/negative target → 0, clamp at 100, string amounts).
- **`utils.test.ts`** — `formatDate` (valid ISO / Date object, invalid → `''`, null/undefined → `''`), `daysUntil` (past date → negative integer, future → whole days, null → `null`), `initials` (uppercased pair, missing names → `'K'` fallback), `truncate` (ellipsis, ≤ length, untouched short text).
- **`demo-adapter.test.ts`** — runs with `VITE_DEMO_MODE=1` (set at the top of the file): paginated campaign list + `status=ACTIVE` filter, campaign detail with its matching pool, simulated `POST /donations` (publicRef, redirectUrl, raisedAmount/donorCount increment), impact summary totals, unknown-route `{ demo: true }` fallback.
- **`auth-store.test.ts`** — zustand store via `useAuthStore.getState()/setState()`: initial signed-out state, `setUser`/`setAccessToken`, `clear()` wipe.

## Running

```bash
npm test            # unit tests (vitest run --config vitest.config.ts)
npm run test:watch  # watch mode
npm run e2e         # Playwright against the demo preview server (port 4173)
```

## E2E notes

- E2E runs against the **DEMO build**: `VITE_DEMO_MODE=1` must be set at *build
  time* (e.g. `VITE_DEMO_MODE=1 npm run build`) so the API layer is served by the
  local demo adapter. `playwright.config.ts` starts `vite preview` on port 4173
  (`webServer`) and reuses an already-running server outside CI.
- E2E selectors are intentionally resilient (role/label queries, branching on
  optional UI like the provider select and guest fields) — see the header
  comment in `demo-smoke.spec.ts`.
- Override the target with `E2E_BASE_URL=https://…` to test a deployed build.

## CI mapping

- **Build/test job** (no browsers): `npm run typecheck` + `npm test` — the unit
  suite is the gate on every push.
- **E2E job** (browsers installed): build with `VITE_DEMO_MODE=1`, then
  `npm run e2e`. In CI `reuseExistingServer` is false, so Playwright boots its
  own preview server.
