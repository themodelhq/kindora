# KINDORA v1.0.8 — Final Engineering Report

**Release:** KINDORA v1.0.8_SECURITY_COMPLETE
**Baseline:** KINDORA v1.0.7_SECURITY_COMPLETE (verified: internal manifest 379/379 checksums after independent extraction; SHA-256 recorded in BACKUP_MANIFEST_V1.0.8)
**Date:** 2026-11-14
**Mandate:** eliminate the two P0 payout-security vulnerabilities and the P1 reliability defects identified by the independent review — without rebuilding the platform, removing working functionality, weakening any security control, or modifying tests to force a pass.

---

## 1. Executive summary

v1.0.8 closes both P0 financial-security vulnerabilities found in v1.0.7 and all five P1 defects, verified by 315 unit tests and 53 integration tests executed against a REAL PostgreSQL 17 server and a REAL Redis 7.2.5 server. The manual-settlement provider bypass is structurally impossible (closed server-side allowlist at three layers + a distinct reconciliation classification), approval-cycle validity is a hard gate on every settleable outcome, outbox recovery reclaims crashed workers' events safely without any duplicate-transfer risk, all floating-point money conversions are gone, reversals have an accurate lifecycle, and definite rejections are atomic. The release is packaged with a verified backup of v1.0.7, complete checksum manifests and honest documentation of what was and was not externally verified.

## 2. v1.0.7 findings addressed

| # | Finding | Priority | Status |
| --- | --- | --- | --- |
| F1 | `PayoutService.isManualProvider()` never called by `settleManual()`; free-text provider DTO; manual settlement could record a payout naming `PAYSTACK_TRANSFER` with a fabricated `MATCHED` reconciliation | P0 | FIXED (§7 of this report) |
| F2 | `approvalCycleValid` computed but only stored in metadata; settlement never gated on the current approval cycle | P0 | FIXED (§8) |
| F3 | Outbox sweep finds IN_FLIGHT rows but the claim only takes PENDING — crashed workers leave events permanently stuck | P1 | FIXED (§9) |
| F4 | Flutterwave mobile-money verification constructed bank-field identities only; MM payouts could be initiated but never reconciled | P1 | FIXED + channel DISABLED by default (§10) |
| F5 | Floating-point amount conversion (`Number(minor)/10^d`, `Math.round(amount*10^d)`) | P1 | FIXED (§11) |
| F6 | `reversed`/`reverse_initiated`/`reversing` all classified terminal REVERSED | P1 | FIXED (§12) |
| F7 | `applyDefiniteRejection()` committed inconsistent state on zero-row withdrawal update | P1 | FIXED (§13) |
| F8 | (found during verification) BullMQ rejected `verify:<id>` jobIds containing `:` — verification dispatch silently degraded to the sweeper | P1 | FIXED |

## 3. Root causes

- **F1/F2** — validation existed as helpers/metadata but was not wired into the authoritative transaction path: a recognition regex (never called) and an informational boolean (never enforced). v1.0.8 replaces recognition with an explicit allowlist and metadata with a hard in-transaction gate.
- **F3** — claim semantics covered only the PENDING state while the sweep searched two states: a claim crash had no path back. v1.0.8 adds explicit leases with atomic reclaim + provider-reference resolution before resubmission.
- **F4** — identity construction differed between resolution (local `mobileLast4` tuple) and verification (bank fields): MM transfers could never produce comparable provider evidence. v1.0.8 derives both sides from provider-visible fields with a method-specific candidate, and disables the channel until sandbox-proven.
- **F5** — JS `Number` used as the interchange format for money. v1.0.8 makes exact decimal strings the interchange format end to end.
- **F6** — provider statuses were normalized into a closed set without distinguishing reversal stages. v1.0.8 adds a provider-specific reversal-lifecycle mapping and a forward-only internal lifecycle.
- **F7** — an unexpected conditional-update outcome was treated as loggable rather than exceptional. v1.0.8 treats zero-row application as a transaction-abort error.
- **F8** — BullMQ custom jobId character restrictions were not accounted for.

