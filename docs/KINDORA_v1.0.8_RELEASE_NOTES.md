# KINDORA v1.0.8 — Release Notes

**Release:** KINDORA v1.0.8_SECURITY_COMPLETE
**Baseline:** KINDORA v1.0.7_SECURITY_COMPLETE
**Type:** targeted financial-security upgrade (payout settlement authorization & recovery) — no rebuild, no removed functionality, no weakened controls.

---

## P0 — financial security fixes

1. **Manual settlement provider bypass CLOSED** (§3). The v1.0.7 `settleManual()` accepted any provider string and could record a "successful payout" naming `PAYSTACK_TRANSFER` etc. v1.0.8 enforces an explicit server-side allowlist — `MANUAL_BANK_TRANSFER`, `CASH`, `APPROVED_OFFLINE_CHANNEL` — at the DTO, the controller and (mandatorily) the service layer. API providers, the legacy `MANUAL_BANK` name and every unknown value are rejected with explicit errors. Manual settlements record the NEW distinct reconciliation classification `MANUAL_EVIDENCE_RECORDED` — they can never read as provider-verified matches. Evidence must be an authorized, approved, clean-scanned private `PAYOUT_EVIDENCE` StoredFile owned by the executor and bound to the withdrawal — validated in the controller path AND re-validated inside the settlement transaction.
2. **Approval-cycle validity is now a MANDATORY settlement gate** (§4). The v1.0.7 reconciliation computed `approvalCycleValid` but only stored it in metadata. v1.0.8's centralized `validatePayoutApprovalCycle()` returns a structured 19-condition result (existence, both approvals ACTIVE in the current cycle, four-person identity separation, amount/currency/destination binding, snapshot-hash integrity, beneficiary binding, valid withdrawal state) and is enforced BEFORE initiation, at submission time, and — decisively — INSIDE the reconciliation transaction before any successful settlement. An invalid cycle blocks settlement with `INTERNAL_STATE_MISMATCH` + audit event `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE` and escalates to manual review.

## P1 — operational reliability fixes

3. **Outbox crash recovery repaired** (§5): lease-based ownership (`leaseExpiresAt`, worker identity, recovery counters). Expired IN_FLIGHT leases are reclaimed atomically and the provider is consulted by the deterministic submission reference BEFORE any resubmission — a crash after provider acceptance can never create a duplicate transfer.
4. **Flutterwave mobile-money beneficiary verification implemented; channel DISABLED by default** (§6): provider-authoritative verification path (network code + mobile number identity recomputed from the transfer's own fields); the channel opens only after sandbox verification passes (`PAYOUT_FLW_MOBILE_MONEY_ENABLED`).
5. **Exact monetary arithmetic** (§7): all float conversions removed; amounts are exact BigInt decimal strings embedded as raw JSON tokens and parsed exactly from raw response text; over-precision is rejected, never rounded; safe-range ceilings enforced for both providers.
6. **Reversal status classification corrected** (§8): `reverse_initiated` / `reversing` are `REVERSAL_IN_PROGRESS` (never terminal), tracked in a forward-only `reversalState` lifecycle; only a provider-verified completed reversal applies `REVERSED` and posts the exactly-once `withdrawal-reversal:<id>` accounting correction.
7. **Definite rejections are atomic** (§9): a zero-row withdrawal update aborts the entire transaction instead of committing a FAILED attempt beside a non-FAILED withdrawal.
8. **Verification queue dispatch fixed**: v1.0.7's `verify:<id>` jobIds were silently rejected by BullMQ (colon not allowed); dispatch now works (`verify-<id>`), the sweeper remains the crash-recovery floor.

## Upgrade

```bash
cd backend
npx prisma migrate deploy   # applies 0005_payout_authorization_lockdown (forward-only, additive)
```

New environment variables (both optional, safe defaults): `PAYOUT_OUTBOX_LEASE_MINUTES` (default 10), `PAYOUT_FLW_MOBILE_MONEY_ENABLED` (default false). No existing variable was removed.

## Documentation

- PAYOUT_ARCHITECTURE_V1.0.8.md, MANUAL_SETTLEMENT_PROCEDURES_V1.0.8.md, OUTBOX_RECOVERY_V1.0.8.md, REVERSAL_HANDLING_V1.0.8.md, PROVIDER_INTEGRATION_V1.0.8.md, KINDORA_v1.0.8_TEST_REPORT.md, FINAL_ENGINEERING_REPORT_V1.0.8.md, ENVIRONMENT_VARIABLES.md (v1.0.8 section).

## Verification status (honest)

- Unit: 315/315. Integration on real PostgreSQL 17 + Redis 7.2.5: 53/53 (fresh DB every run). Migration paths (fresh + upgrade-from-v1.0.7): verified on real PG, schema-diff empty. Builds: backend/frontend/workers all pass.
- Provider sandbox: BLOCKED (no credentials) — no sandbox evidence claimed. Mobile-money channel stays disabled until sandbox-verified.
