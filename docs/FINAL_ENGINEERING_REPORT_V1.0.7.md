# KINDORA v1.0.7 — FINAL ENGINEERING REPORT

**Release:** KINDORA v1.0.7_SECURITY_COMPLETE — Provider Payout Execution & Verification Integrity
**Baseline:** KINDORA v1.0.6_SECURITY_COMPLETE
**Classification:** STAGING READY (see §24)
**Deployment status:** NOT DEPLOYED — no deployment was performed or authorized in this release cycle.

Honesty framing used throughout this report, per the master engineering prompt:

- **Implemented and verified** — code exists AND an automated check executed it successfully in this sandbox.
- **Tested using mocks** — jest unit suites with mocked Prisma/provider HTTP.
- **Tested using a real database** — userspace PostgreSQL 18 + Redis 7.2.5 (compiled from source in the sandbox).
- **Tested using a provider sandbox** — NOT DONE anywhere in this release (no credentials).
- **Not implemented / Blocked** — explicitly stated per feature.

---

## 1. Executive summary

v1.0.7 completes the payout execution lifecycle: real Paystack and Flutterwave transfer
initiation through dedicated provider adapters, durable intent-first initiation with a
transactional outbox, fail-closed verification of amount/currency/beneficiary, atomic
reconciliation of every provider outcome, strict four-identity executor separation enforced
before any provider call, fresh purpose-bound MFA on every sensitive payout operation, a
controlled manual-review workflow that can never manufacture a settlement, and honest
disabling of Stripe payouts.

All eight critical issues from the independent v1.0.6 review are closed. The verification
evidence is materially stronger than at code-freeze: the sandbox gained a real PostgreSQL 18
instance and a real Redis 7.2.5 server, so the previously NOT RUN migration and integration
verifications were executed — and the integration run found and fixed three real defects
(one of which would have made the fresh-MFA control unusable in production, another of which
prevented the API from booting).

## 2. v1.0.6 issues identified

| # | Issue (as reviewed in v1.0.6) | v1.0.7 resolution |
| --- | --- | --- |
| 1 | Payout attempts were registered locally; no real provider transfer initiation. | Paystack + Flutterwave payout adapters implement recipient/beneficiary resolution, transfer initiation, reference lookup, verification and status normalization per provider. |
| 2 | Cross-provider verification routing (Stripe payouts mapped onto the Paystack verifier). | Provider registry with explicit rejectors; STRIPE/PAYPAL payout requests fail with `PayoutProviderUnsupportedError`; `PAYOUT_SUPPORTED_PROVIDERS` gate + production startup validation. |
| 3 | Non-atomic reconciliation for pending/unknown/mismatch outcomes. | Single `PayoutReconciliationService.apply()` transaction routes EVERY outcome: row locks → approval-cycle validation → evidence → classification → guarded transitions → exactly-once ledger → audit. |
| 4 | Stale-approval race: approval response computed from pre-transaction reads. | Both approval steps `SELECT ... FOR UPDATE` the authoritative withdrawal (and the prior approval row) INSIDE the transaction and return the committed record; initiation re-validates under lock. |
| 5 | Approvals not bound to the destination; beneficiary verification compared a local JSON hash. | `destinationVersion` + `destinationVersionAtApproval` + `snapshotHash`; provider-native `PayoutBeneficiary` identity bound to the destination version; destination changes invalidate approvals + beneficiaries in one transaction. |
| 6 | Non-durable initiation: provider call without a committed intent; blind retry of ambiguous submissions. | `PayoutAttempt` + `PayoutOutbox` committed in ONE transaction BEFORE any provider call; ambiguity => `SUBMISSION_PENDING` + provider reference lookup; resubmission forbidden; crash recovery treats an existing provider identity as never-resubmit. |
| 7 | Fail-open settlement inputs (missing provider amount/currency/beneficiary interpreted as match); webhooks could act as settlement sources. | Webhooks only TRIGGER verification (fresh provider API fetch); missing mandatory evidence => `PROVIDER_DATA_INCOMPLETE` => fail closed => manual review. |
| 8 | Executor separation enforced only at finalization (too late). | Full separation matrix enforced BEFORE initiation and re-validated inside the intent transaction under row lock; fresh MFA required for approve/second-approve/execute/retry/manual paths. |

## 3. Root causes

1. **Missing adapter layer** — v1.0.6 had donation-side provider services only; payout
   transfer APIs were never modeled, so execution stalled at "attempt registered".