## 4. Files modified

Backend (`kindora-v108/kindora/backend`):

- `prisma/schema.prisma` — new enums/columns (§6)
- `prisma/migrations/0005_payout_authorization_lockdown/migration.sql` — NEW forward-only migration
- `src/payouts/payout.service.ts` — `settleManual()` rewritten (allowlist, locked cycle validation, in-tx evidence, distinct classification); `isManualProvider()` strict; `retry()` manual-channel normalization
- `src/payouts/payout-initiation.service.ts` — lease claim + safe stale recovery; full cycle validation at submission; atomic `applyDefiniteRejection`; BullMQ-safe jobIds
- `src/payouts/payout-reconciliation.service.ts` — mandatory cycle gate on settlement; `PROVIDER_REVERSAL_IN_PROGRESS` branch; terminal reversal with exactly-once accounting correction
- `src/payouts/payout-state-machine.ts` — `REVERSAL_IN_PROGRESS` classification, provider-specific reversal mapping, `assertReversalTransition`, new outcomes
- `src/payouts/payout-verification.service.ts` — method-specific beneficiary-candidate selection
- `src/payouts/adapters/flutterwave-payout.adapter.ts` — MM verification path + kill-switch + exact amounts (raw tokens)
- `src/payouts/adapters/paystack-payout.adapter.ts` — exact integer raw-token amounts, exact response parsing, safe-range guards
- `src/payouts/payout-provider.adapter.ts` — `beneficiaryRefCandidates` on transfer details
- `src/payouts/manual-settlement-channels.ts` — NEW allowlist module
- `src/payouts/payout-approval-cycle.service.ts` — NEW validator
- `src/payouts/payout-evidence.service.ts` — NEW evidence validator
- `src/payouts/payouts.module.ts` — new providers/exports
- `src/withdrawals/withdrawals.service.ts` — evidence validation delegated to the canonical service
- `src/withdrawals/dto/withdrawal.dto.ts` — `@IsIn(MANUAL_SETTLEMENT_CHANNELS)`
- `src/common/utils/exact-money.ts` — NEW exact conversion utilities
- `src/common/config/configuration.ts` — `payouts.leaseMinutes`, `payouts.flwMobileMoneyEnabled`
- `src/ledger/ledger.service.ts` — `postWithdrawalReversal` (exactly-once correction)
- `.env.example` — new variables

Frontend (`kindora-v108/kindora/frontend`):

- `src/lib/withdrawal-form.ts` — settlement channel select reduced to the allowlisted manual channels; API providers explicitly rejected with an explanatory message; legacy labels kept read-side only
- `src/pages/admin/withdrawals.tsx` — single source for provider labels
- `src/lib/status.ts` — `REVERSAL_IN_PROGRESS` badge ("Reversal in progress", warning) distinct from "Reversed (completed)"

Workers: no logic changes required (the outbox pipeline in the API owns submission; worker builds pass).

## 5. New files created

See §4 "NEW" markers, plus tests: `manual-settlement-channels.spec.ts`, `exact-money.spec.ts`, `payout-approval-cycle.service.spec.ts`, `payout-lockdown.e2e-spec.ts`, and the documentation set (PAYOUT_ARCHITECTURE_V1.0.8.md, MANUAL_SETTLEMENT_PROCEDURES_V1.0.8.md, OUTBOX_RECOVERY_V1.0.8.md, REVERSAL_HANDLING_V1.0.8.md, PROVIDER_INTEGRATION_V1.0.8.md, KINDORA_v1.0.8_TEST_REPORT.md, KINDORA_v1.0.8_RELEASE_NOTES.md, ENVIRONMENT_VARIABLES.md addendum, this report).

## 6. Database migrations

`0005_payout_authorization_lockdown` — forward-only, additive:

