# KINDORA v1.0.4 TEST REPORT

**Release:** KINDORA v1.0.4 — Payout State Machine Lockdown & Approval Separation
**Baseline:** KINDORA v1.0.3_SECURITY_COMPLETE
**Test date:** 2026-11-13
**Environment:** offline release sandbox (Linux, Node 22/24, no PostgreSQL, no Redis, no external payment providers, no S3-compatible storage). Integration suites are guarded by `RUN_INTEGRATION=1` and run in CI against real services.

Honesty rule: the tables below distinguish **EXECUTED** (actually ran in this release verification), **BLOCKED** (requires external infrastructure not available here — wired into CI so they run on every push) and **PENDING** (requires live operator infrastructure).

---

## 1. Executed verification (this release)

| # | Suite / check | Result | Evidence |
|---|---|---|---|
| 1 | Backend lint (`eslint src,test`) | PASS — 0 errors (18 pre-existing warnings) | lint output |
| 2 | Backend typecheck (`tsc --noEmit`, includes `test/`) | PASS | tsc exit 0 |
| 3 | Backend unit suites (`jest`, excludes `/test/`) | **PASS — 12 suites, 195 tests, 0 failures** | jest run |
| 4 | Backend production build (`nest build`) | PASS | dist/ produced |
| 5 | Payout state machine regression (`src/payouts/payout-state-machine.spec.ts`) | PASS — 25 tests: 44 permitted edges, 21 forbidden edges rejected, terminal states, classification tables, 10 reconciliation outcomes incl. UNKNOWN≠FAILED | jest |
| 6 | Dual-approval separation regression (`withdrawals-approval.spec.ts`) | PASS — 26 tests incl. the v1.0.3 UNDER_REVIEW loophole reproduction (now rejected), executor separation, amount/currency binding invalidation, concurrent second approval, legacy method removal | jest |
| 7 | Fresh-MFA regression (`src/mfa/*.spec.ts`) | PASS — RFC 4226 conformance (10 vectors), TOTP window drift, base32 RFC 4648 vectors, challenge single-use / purpose-bound / scope-bound / user-bound, TOTP replay suppression, fail-closed Redis | jest |
| 8 | Redis URL validation regression (`redis-url.util.spec.ts`) | PASS — 17 cases (valid redis/rediss, malformed, unsupported protocol, missing host, invalid port, credential redaction, TLS requirement) | jest |
| 9 | Frontend lint | PASS — 0 errors (9 pre-existing warnings) | eslint |
| 10 | Frontend typecheck (`tsc --noEmit`) | PASS | tsc exit 0 |
| 11 | Frontend unit tests (`vitest`) | **PASS — 5 files, 52 tests** (incl. rewritten settlement-form validation) | vitest |
| 12 | Frontend production build (`tsc && vite build`, PWA) | PASS — 83 precache entries, sw.js generated | vite build |
| 13 | Workers lint / typecheck / build | PASS | tsc exit 0, dist/ produced |
| 14 | **REAL image processing** (sharp 0.35.5 / libvips): generate → resize → re-encode → metadata | PASS — 800×600 PNG → 400×300 JPEG verified | node script (also wired into CI) |
| 15 | Dependency audit gates (3 packages) | PASS — 0 unaccepted high/critical in production trees; accepted risks documented (DEPENDENCY_SECURITY_REPORT §3) | scripts/audit-gate.mjs |
| 16 | Backup archive integrity | PASS — 3× `unzip -t` OK + SHA-256 recorded | §7 |
| 17 | Checksum manifest verification | PASS — every listed file verified with `sha256sum -c` after packaging | §7 |
| 18 | Legacy endpoint removal — source sweep | PASS — `rg "mark-paid|mark-failed|mark-processing" backend/src frontend/src` returns 0 code references (only historical audit documents mention them) | grep sweep |
| 19 | Prisma schema validation (`prisma validate`) | PASS | prisma CLI 6.19.3 |
| 20 | Migration generation (0003_payout_lockdown) | PASS — additive SQL generated via `prisma migrate diff` from the pristine v1.0.3 schema (extracted from the verified backup, not from a stale copy) | migration.sql, 178 lines |

## 2. Integration tests — wired to CI, BLOCKED in this sandbox

These suites boot the real AppModule against **real PostgreSQL + real Redis** (PROVIDER_MODE=mock) and are executed by the `backend-integration` CI job on every push. They could not run in this offline sandbox (no database service); no result is claimed for them here.

