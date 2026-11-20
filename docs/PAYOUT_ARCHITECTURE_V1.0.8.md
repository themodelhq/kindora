# KINDORA v1.0.8 — Payout Architecture Update

**Baseline:** KINDORA v1.0.7_SECURITY_COMPLETE
**Scope:** targeted financial-security correction (payout authorization & recovery lockdown). The v1.0.7 architecture is preserved — nothing was rebuilt, no working functionality was removed, no security control was weakened.

Related: [PAYOUT_ARCHITECTURE_V1.0.7.md](PAYOUT_ARCHITECTURE_V1.0.7.md) (unchanged foundation) | [MANUAL_SETTLEMENT_PROCEDURES_V1.0.8.md](MANUAL_SETTLEMENT_PROCEDURES_V1.0.8.md) | [OUTBOX_RECOVERY_V1.0.8.md](OUTBOX_RECOVERY_V1.0.8.md) | [REVERSAL_HANDLING_V1.0.8.md](REVERSAL_HANDLING_V1.0.8.md) | [PROVIDER_INTEGRATION_V1.0.8.md](PROVIDER_INTEGRATION_V1.0.8.md)

---

## 1. What changed in v1.0.8

| Area | v1.0.7 behavior | v1.0.8 behavior |
| --- | --- | --- |
| Manual settlement channel | Free-text `payoutProvider` (DTO `@IsString`); the regex helper `isManualProvider()` existed but was never called by `settleManual()` | Explicit server-side allowlist (`MANUAL_BANK_TRANSFER`, `CASH`, `APPROVED_OFFLINE_CHANNEL`) enforced at the DTO (`@IsIn`), the service layer (`assertManualSettlementChannel`), and re-asserted inside the settlement transaction. API providers are structurally rejected. |
| Manual reconciliation classification | Manual settlements recorded `result: 'MATCHED'` — indistinguishable from provider-verified matches | New enum value `MANUAL_EVIDENCE_RECORDED` — a manual settlement can never read as an authoritative provider verification |
| Approval cycle | `approvalCycleValid` computed and stored in reconciliation metadata only — NOT enforced before settlement | `PayoutApprovalCycleService.validate()` returns a structured 19-condition result; settlement is BLOCKED (`INTERNAL_STATE_MISMATCH` + audit `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE`) whenever the current cycle is invalid — before initiation, at submission time, and again inside the reconciliation transaction |
| Manual evidence | Validated in `WithdrawalsService` only (service could be invoked without it) | Canonical `PayoutEvidenceService` — invoked by the controller path AND re-validated INSIDE the settlement transaction; requires an APPROVED, CLEAN-scanned, PRIVATE `PAYOUT_EVIDENCE` StoredFile owned by the executor and bound to this withdrawal |
| Outbox recovery | Sweep found IN_FLIGHT rows but the claim only took PENDING → crashed workers' events stuck forever | Lease-based ownership (`leaseExpiresAt`, `claimedBy`, `recoveryAttempts`); expired IN_FLIGHT leases are atomically reclaimed and the provider is consulted by submission reference BEFORE any resubmission |
| Amount arithmetic | `Number(amountMinor) / 10^d` (float division) and `BigInt(Math.round(amount * 10^d))` (float multiply) | Exact BigInt/string arithmetic everywhere: raw decimal JSON tokens on transmission, raw-token parsing on verification; over-precision values are rejected, never rounded |
| Reversals | `reversed` / `reverse_initiated` / `reversing` all classified as terminal `REVERSED` | In-progress reversals (`reverse_initiated`, `reversing`) classify `REVERSAL_IN_PROGRESS`, advance a forward-only `reversalState` lifecycle, keep the attempt unresolved and the reservation intact; only a provider-verified COMPLETED reversal applies the terminal status and posts the exactly-once accounting correction (`withdrawal-reversal:<id>`) |
| Definite rejection | A zero-row withdrawal update wrote an audit row and committed — FAILED attempt beside a non-FAILED withdrawal | Zero-row conditional update ABORTS the whole transaction (attempt, outbox and audit roll back together) |
| Verification dispatch | BullMQ jobId `verify:<id>` contains `:` — silently rejected by BullMQ; verification dispatch degraded to the sweeper | Colons removed (`verify-<id>`, `outbox-<id>`) — queue dispatch works |

## 2. The mandatory authorization sequence (v1.0.8 directive)

1. A withdrawal is requested.
2. It is independently reviewed and approved (fresh MFA per role).
3. The approved amount, currency, beneficiary and destination version are bound to the approval cycle (snapshot hash).
4. A separate authorized executor passes fresh MFA.
5. The payout execution intent is durably recorded (attempt + outbox in one transaction).
6. The provider transfer is initiated safely through the outbox pipeline.
7. The provider-generated transfer identity is persisted.
8. The transfer is independently verified against the provider API (webhooks only ever trigger verification).
9. The current approval cycle is REVALIDATED inside the reconciliation transaction.
10. Amount, currency and beneficiary are checked with exact integer arithmetic.
11. Reconciliation is applied atomically.
12. The withdrawal is marked PAID only when every condition passes.

If any condition fails or becomes uncertain, the reservation is preserved, automatic settlement is blocked, and the transaction is escalated (manual review case).

## 3. New schema surface (migration 0005, forward-only)

- `ManualSettlementChannel` enum — the allowlist closed at the DB surface.
- `PayoutReversalState` enum + `PayoutAttempt.reversalState` / `reversalObservedAt`.
- `PayoutAttempt.manualChannel` — allowlisted channel recorded on manual attempts.
- `PayoutOutbox.leaseExpiresAt` / `recoveryAttempts` / `lastRecoveryAt` + index `(status, leaseExpiresAt)`.
- `ReconciliationResult` += `PROVIDER_REVERSAL_IN_PROGRESS`, `MANUAL_EVIDENCE_RECORDED`.
- `LedgerTxnType` += `WITHDRAWAL_REVERSAL` (separate, exactly-once reversal accounting event).

Historical rows are untouched (new columns are NULL for history; enum additions are additive). No historical migration was modified.

## 4. New modules

- `backend/src/payouts/manual-settlement-channels.ts` — THE allowlist (`assertManualSettlementChannel`, `normalizeLegacyManualChannel` for read-side continuity of legacy `MANUAL_BANK` rows).
- `backend/src/payouts/payout-approval-cycle.service.ts` — `validate()` (§4.3 conditions) + canonical `snapshotHash()`.
- `backend/src/payouts/payout-evidence.service.ts` — canonical evidence validation + binding.
- `backend/src/common/utils/exact-money.ts` — exact decimal conversion utilities (BigInt only).
