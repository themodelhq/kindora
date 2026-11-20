# DEPENDENCY SECURITY REPORT — v1.0.4

**Date:** 2026-11-13 (release build)
**Method:** `npm audit` (registry advisory DB), lockfile-aware, production-tree
(`--omit=dev`) and full-tree views per package. No `npm audit fix --force` was
used. Every remediation below was followed by the full unit test suites and
production builds.

---

## 1. Remediated advisories

### Nodemailer (backend + workers) — HIGH

| | |
|---|---|
| v1.0.3 version | `6.9.16` (backend `^6.9.16`, workers `^6.9.16`) |
| v1.0.4 version | **`10.5.0`** |
| Advisories resolved | The 2025/2026 nodemailer advisory set, including the HIGH findings GHSA-r7g4-qg5f-qqm2 (fixed 8.0.8), GHSA-2x7j-588g-ccc2 (fixed 9.1.0), GHSA-p6gq-j5cr-w38f (fixed 9.0.1), GHSA-v53p-9fqp-m79j (fixed 10.0.6) and the moderate set fixed by 10.1.4 (addressparser ReDoS, IDN allow-list bypass, CRLF injection, OAuth2 TLS validation, DKIM unfolding DoS, TLS servername cache reuse, recipient-domain mis-parse, etc.). |
| Compatibility | Usage is `createTransport` + `sendMail` with html/text (backend `notifications.service`, workers `lib/mailer.ts`) — API-compatible across 6→10. Type definitions updated (`@types/nodemailer ^8.0.2`). SMTP configuration variables unchanged. |
| Verified by | Backend + workers typecheck/build; email-sending code paths compile and unit suites pass. Live SMTP delivery requires operator credentials (see test report, blocked items). |

### Zod (frontend) — HIGH

| | |
|---|---|
| v1.0.3 version | `3.24.1` |
| v1.0.4 version | **`4.6.7`** |
| Advisories resolved | The `<4.6.6` HIGH advisory line (ReDoS-class regex issues in the 3.x/4.x parser lineage), plus the earlier 3.25.x ReDoS fixes. |
| Breaking changes fixed | `required_error`/`invalid_type_error` error-map params were removed in zod 4 — `src/pages/donate/checkout.tsx` migrated to the zod 4 `{ error: (issue) => ... }` form. All six schema files (`register`, `login`, `forgot`, `reset`, `settings`, `checkout`) typecheck and all 52 frontend unit tests pass. Type inference remains correct under zod 4. |

### Sharp / libvips (workers) — HIGH

| | |
|---|---|
| v1.0.3 version | `0.33.0` (resolved `0.33.5`) |
| v1.0.4 version | **`0.35.5`** |
| Advisories resolved | libvips CVE set GHSA-f88m-g3jw-g9cj (CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591) — fixed in the 0.35.x prebuilt libvips bundle. |
| Requirements verified | Node.js ≥ 20 (workers engines field); a REAL image-processing smoke test runs in CI and locally: generate → resize → re-encode → metadata check (400×300 JPEG) passes. Metadata stripping, resizing, re-encoding and derivative generation code paths unchanged. |
| Deployment | `sharp@0.35.5` installs from prebuilt binaries on Render's Linux x64 images (same install mode as 0.33.x). The CI "Workers" job exercises the exact installed tree. |

### Unused vulnerable dependency removed

| Package | Action |
|---|---|
| `@sentry/node ^8.50.0` (backend) | **Removed.** It was declared but NEVER imported anywhere in `src/` (only a `SENTRY_DSN` config passthrough existed). It dragged the entire OpenTelemetry instrumentation chain (22 moderate advisories, fix requiring `@sentry/node` 11). If Sentry is adopted later, re-introduce it at the then-current major with advisories cleared. |

## 2. Current audit posture (post-remediation)

| Package | `npm audit --omit=dev` | Notes |
|---|---|---|
| backend | 0 moderate/high from application dependencies | Remaining findings are the `prisma` CLI chain (below) and dev tooling (eslint/minimatch, glob, @nestjs/cli) outside the production runtime tree. |
| frontend | 2 moderate (dev tooling) | No high/critical. Production bundle dependencies clean. |
| workers | 3 high = `prisma` → `@prisma/config` → `deepmerge-ts` chain | Same as backend (see accepted risk below). `sharp` clean at 0.35.5. |

## 3. Accepted risks (explicitly documented, not suppressed)

| Finding | Severity | Where | Why accepted | Exploitable in production? | Upgrade path |
|---|---|---|---|---|---|
| `deepmerge-ts` < 8.0.0 — stack exhaustion on recursive merges (GHSA-ggr8-5vv4-36mx) via `@prisma/config` inside the **Prisma CLI** | HIGH (dev chain) | backend + workers (prisma CLI 6.19.3) | The CLI is build/migration tooling. The runtime application (`dist/` + `@prisma/client` engine) never executes `@prisma/config`. It is not shipped in the deploy artifact and only processes operator-controlled migration/config files. | No — build-time only. | Prisma ≥ 7.11 ships patched `@prisma/config`; requires the Prisma 7 config-file migration (breaking). Scheduled as a follow-up upgrade, deliberately not bundled into this financial-security release to avoid a framework major migration in the same change window. |
| eslint/typescript-estree `minimatch` ReDoS (GHSA-g3hv-75wg-m249), `glob` 9–14, `@nestjs/cli` chain, `deepmerge` prototype-poisoning (dev) | moderate (dev chain) | all packages | Lint/build tooling only; never present in the deployed runtime. | No. | Resolved gradually by upstream majors; tracked. |
| `@nestjs/cli` moderate via `fork-ts-checker-webpack-plugin` | moderate (dev) | backend | Build tooling only. | No. | Upgrade with the next NestJS CLI major. |

### Remediation record — 2026-11-20 (evidence/packaging correction)

`effect` (Effect-TS) was flagged by `npm audit` as an additional affected package of the prisma-CLI advisory chain
(GHSA-7589-6fvf-x4pw — ReDoS in `effect` Schema.TemplateLiteral, affected <= 3.22.0, patched 3.22.1).
`effect@3.21.0` is reachable ONLY via `@prisma/client -> prisma -> @prisma/config -> effect` (build/migration tooling;
zero imports in backend/workers runtime source). REMEDIATED (not accepted): scoped npm `overrides` added to
backend/package.json and workers/package.json pinning `effect@^3.22.1` (lockfiles now resolve effect@3.22.5).
Regression proof after the change: backend unit 595/595, Flutterwave 157/157, Paystack 111/111, payout+ledger 184/184,
frontend 53/53, tsc x2 clean, prisma validate clean, migrations-vs-schema structural PASS, audit gates x3 PASS.
The `deepmerge-ts` / `@prisma/config` acceptances above remain unchanged (no patched @prisma/config exists for
prisma 6.x; the prisma >= 7.11 upgrade path is unchanged).

CI policy (`npm audit --omit=dev --audit-level=high` on all three packages)
fails the build on any NEW high/critical in production dependencies; the
accepted dev-chain findings above do not affect that gate.

## 4. Verification commands

```bash
cd backend  && npm audit --omit=dev --audit-level=high
cd frontend && npm audit --omit=dev --audit-level=high
cd workers  && npm audit --omit=dev --audit-level=high
```

Lockfile consistency: all three `package-lock.json` files were regenerated by
`npm install` with the final manifests and are committed together
(`npm ci` is the install path in CI and deployment).