| Suite | What it proves (v1.0.4 update) | CI status |
|---|---|---|
| `test/withdrawals.e2e-spec.ts` | masking/authorization; legacy endpoints 404; fail-closed MFA on payout actions; REAL fresh-MFA flow (enroll → confirm → single-use challenge); dual approval A→B; first-approver double-approval refusal; executor ≠ second approver; settlement with registered evidence file; `evidenceUrl` rejected; exactly-once ledger (P2002 → 409 on stale-state replay); concurrent overdraw | WIRED (Redis service added to the job) |
| `test/auth.e2e-spec.ts` | authentication + refresh rotation | WIRED |
| `test/webhooks.e2e-spec.ts` | webhook signature verification + dedupe | WIRED |
| `test/storage.e2e-spec.ts` | upload → scan lifecycle → authorized access (evidence mechanism) | WIRED |
| `test/money-path.e2e-spec.ts` | donation → ledger exactly-once | WIRED |

**Real S3-compatible storage test (§13.6):** the storage suite runs against the configured storage endpoint when credentials exist; in CI it runs with the test configuration. It was NOT executed in this sandbox (blocked — no object storage).

## 3. PENDING operator verification (deployment-time)

The following require live infrastructure/credentials and are explicitly NOT claimed as passing (§15 "Required or explicitly blocked"):

1. Render blueprint deploy: API/worker/cron startup with real PostgreSQL + Redis (`/health`, `/health/database`, `/health/redis`).
2. Redis fail-closed behavior under a real outage (exercised only at unit level).
3. Paystack sandbox / Flutterwave sandbox connectivity + real `verifyTransfer` responses (read-only verification calls; no live transfers were executed — none authorized).
4. Real SMTP delivery (password reset, MFA recovery notifications, payout notifications) with operator credentials.
5. Migration `0003_payout_lockdown` applied to a **restored v1.0.3 database** (§12 — sandbox has no database; the migration is additive and was generated by diff against the pristine v1.0.3 schema, but the DB-restore rehearsal remains an operator step before production rollout).
6. Netlify frontend deploy + PWA against the live API.

## 4. Money-path invariants verified by the executed suites

- A payout can NEVER be settled twice (unique ledger reference; 409).
- A transfer that is PENDING / UNKNOWN / ambiguous can NEVER be failed or retried by an administrator (no endpoint exists; state machine + tests).
- Approval identities are immutable rows bound to amount+currency; the first approver cannot be the second approver in ANY state (loophole removed + regression test).
- The second approver cannot execute the payout; three distinct administrators are required for dual-approval payouts.
- Every sensitive payout action requires a fresh, single-use, purpose- and scope-bound MFA challenge; Redis unavailability fails closed.
- Arbitrary external evidence URLs are rejected; evidence must be a registered private, scanned file bound to exactly one withdrawal.
- Duplicated webhooks/ledger entries cannot double-settle donations (existing v1.0.3 suites, unchanged and still green).

## 5. Test-count summary

| Package | Executed tests | Result |
|---|---|---|
| backend unit | 195 | all pass |
| frontend unit | 52 | all pass |
| workers | build + real sharp pipeline | pass |
| backend integration | (CI-wired) | blocked in sandbox, run on every push |

## 6. Files changed by the security remediation

Backend: `payouts/` (new: state machine + PayoutService + module), `mfa/` (new: TOTP, service, guard, controller), `withdrawals/` (rewritten service/controller/DTOs), `payments/` (verifyTransfer on Paystack/Flutterwave/Mock + interface), `common/config/configuration.ts` (startup validation), `common/redis.service.ts` (strict URL validation + GETDEL), `common/utils/redis-url.util.ts` (new), `storage` (PAYOUT_EVIDENCE kind), `ledger` (reservation list + REQUIRES_RECONCILIATION), `admin.controller` (MFA guards), `app.module` (MfaModule, PayoutsModule), prisma schema + migration 0003.
Frontend: admin withdrawals page rewrite, MFA challenge dialog (new), hooks (MFA + settlement), http header support, settlement form lib, zod 4 migration.
Workers: nodemailer/sharp upgrades, Redis URL validation.
Infra: `.github/workflows/ci.yml` (16 mandatory checks), `render.yaml` (policy env), `scripts/audit-gate.mjs` (new).
