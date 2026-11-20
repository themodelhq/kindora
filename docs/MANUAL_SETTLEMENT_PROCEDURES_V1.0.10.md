# KINDORA Manual Settlement Procedures — v1.0.10

Manual settlement guide for v1.0.10. The two-step protocol, the immutable
channel-bound approval snapshot and the four-person separation are UNCHANGED from
v1.0.9 (`MANUAL_SETTLEMENT_PROCEDURES_V1.0.9.md`) — this document adds the
v1.0.10 concurrency guarantees that protect the protocol and the verification
evidence.

## 1. The two-step protocol (unchanged)

1. **Authorize the manual payout intent** — `POST /api/v1/withdrawals/:id/execute`
   with an allowlisted channel (`MANUAL_BANK_TRANSFER`, `CASH`,
   `APPROVED_OFFLINE_CHANNEL`), executor MFA required. The authorization binds the
   immutable MANUAL settlement snapshot (amount, currency, destination hash +
   version, settlement channel, approver set, approval cycle, approval row ids and
   timestamps) onto BOTH approval records and registers the durable intent
   (a `MANUAL_BANK_TRANSFER`-channel attempt, no outbox row).
2. **Settle with evidence** — `POST /api/v1/withdrawals/:id/settle` with the
   channel, the provider transfer reference (proof of settlement), a REGISTERED
   private evidence file id and fresh executor MFA. The in-transaction validator
   recomputes and constant-time-compares the snapshot; a withdrawal without the
   bound snapshot is NEVER grandfathered.

## 2. v1.0.10 concurrency guarantees (proven, not assumed)

Manual settlement and automated provider submission arbitrate through ONE durable
PostgreSQL boundary (`PayoutSettlementGuard`) plus in-lock rechecks. The v1.0.10
suite proves on REAL PostgreSQL 17 + Redis 7.2.5 with deterministic provider
barriers:

- **While a provider submission is authorized or in flight** (attempt unresolved,
  outbox `PENDING`/`IN_FLIGHT`, guard `PROVIDER_SUBMISSION_ACTIVE`): manual
  settlement is 409-blocked — the in-lock recheck of unresolved attempts and
  pending outbox events fires before the guard claim (scenario B; the
  v1.0.9 §3.1 test remains).
- **While an authorized manual intent is outstanding**: provider initiation
  cannot obtain submission authorization — the unresolved-attempt pre-check and
  the approval-snapshot binding defense both fail closed (scenario C).
- **True concurrency**: an authorized manual intent and an API provider
  initiation racing on the same withdrawal produce EXACTLY one winner and zero
  ledger entries (scenario A).
- **Crash / lease expiry / ambiguity**: manual settlement stays blocked while the
  provider outcome is unresolved; recovery reconciles the provider BEFORE any
  resubmission; ambiguous lookups never release the reservation (scenarios D–G).

For every logical withdrawal: at most one successful settlement and at most one
payout ledger posting — whichever path wins.

## 3. Verification additions in v1.0.10

- The final provider-verified reconciliation now validates the LOCKED executor
  identity (`PayoutAttempt.initiatedById` read under the row lock). A missing or
  colliding executor blocks settlement with a
  `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE` audit event carrying the
  locked executor value and the invalid reason. This does NOT change the manual
  settlement flow: manual settlements validate the executor through the same
  approval-cycle matrix and record the executor in the
  `WITHDRAWAL_PAID_MANUAL_SETTLEMENT` audit event (unchanged).
- New integration proof: `v1.0.10 §5.6` (missing executor → blocked; executor
  colliding with an approver → blocked; the authorized fourth person → settled,
  audit records the locked identity).
- New unit proof: `payout-reconciliation-atomic.spec.ts` §5.6 matrix.

## 4. Operator checklist (per settlement)

1. Confirm the withdrawal is in a payable state (`APROVED`/`PROCESSING`/
   `REQUIRES_RECONCILIATION`) and the manual intent exists
   (`PAYOUT_MANUAL_INTENT_AUTHORIZED` audit event).
2. Confirm no provider attempt is unresolved (`PayoutAttempt` has no row in
   `INITIATED / SUBMISSION_PENDING / PROVIDER_ACCEPTED / PENDING / UNKNOWN /
   MANUAL_REVIEW` for a non-manual provider).
3. Record the EXACT bank reference and attach the registered evidence file.
4. Settle with fresh MFA; expect the guard to become `SETTLED` and exactly one
   ledger posting.
5. If the settlement is 409-blocked, do NOT retry blindly: check
   `PayoutOutbox`/`PayoutAttempt` for an unresolved provider submission and run
   the recovery guide (`OUTBOX_RECOVERY_V1.0.10.md`) first.