2. **Transaction-scope confusion** — external I/O was performed inside or adjacent to DB
   transactions, so ambiguous outcomes left partial state; the fix separates durable intent
   (committed locally) from side-effectful submission (outbox worker, post-commit).
3. **Identity conflation** — local identifiers (destination JSON hash, idempotency key,
   attempt id) were compared against provider-native identifiers (recipient codes, transfer
   ids). v1.0.7 models them as distinct columns and never substitutes one for another.
4. **Guard placement** — the fresh-MFA guard ran at the controller edge and the separation
   matrix only in finalization; v1.0.7 enforces separation in the initiation path itself.
5. **Verification asymmetry** — success paths were verified while pending/unknown paths
   updated state piecemeal; centralized reconciliation removes the asymmetry.

## 4. Files modified (high level)

- `backend/src/payouts/` — payout.service, payout-initiation.service, payout-verification.service, payout-reconciliation.service, payout-beneficiary.service, manual-review.service, payout-state-machine.ts, payout-provider.adapter.ts, payout-provider.registry.ts, payout-outbox.sweeper.ts, payouts.module.ts.
- `backend/src/payouts/adapters/` — paystack-payout.adapter.ts, flutterwave-payout.adapter.ts, stripe-payout.adapter.ts (rejector), mock-payout.adapter.ts.
- `backend/src/withdrawals/` — withdrawals.service.ts (approvals, second-approval, destination endpoint, settle, execute separation), withdrawals.controller.ts (MFA guards, execute route).
- `backend/src/internal/internal-payouts.module.ts` — worker ingest surface (FIXED this cycle: missing `PayoutsModule` import made the API un-bootable).
- `backend/src/donations/donations.module.ts` — webhooks module wiring (FIXED this cycle).
- `backend/src/mfa/mfa.service.ts` — **FIXED this cycle**: TOTP verification now uses base32-DECODED key bytes (RFC 6238) for confirm + challenge.
- `backend/src/payments/webhooks.controller.ts` — transfer.* events trigger verification only.
- `backend/src/app.module.ts` — startup validation of `PAYOUT_SUPPORTED_PROVIDERS`.
- `frontend/src/lib/*`, `frontend/src/components/*` — payout attempt state badges, settlement-blocked banner, manual-review hooks, Stripe payout unavailability note.
- `workers/src/` — payouts queue processor, payout-recovery cron producer.
- Test specs — five payout suites, withdrawals/money-path e2e updated to the v1.0.7 contract.

## 5. New files created

- Adapters: `payouts/adapters/{paystack,flutterwave,stripe,mock}-payout.adapter.ts`
- Pipeline: `payout-initiation.service.ts`, `payout-verification.service.ts`, `payout-reconciliation.service.ts`, `payout-beneficiary.service.ts`, `payout-outbox.sweeper.ts`
- Manual review: `manual-review.service.ts`
- Internal surface: `internal/internal-payouts.module.ts`
- Migration: `prisma/migrations/0004_payout_execution_integrity/migration.sql`
- Workers: payouts processor + `cron:payout-recovery`
- Verification harnesses (committed for reproducibility): `scripts/verify_migration_0004.js`, `scripts/verify_schema_match.sh`, `scripts/run_integration_tests.sh`
- Docs: PAYOUT_ARCHITECTURE_V1.0.7.md, PROVIDER_INTEGRATION_V1.0.7.md, MANUAL_REVIEW_PROCEDURES_V1.0.7.md, KINDORA_v1.0.7_RELEASE_NOTES.md, KINDORA_v1.0.7_TEST_REPORT.md, this report.

## 6. Database schema changes

New tables: `PayoutAttempt`, `PayoutOutbox`, `PayoutBeneficiary`, `PayoutVerificationEvidence`, `PayoutReconciliation`, `ManualReviewCase`.
Extended: `Withdrawal` (+ `approvalCycle`, `destinationVersion`, reconciliation columns), `WithdrawalApproval` (+ cycle, `amountAtApproval`, `currencyAtApproval`, `destinationVersionAtApproval`, `snapshotHash`).
Enums extended: `PayoutAttemptStatus` (INITIATED, SUBMISSION_PENDING, PROVIDER_ACCEPTED, PENDING, SUCCESSFUL, FAILED, UNKNOWN, REVERSED, MANUAL_REVIEW), `WithdrawalStatus` (+ REQUIRES_RECONCILIATION, REVERSED), `ReconciliationResult` (15 classifications), `PayoutOutboxStatus` (PENDING, IN_FLIGHT, SUBMITTED, FAILED_PERMANENT, EXHAUSTED).