- `CREATE TYPE "ManualSettlementChannel"` (`MANUAL_BANK_TRANSFER`, `CASH`, `APPROVED_OFFLINE_CHANNEL`)
- `CREATE TYPE "PayoutReversalState"` (8 values)
- `ALTER TYPE "ReconciliationResult" ADD VALUE 'PROVIDER_REVERSAL_IN_PROGRESS' / 'MANUAL_EVIDENCE_RECORDED'`
- `ALTER TYPE "LedgerTxnType" ADD VALUE 'WITHDRAWAL_REVERSAL'`
- `PayoutAttempt`: `manualChannel`, `reversalState`, `reversalObservedAt`
- `PayoutOutbox`: `leaseExpiresAt`, `recoveryAttempts` (default 0), `lastRecoveryAt` + index `(status, leaseExpiresAt)`

Verified on real PostgreSQL 17.11: fresh deploy (0001→0005) applied with `prisma migrate diff` EMPTY against the schema; upgrade path (0001→0004, then 0005) applied with schema-diff EMPTY. No historical migration modified; historical rows untouched (new columns NULL, enums additive).

## 7. Manual settlement security implementation

- Allowlist module (`manual-settlement-channels.ts`) — three channels; explicit API-provider rejections; legacy alias for read-side continuity only; case-insensitive acceptance of allowlisted values only.
- Enforcement: DTO `@IsIn` (400 before controller body), fresh purpose-bound MFA at the controller, `assertManualSettlementChannel` in the service (mandatory even for direct service invocation), enum-typed `manualChannel` column.
- `settleManual()` transaction: withdrawal row lock → state check → full approval-cycle validation (executor = the acting admin; four-person separation enforced without exceptions) → evidence re-validation (`PayoutEvidenceService`) inside the lock → approved amount/currency asserted → conditional PAID transition → attempt with `manualChannel` → reconciliation row `MANUAL_EVIDENCE_RECORDED` with the authorization snapshot (channel, evidence id, cycle id, snapshot hash, requester/first/second/executor ids) → exactly-once ledger posting → immutable audit `WITHDRAWAL_PAID_MANUAL_SETTLEMENT`. Any failure rolls back everything.

## 8. Approval-cycle enforcement implementation

`PayoutApprovalCycleService.validate()` (§4.2 structured result: cycle id, approved amount/currency/destinationVersion, provider, beneficiaryRef, requester, first/second approver, executor, snapshot hash, invalidation reason) is invoked:

1. `PayoutInitiationService.initiate()` — full matrix inside the intent transaction (executor separation included) BEFORE the intent commits;
2. `PayoutInitiationService.submitOutbox()` — inside the pre-submission state re-validation (locks held);
3. `PayoutReconciliationService.apply()` — inside the reconciliation transaction; a settleable outcome with an invalid cycle is blocked (`INTERNAL_STATE_MISMATCH`, attempt → MANUAL_REVIEW, withdrawal → REQUIRES_RECONCILIATION when PROCESSING, audit `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE`) — provider verification can NEVER replace internal authorization;
4. `PayoutService.settleManual()` — inside the settlement transaction.

Invalidation behavior: destination changes bump `destinationVersion` and invalidate the cycle + beneficiaries (v1.0.7 §5.4 preserved); any amount/currency/destination-version/provider/beneficiary mismatch invalidates the validation result on every re-check, so an invalidated cycle can never be reused without fresh approvals.

## 9. Outbox recovery implementation

Lease-based claims (atomic conditional updates, worker identity recorded, `PAYOUT_OUTBOX_LEASE_MINUTES`), stale-reclaim counters for audit, and the SAFE recovery gate: before ANY submission of a reclaimed (or previously claimed) event, the deterministic submission reference is resolved against the provider — found ⇒ adopt; not-found ⇒ safe to submit; lookup transport failure ⇒ release with backoff. Provider identity persisted on the attempt ⇒ never resubmit. All eight §12.3 scenarios are covered (unit + the two real-DB lease scenarios).

