# KINDORA v1.0.4 SECURITY AUDIT

**Release:** KINDORA v1.0.4 — Payout State Machine Lockdown & Approval Separation
**Baseline audited:** KINDORA v1.0.3_SECURITY_COMPLETE (source review findings used as the audit input)
**Audit method:** full source review of every payout/withdrawal touchpoint, controllers, services, workers, webhooks, configuration, dependency manifests and lockfiles; behavior verified against actual code, not documentation.

---

## 1. Findings from the v1.0.3 source review — remediation status

| # | v1.0.3 finding | Severity | v1.0.4 status |
|---|---|---|---|
| F1 | Legacy payout-state endpoints `POST /withdrawals/:id/mark-failed` and `POST /withdrawals/:id/mark-processing` bypass the canonical lifecycle | P0 | **REMEDIATED.** Routes removed (404); `markProcessing`/`markFailed` service methods deleted; a source sweep confirms no caller remains; regression tests assert 404 + method absence. |
| F2 | `mark-failed` could move a PROCESSING payout to FAILED without authoritative confirmation → duplicate-payout scenario | P0 | **REMEDIATED.** `PROCESSING → FAILED` is reachable ONLY through `PayoutService.applyProviderVerification` with a classified authoritative `FAILED` result. Timeouts/HTTP errors/unknown responses classify as `UNKNOWN` → `REQUIRES_RECONCILIATION` with the reservation intact. |
| F3 | Unsafe retry operations could duplicate payouts | P0 | **REMEDIATED.** `PayoutService.retry` requires status FAILED + zero unresolved attempts (INITIATED/PENDING/UNKNOWN) + an authoritative failure reason; attempts have unique idempotency keys (`payout:<wd>:<n>`) and unique provider references (DUPLICATE_REFERENCE detection). |
| F4 | Dual-approval separation-of-duties loophole: `secondApproval()` allowed the first approver to self-confirm the second approval while `UNDER_REVIEW` | P0 | **REMEDIATED.** Exception removed; identity separation checked before the state gate; immutable `WithdrawalApproval` rows per cycle/role with amount+currency snapshots; executor separation enforced at settlement; regression test reproduces the loophole and asserts rejection. |
| F5 | Payout approval endpoints lacked fresh MFA | P1 | **REMEDIATED.** New `MfaService` + `MfaFreshGuard`: TOTP enrollment, single-use purpose+scope-bound challenges (120 s TTL), fail-closed on Redis unavailability. Applied to all 11 sensitive endpoints (see ADMIN_FRESH_MFA_POLICY §2). |
| F6 | High-severity dependency advisories (nodemailer, zod, sharp/libvips) | P1 | **REMEDIATED.** nodemailer 6.9.16 → 10.5.0; zod 3.24.1 → 4.6.7 (with the zod 4 error-map migration); sharp 0.33.x → 0.35.5 (patched libvips). Unused `@sentry/node` removed. Audit gates pass (DEPENDENCY_SECURITY_REPORT §2). |
| F7 | Redis URL validation checked only the protocol prefix | P2 | **REMEDIATED.** `validateRedisUrl` (standard URL parser: protocol, hostname, port, db path, credentials encoding, TLS policy) applied at backend startup (prod fail-fast), in `RedisService`, and in workers `requireRedisUrl` (process exit on invalid). Passwords never logged. |
| F8 | Redis outage silently degraded security counters (fail-open risk) | P2 | **REMEDIATED for MFA/payout paths.** MFA challenges are Redis-only and fail closed (503); `/health/redis` reports readiness. No per-process fallback exists for challenge consumption. |
| F9 | Manual payout evidence accepted arbitrary `evidenceUrl` strings | P2 | **REMEDIATED.** `evidenceFileId` (StoredFile) required for settlement: private, `PAYOUT_EVIDENCE` kind, scan CLEAN, uploader-bound, unique binding per withdrawal (reuse impossible), audited access via short-lived signed URLs. |
| F10 | Reconciliation lacked a structured result model | P1 | **REMEDIATED.** `PayoutReconciliation` rows with the 10-category result model; UNKNOWN never collapses to FAILED; reconciliation never initiates payouts or releases funds; every run is persisted with provider evidence. |