## 7. Migrations added

`0004_payout_execution_integrity` — additive only; never rewrites financial rows; unique
constraints on (provider, providerTransferRef), `idempotencyKey`, `requestFingerprint`,
outbox identity, beneficiary-per-destination-version; immutability triggers on
`PayoutReconciliation`/`PayoutVerificationEvidence` and delete-protection on payout/approval
history. **Verified on real PostgreSQL 18**: fresh chain AND upgrade from v1.0.6-era data
(34/34 checks) plus `prisma migrate diff` = "No difference detected".

## 8. Paystack implementation details

- Recipient create/lookup: `POST /transferrecipient` (documented fields: type BANK,
  name, account_number, bank_code, currency) — `recipient_code` persisted as the
  provider-native beneficiary identity.
- Initiation: `POST /transfer` with `source: "balance"`, amount in MINOR units (kobo),
  sanitized deterministic reference `kdo-<attemptNo>-<hash>` (>= 16 chars per provider
  constraint), recipient = the persisted recipient code.
- Verification: `GET /transfer/:id_or_code` — amount (minor), currency, `recipient_code`
  and `transfer_code`/`id` used as separate evidence fields; statuses op/success, pending,
  failed, reversed, abandoned map to internal classifications; unknown statuses map to
  UNKNOWN (never FAILED).
- Ambiguous transport errors (timeout/5xx) map to `PayoutTransportError` => SUBMISSION_PENDING
  => reference lookup (`GET /transfer?reference=` path through the registry) => no blind retry.
- Tests: 9 adapter unit tests + integration-path coverage. **Real sandbox: NOT RUN (no key).**

## 9. Flutterwave implementation details

- Beneficiary resolution: `POST /v3/accounts/resolve` — a bank fingerprint is derived from
  the resolved bank code + account number and persisted as the beneficiary identity.
- Initiation: `POST /v3/transfers` with INLINE beneficiary body (bank transfer:
  account_bank, account_number, amount in MAJOR units, currency, narration, reference
  `kdo-...`); mobile-money initiation posts the mobile number + network, never bank fields.
- Verification: `GET /v3/transfers/:id` and reference query `GET /v3/transfers?reference=`;
  MAJOR-unit provider amount converted to minor EXACTLY (2-decimal currencies) before
  integer comparison; beneficiary fingerprint re-derived from the transfer's own fields.
- Statuses: successful, pending, failed, reversed map per provider semantics; unknown =>
  UNKNOWN. Rejections map to `PayoutProviderRejectedError`; transport errors to
  `PayoutTransportError`.
- Tests: 7 adapter unit tests + integration-path coverage. **Real sandbox: NOT RUN (no key).**

## 10. Stripe payout availability

DISABLED for payouts (preferred release-safe option from the master prompt): the registry
rejects STRIPE (and PAYPAL) payout initiation/verification with an explicit
`PayoutProviderUnsupportedError`; no routing through Paystack/Flutterwave; production
startup refuses to boot if `PAYOUT_SUPPORTED_PROVIDERS` names an unimplemented provider;
the admin UI marks Stripe payouts unavailable. Stripe DONATIONS remain supported unchanged.

## 11. Idempotency and duplicate prevention

- Identifier taxonomy enforced in code and schema: internal attempt id, internal
  `idempotencyKey` (unique), `requestFingerprint` (unique, SHA-256 of the canonical
  request), provider transfer reference (unique), provider transfer id (indexed), provider
  recipient/beneficiary id (per destination version). None are substituted for another.
- Intent-first: attempt + outbox commit in one transaction BEFORE any external call; the
  outbox row is claimed with durable conditional updates (`IN_FLIGHT` + `claimedBy`), so a
  duplicate queue message or worker restart cannot produce a second submission.
- Ambiguity policy: timeout/5xx/lost response => `SUBMISSION_PENDING`; resubmission
  forbidden while a provider identity may exist; provider lookup recovers the reference;
  unresolved ambiguity escalates to MANUAL_REVIEW after `PAYOUT_UNKNOWN_ESCALATION_MINUTES`.
- Settlement exactly-once: unique ledger reference `withdrawal:<id>` (P2002 conflict =>
  409, proven by e2e replay test), reconciliation rows immutable at the DB level.
