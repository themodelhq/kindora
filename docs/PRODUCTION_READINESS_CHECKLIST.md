# PRODUCTION READINESS CHECKLIST — KINDORA v1.0.4

Legend: `[x]` verified in this release · `[ ]` pending — requires live operator action. Nothing below is checked without evidence.

---

## Payout security

- [x] No legacy payout-state manipulation endpoint remains (`mark-paid`/`mark-failed`/`mark-processing` → 404; service methods deleted; source sweep clean)
- [x] All payout transitions go through the canonical service (`PayoutService` + `assertTransition`; conditional updates)
- [x] Administrators cannot force-fail ambiguous transfers (only authoritative verification reaches `PROCESSING → FAILED`)
- [x] Pending/unknown transfers cannot be retried (`PayoutService.retry` guards + tests)
- [x] Original transfer references retained (`PayoutAttempt.providerTransferRef`, unique)
- [x] Retry requires authoritative failure confirmation
- [x] Duplicate provider requests cannot cause duplicate transfers (unique idempotency keys)
- [x] Duplicate webhooks cannot duplicate settlements (v1.0.3 dedupe retained; suites green)
- [x] Duplicate ledger entries prevented (unique `withdrawal:<id>`; P2002 → 409)
- [x] Reservations remain intact until a safe outcome is established (`REQUIRES_RECONCILIATION` is reserving)

## Dual approval

- [x] First and second approvers are different people (enforced pre-state-gate; loophole regression test)
- [x] Requester cannot approve their own payout (service-level)
- [x] Second approver cannot execute the payout (settlement check + tests)
- [x] Immutable approval history exists (`WithdrawalApproval`, invalidation preserves rows)
- [x] Approval is bound to the amount and currency (snapshots + change invalidation tests)
- [x] Concurrent approval cannot bypass restrictions (conditional updateMany; 409 loser)
- [x] The UNDER_REVIEW exception is removed (v1.0.3 scenario reproduced and rejected)
- [x] All separation rules enforced server-side (service layer, not guards-only)

## MFA

- [x] First approval requires fresh MFA (`PAYOUT_FIRST_APPROVAL`)
- [x] Second approval requires fresh MFA (`PAYOUT_SECOND_APPROVAL`)
- [x] Manual payout confirmation requires fresh MFA (`PAYOUT_SETTLEMENT`)
- [x] Retry authorization requires fresh MFA (`PAYOUT_RETRY`)
- [x] Payout execution requires fresh MFA (settlement IS the execution path)
- [x] Financial reconciliation requires fresh MFA (`PAYOUT_RECONCILIATION` on verify/reconcile/run)
- [x] Refunds require fresh MFA (`REFUND_EXECUTION`)
- [x] MFA challenges remain single-use (atomic GETDEL + tests)
- [x] Step-up authorization is purpose-bound (mismatch tests)
- [x] Redis unavailability fails closed (503; no fallback path)

## Dependencies and infrastructure

- [x] High-severity production advisories resolved or explicitly documented and accepted (`scripts/audit-gate.mjs` ↔ `docs/DEPENDENCY_SECURITY_REPORT.md` §3)
- [x] Nodemailer updated (10.5.0) and compile/test verified
- [x] Zod updated (4.6.7) with the error-map migration; 52 frontend tests pass
- [x] Sharp/libvips updated (0.35.5) with a REAL image-processing test (CI + local)
- [x] Redis URL validation is strict (17-case suite; backend startup + runtime + workers)
- [x] Redis failure cannot silently weaken financial security (MFA fail-closed)
- [x] Render configuration is consistent across API and workers (same payout policy env)
- [x] Migrations run in exactly one place (API preDeployCommand)

## Manual evidence

- [x] Arbitrary external evidence URLs are rejected (no such field; 400 on legacy body)
- [x] Evidence must reference authorized stored files (8-check validation)
- [x] Evidence is associated with the correct withdrawal (binding + unique constraint)
- [x] Quarantined/rejected/unscanned files cannot be used
- [x] Evidence access is private and authorized (signed URL route + audit)
- [x] Evidence history is auditable (immutable StoredFile rows + audit log)

## Release integrity

- [x] Backups verified (3 archives, `unzip -t` + SHA-256)
- [x] Database migration verified (additive SQL generated from the pristine v1.0.3 schema; `prisma validate` passes)
- [ ] Migration rehearsed against a restored v1.0.3 database (operator; requires DB)
- [x] Backend unit tests passed (195/195)
- [x] Frontend tests passed (52/52)
- [x] Worker build + real image pipeline passed
- [x] Financial regression tests passed (state machine, approvals, MFA, redis, evidence suites)
- [x] Security tests passed
- [x] Builds passed (backend `nest build`, frontend `vite build` PWA, workers `tsc`)
- [x] Checksum manifest included (generated after packaging; verified with `sha256sum -c`)
- [x] ZIP integrity passed (independent `unzip -t` + checksum verification)
- [x] Documentation matches the actual source (docs grounded in code review; see audit §2)
- [ ] CI run on GitHub Actions green (push the release tag; the workflow is committed)
- [ ] Deployment status independently verified (PENDING — see below)

## Deployment verification (PENDING operator actions)

- [ ] Render API deploy: `/api/v1/health` 200, `/health/database` 200, `/health/redis` 200
- [ ] Render worker start + queue consumption; cron jobs fire
- [ ] Migration 0003 applied on production PostgreSQL (`prisma migrate deploy` logs clean)
- [ ] Redis fail-closed drill: stop Redis → payout approval attempts return 503 → restore
- [ ] Paystack/Flutterwave sandbox connectivity + a read-only `verifyTransfer` round-trip
- [ ] SMTP: password reset + MFA recovery emails delivered
- [ ] S3-compatible storage: evidence upload → scan → signed read URL
- [ ] Netlify frontend deploy; CORS_ORIGINS matches the production domain; PWA installs
- [ ] All administrators enrolled in MFA before the first payout approval

## Final classification

**SECURITY-HARDENED — DEPLOYMENT VERIFICATION PENDING**

Every source-level control and every test executable in this environment has passed and is documented. The unchecked boxes above are exclusively live-infrastructure verifications that cannot be truthfully claimed from an offline release environment. Do NOT flip the classification to PRODUCTION-READY until they are executed and recorded.