## 2. Controls verified against source (not documentation)

1. **Endpoint inventory** — every route in `withdrawals.controller.ts` was enumerated; exactly the three legacy routes were removed, all remaining admin routes carry `@Roles('ADMIN')` + `@RequireMfa(...)`. Route-order shadowing (`GET :id` vs `GET :id/evidence-url`) re-checked.
2. **State transition authority** — `rg` sweep: every `withdrawal.updateMany/update` writing `status` lives in `WithdrawalsService`/`PayoutService` under `assertTransition` or an explicit from-state guard. Workers never write withdrawal status.
3. **Ledger exactly-once** — settlement posts inside the same transaction as the state change; unique reference `withdrawal:<id>`; P2002 → 409 (unit + integration replay tests).
4. **Approval immutability** — approvals are never updated in place; invalidation preserves the row (`status: INVALIDATED` + invalidator identity); `@@unique([withdrawalId, cycle, role])` prevents duplicate role records per cycle.
5. **MFA challenge atomicity** — consumption uses Redis `GETDEL`; concurrent double-use loses with an explicit error; TOTP replay across challenges blocked by SET NX per (user, counter).
6. **Secret hygiene** — TOTP secrets AES-256-GCM encrypted at rest (scrypt-derived key, domain-separated); enrollment secret returned exactly once; no secrets in logs or error messages (redis sanitizer verified by tests).
7. **Provider verification trust** — `verifyTransfer` is read-only GET; administrator-entered references are NOT trusted as settlement proof — only provider-verified results or registered evidence + dual approval settle a payout.
8. **Webhook integrity** — v1.0.3 signature verification and dedupe retained unchanged (§2 preservation mandate); payout state is only affected through PayoutService classification.
9. **Production fail-fast** — startup validation now also covers REDIS_URL validity and dual-approval configuration (mode ALL/THRESHOLD; THRESHOLD requires a positive threshold; no disable configuration exists).
10. **API/worker configuration parity** — render.yaml wires the same payout policy env to API, worker and cron services; migrations run only via the API `preDeployCommand`.

## 3. Preserved v1.0.3 controls (regression-checked)

Auth + refresh rotation, roles/global guard chain, webhook signature verification, donation exactly-once ledger, reservation row-locking, destination masking, IDOR ownership checks, storage scan lifecycle, PWA/security headers — all retained and covered by the existing suites (195 backend unit tests green).

## 4. Residual risks

| Risk | Severity | Mitigation / status |
|---|---|---|
| prisma CLI → deepmerge-ts (GHSA-ggr8-5vv4-36mx) dev-chain advisory | HIGH (build tooling only) | Documented accepted (DEPENDENCY_SECURITY_REPORT §3); not in the runtime artifact; upgrade path prisma ≥ 7.11. |
| Sandbox without DB/Redis/provider credentials | — | Integration, migration-restore rehearsal and live provider verification are CI-wired or explicitly marked PENDING in the test report. |
| Historical approvals pre-dating v1.0.4 | LOW | Migration preserves rows; outstanding payouts require NEW approval records under the current cycle before settlement — no fabricated approvals. |
| MFA enrollment UX (text secret, no QR) | LOW | Functional; QR rendering can be added UI-side without security impact. |

## 5. Classification

**SECURITY-HARDENED — DEPLOYMENT VERIFICATION PENDING**

Source-level P0/P1/P2 remediations are complete, the required automated tests pass in the environments available to this release, and CI enforces the full gate set. What remains is operator execution of the deployment-time checks listed in the test report (§3) — none of which can be truthfully claimed from an offline sandbox.