- DB-level proof: duplicate requestFingerprint / idempotencyKey / outbox events rejected by
  unique constraints on the real PostgreSQL instance (migration harness checks).

## 12. Beneficiary verification implementation

`PayoutBeneficiary` rows are derived from validated destination data, bound to
`destinationVersion` + approval cycle, persisted hashed (never raw account numbers), and
carry the provider-native identity (`recipient_code` for Paystack; bank fingerprint for
Flutterwave). Verification compares the provider's OWN beneficiary evidence against the
bound identity — never against the local destination hash. If provider evidence is missing
or cannot positively establish the beneficiary, settlement fails closed
(`PROVIDER_DATA_INCOMPLETE` / `DESTINATION_MISMATCH`) and a manual review case opens.
Any destination change bumps `destinationVersion`, retires beneficiaries, invalidates
ACTIVE approvals and requires a fresh approval cycle (a previous recipient is never reused).

## 13. Atomic reconciliation implementation

`PayoutReconciliationService.apply()` runs EVERY outcome (success, pending, unknown,
failed, reversed, all mismatch classes) through ONE transaction:
row-lock withdrawal + attempt (`SELECT ... FOR UPDATE`) → validate attempt↔withdrawal
relationship → validate the ACTIVE approval cycle (amount/currency/destinationVersion/
snapshotHash) → persist evidence + reconciliation row → guarded conditional status
transitions → exactly-once ledger posting → audit event. Any step failing rolls back the
ENTIRE transaction (proven by the atomicity unit suite and by real-DB `FOR UPDATE NOWAIT`
serialization checks). Pending keeps PROCESSING + reservation; unknown keeps the
reservation, blocks new initiation and escalates on the configured window; reversal is
recorded separately with an audit + review case; only verified success settles.

## 14. Executor separation and MFA

- Separation matrix (backend-only, enforced BEFORE any provider call and re-validated
  inside the intent transaction): requester ≠ first approver ≠ second approver; executor ≠
  requester, ≠ first approver, ≠ second approver. Four distinct identities for every
  API-verified payout (proven by e2e tests including the first-approver-execution rejection).