## 10. Flutterwave mobile-money support status

- Verification path IMPLEMENTED (provider-authoritative `flw-mm:` identity recomputed from the transfer's own fields; method-specific candidate selection; never interchangeable with bank identifiers).
- Channel DISABLED by default (`PAYOUT_FLW_MOBILE_MONEY_ENABLED=false`): initiation and beneficiary resolution for MOBILE_MONEY fail closed with an explicit explanation until the sandbox verification suite passes. Bank payouts, donations and all other payment functionality are unaffected.
- Classification: **implemented but NOT independently verified against a live sandbox** (no credentials) — the channel remains closed in this release.

## 11. Monetary precision changes

Exact BigInt/string arithmetic only: `minorToExactDecimalString` (transmission), `exactDecimalStringToMinor` (raw response tokens; over-precision rejected), `extractJsonNumberToken` + cross-check against the parsed value, `jsonStringifyWithRawNumber` (raw JSON numeric tokens — no float at any magnitude), `assertNumberRoundTrips` (strict safe-range for any Number path), `MAX_TRANSMITTABLE_MINOR` ceiling. Tests cover zero-decimal, 2-decimal, maximum and beyond-2^53 values. The three-decimal-precision rejection case is tested (fail closed, never round).

## 12. Reversal state-machine changes

`REVERSAL_IN_PROGRESS` classification; provider-specific mappings (`reversalStateFor`); forward-only `assertReversalTransition` (COMPLETED/REJECTED terminal; regression rejected); in-progress reversals keep the attempt unresolved + reservation intact + immediate manual-review escalation; terminal reversals require authoritative evidence and post the exactly-once `withdrawal-reversal:<id>` accounting correction (`LedgerTxnType.WITHDRAWAL_REVERSAL`) without erasing original transfer history.

## 13. Transaction integrity improvements

- Definite rejection: attempt↔withdrawal association + requestFingerprint association confirmed under lock BEFORE any write; zero-row conditional update ABORTS the transaction (attempt, outbox and audit roll back together).
- Manual settlement: single transaction with row lock + in-tx cycle/evidence validation (§7).
- Reconciliation: cycle gate inside the locked transaction (§8); all outcome branches remain atomic.
- Pre-existing v1.0.7 atomicity (locked reconciliation, conditional transitions, unique ledger reference) preserved.

## 14. Security and authorization changes

- Four-person separation (requester, first approver, second approver, executor) enforced without exceptions in initiation, submission, reconciliation and manual settlement.
- Fresh purpose-bound MFA preserved on every admin payout route (unchanged).
- Evidence reuse prevented by the unique `evidenceForWithdrawalId` binding; fabricated file references and cross-withdrawal evidence rejected in-transaction.
- Audit history immutable (existing DB triggers preserved); new audit actions carry full authorization context without secrets or full beneficiary PII.
- Logging redactions preserved: no provider keys, no full account numbers, no MFA secrets, no tokens.

## 15. Tests actually executed

- Unit (jest, isolated): 19 suites, **315 tests executed, 315 passed, 0 failed** — including the three new v1.0.8 suites (allowlist matrix 11, exact money 14, approval-cycle 22) and the updated reconciliation-atomic suite (13 — including the four new v1.0.8 scenarios).
- Integration (REAL PostgreSQL 17.11 + REAL Redis 7.2.5, fresh database, `PROVIDER_MODE=mock`): 6 suites, **53 tests executed, 53 passed, 0 failed** — including the new payout-lockdown suite (6) covering the API-level allowlist bypass matrix, invalidated-cycle refusal, distinct manual classification, both stale-lease recovery scenarios, and the in-progress reversal lifecycle.
- Migration verification (REAL PostgreSQL): fresh deploy and upgrade-from-v1.0.7 deploy both applied with empty `prisma migrate diff`.
- Builds: backend `tsc`/`nest build`, frontend `tsc`/`vite build` (PWA), workers `tsc` — all pass.

## 16. Tests passed

See §15 — every listed number corresponds to an executed assertion run recorded in this build session.

## 17. Tests failed

None at release. During development the verification suite surfaced (and led to fixes for): the BullMQ jobId defect (F8), two e2e test-infrastructure issues on persistent databases (MFA enrollment persistence; legacy channel name in fixtures), and three spec updates required by legitimate behavior changes. No product defect was left failing.

## 18. Tests blocked

- **Provider sandbox tests — BLOCKED (no credentials).** Paystack and Flutterwave sandbox transfer initiation/verification were NOT executed; no sandbox evidence is claimed or manufactured. The Flutterwave mobile-money payout channel remains DISABLED by default until its sandbox suite passes. All provider-facing logic is verified against documented response structures at the HTTP-boundary-mocked level and against the mock provider at the integration level.

## 19. Real provider sandbox evidence

None available in this build (credentials not provided). This is explicitly recorded rather than simulated — see §18 and the test report.

## 20. Deployment readiness

- Infrastructure unchanged: frontend → Netlify, backend → Render, workers → existing Render worker services, PostgreSQL, Redis-compatible service.
- Deploy steps: apply migration 0005 (`prisma migrate deploy` — additive, safe to run while v1.0.7 serves traffic), deploy backend + workers + frontend.
- New environment variables optional with safe defaults (`PAYOUT_OUTBOX_LEASE_MINUTES=10`, `PAYOUT_FLW_MOBILE_MONEY_ENABLED=false`).
- Production fails closed: missing required payment/security settings are rejected by configuration validation (preserved from v1.0.7); the mock provider remains forbidden in production; the mobile-money channel is disabled by default.

## 21. Remaining limitations

1. Provider sandbox verification outstanding (§18) — initiation/verification against live Paystack/Flutterwave is unproven in this build.
2. Flutterwave mobile-money payouts remain disabled until (1) passes for that corridor.
3. Evidence "availability" is enforced at the registry-lifecycle level (EXPIRED/FAILED statuses); object-store-level availability checks remain the storage module's responsibility (unchanged from v1.0.7).
4. `PayoutService.isManualProvider()` is retained for backward-compatible read paths; all authorization now flows through the allowlist module.

## 22. Backup verification

- v1.0.7 release zip: integrity-tested (`unzip -t`, 476 entries) and independently extracted; all 379 internal checksums verified; SHA-256 recorded in the manifest.
- Pre-v1.0.8 backup (`KINDORA_v1.0.7_PRE_V108_BACKUP.tar.gz`): created from the verified extraction, SHA-256 recorded, independently extracted and re-verified byte-identical.
- The v1.0.8 archive contains the v1.0.7 backup + its checksum manifest + this release's complete `SHA256SUMS.txt`; the packaging verification re-checks archive identity, integrity, expected files, backup checksums, the full manifest, secret scan (no private key material, no `.env`) and restorability.

## 23. Final release classification

**PRODUCTION CANDIDATE**

Justification: all P0 and P1 requirements are implemented and verified — the manual settlement bypass is closed end to end (unit + real-API integration evidence), approval-cycle enforcement is proven at every authorization point (22 dedicated unit scenarios + real-DB refusal test), outbox recovery is verified on real PostgreSQL (both stale-lease scenarios, no duplicate transfers), financial state transitions are atomic (verified with failure injection in the atomicity suite), and no unresolved critical payout vulnerability remains. The single outstanding item — live provider sandbox verification — does not affect the security properties of this release: provider interaction remains fail-closed, the affected channel is disabled, and the internal authorization path (the subject of both P0 fixes) is fully independent of provider credentials. Per the release directive, the classification is not lowered for an environment limitation, and it is recorded honestly rather than obscured.