- Approval snapshots: amount/currency/destinationVersion/snapshotHash bound at approval
  time; any material change invalidates the cycle (409 "the approval cycle must be
  restarted").
- Fresh MFA: single-use, 120s TTL, purpose- and scope-bound challenges (Redis-backed,
  fail-closed 503 when Redis is unavailable) for first approval, second approval,
  execution, retry, manual settlement/resolution, beneficiary change. **This cycle FIXED a
  real defect:** TOTP was verified against the base32 text instead of the decoded key
  bytes, which would have made authenticator enrollment impossible; verified now end-to-end
  through real enroll → confirm → challenge → consume flows on real Redis.

## 15. Worker and recovery implementation

BullMQ `payouts` queue with thin trigger handlers POSTing to token-gated internal endpoints
(`x-worker-token`, constant-time compare, fail-closed 503 without `WORKER_INGEST_TOKEN`);
all financial state mutations stay inside the backend. In-process outbox sweeper
(`PAYOUT_OUTBOX_SWEEP_SECONDS`, default 30) is the floor for deployments without workers;
`cron:payout-recovery` (Redis lock) drives escalation + verification on worker deployments.
Bounded retries with exponential backoff + jitter; permanent validation errors are never
retried; exhausted jobs land in `FAILED_PERMANENT`/`EXHAUSTED` for manual investigation.
All workers are idempotent and restart-safe (durable DB claims, not queue-level uniqueness).

## 16. Security improvements

Helmet + CORS allowlist unchanged; raw-body webhook signature verification for both
providers; webhook events persisted + deduplicated; transfer webhooks trigger verification
only (never settle); production fail-closed configuration validation (missing provider keys
for enabled providers refuses boot; mock providers never silently activated in production);
structured redacted logging (no account numbers, keys, headers or MFA secrets); DB-level
immutability triggers protect financial history; TOTP key-encoding defect fixed (§14);
module DI defects fixed that would have prevented the internal worker surface from
functioning.

## 17. Tests executed

| Suite | Count | Environment |
| --- | --- | --- |
| Backend unit (16 suites, incl. 5 payout suites) | 255 | jest, mocked Prisma/providers |
| Frontend unit | 52 | vitest |
| Migration verification (fresh + v1.0.6 upgrade paths) | 34 checks | real PostgreSQL 18 |
| `prisma migrate diff` structural check | 1 | real shadow database |
| Backend integration (auth, webhooks, storage, money-path, withdrawals) | 47 | real PostgreSQL 18 + Redis 7.2.5 |
| Typechecks (backend/workers/frontend) + builds (nest, vite, workers) | 7 checks | sandbox |

## 18. Tests passed

All of Section 17 passes: 255 + 52 + 34 + 1 + 47 + 7 = 396 executed checks, 0 failures in
the final state. Re-run clean after every defect fix in §5 of the test report.

## 19. Tests failed

None in the final state. During verification the following failed and were FIXED (see test
report §5): InternalPayoutsModule DI boot failure (47→0 failing e2e specs), DonationsModule
webhook DI failure, MFA TOTP key-encoding defect (real-authenticator codes rejected),
plus obsolete v1.0.6-era e2e expectations updated to the stricter v1.0.7 contract
(MFA-first self-approval probe; fourth-identity executor).

## 20. Tests blocked or not run

- **Paystack sandbox execution — BLOCKED** (no `PAYSTACK_SECRET_KEY`).
- **Flutterwave sandbox execution — BLOCKED** (no `FLUTTERWAVE_SECRET_KEY`).
- Frontend Playwright e2e — NOT RUN (no browser/deployed-frontend infrastructure).
- Multi-instance outbox concurrency on deployed infrastructure — NOT RUN.
- Signed transfer webhooks against live provider signatures — NOT RUN.

## 21. Actual provider sandbox results

NONE. No provider credentials existed in the sandbox; no sandbox transfer was initiated;
no provider transfer ID or reference was observed. Nothing is claimed, implied or
fabricated. The adapters' field-level correctness against the live APIs is UNVERIFIED until
the operator runs the sandbox procedure in PROVIDER_INTEGRATION_V1.0.7.md with test keys.

## 22. Deployment readiness

- Deployment targets unchanged: frontend → Netlify, API → Render, workers → Render worker,
  PostgreSQL, Redis-compatible service.
- Migration instructions (rehearse 0004 on a restored copy, then `prisma migrate deploy`
  0001→0004) in the release notes §4; operator checklist (new env vars, worker token,
  cron, webhook registration, MFA purposes) in release notes §6.
- NOT DEPLOYED. No production or staging deployment was performed in this cycle.

## 23. Known limitations

1. Provider sandbox validation outstanding (the only blocker between STAGING READY and
   PRODUCTION CANDIDATE).
2. Multi-instance outbox-claim behavior verified at DB/lock level but not under multi-replica
   staging traffic.
3. Worker-driven payouts require `WORKER_INGEST_TOKEN` on both API and worker; without it,
   sweeper-paced recovery still works, just slower.
4. `PAYOUT_OUTBOX_SWEEP_SECONDS < 5` disables the sweeper — keep the default 30.
5. `PAYOUT_UNKNOWN_ESCALATION_MINUTES` too low escalates normal provider latency — keep 120
   until provider latency is measured.
6. Manual review can never settle automatically by design; operators must run the
   documented runbook for unresolved cases.

## 24. Final release classification

**STAGING READY.**

Rationale: every P0 financial-safety criterion that can be verified without provider
credentials is implemented AND verified (real-database integration suite, DB-level
constraint/trigger/lock checks, unit suites); three real defects found by that verification
were fixed and re-verified. PRODUCTION CANDIDATE requires provider sandbox initiation +
verification (§20-21) and a multi-instance staging observation — documented as the operator
checklist. The classification is not lowered and not inflated.

## 25. Backup and checksum verification

- v1.0.6 baseline backup `KINDORA_v1.0.6_SECURITY_COMPLETE_BASELINE.tar.gz` is included in
  the release archive; its SHA-256 **matches** the recorded manifest
  (`v1.0.6_baseline.sha256`, verified during packaging AND after fresh extraction).
- `KINDORA_v1.0.4_SECURITY_COMPLETE.zip` (previous release backup) is included.
- Complete `SHA256SUMS.txt` manifest (375 entries) covers the entire archive content;
  verified byte-for-byte after a fresh extraction to a clean directory.
- The archive was verified: `unzip -t` clean (1,555 entries), fresh extraction, expected
  files present, checksums verified, no private keys / credential-length secrets / .env
  files packaged, payout source restorable.
- Exact archive identity (filename, size, SHA-256, integrity status) is printed by the
  packaging/verification scripts and reported in the final delivery summary.
