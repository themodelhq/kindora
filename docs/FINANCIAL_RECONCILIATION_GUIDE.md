# KINDORA v1.0.4 — Financial Reconciliation Guide

Model source: `backend/src/payouts/payout-state-machine.ts` (`evaluateReconciliation`,
`ReconciliationOutcome`) and `backend/src/payouts/payout.service.ts`
(`applyProviderVerification`, `verifyAttempt`, `reconcileWithdrawal`). Storage:
`PayoutReconciliation` rows (result, provider/internal status, match booleans,
`providerEvidence` JSONB, note, actor).

## 1. The model

Every verification or reconciliation run classifies the outcome into exactly one of ten
`ReconciliationResult` values and stores it immutably. Inputs: the internal withdrawal
status, the attempt status, the provider verification (classification + raw status +
amount/currency/destination), expected amount/currency/destination, and a duplicate
reference flag. Provider destination is compared as a salted hash
(`destinationRef = sha256:<hash>`), never raw account numbers.

**Core rule: UNKNOWN is never FAILED.** An unrecognised provider status, an empty
status, a transport timeout, or an HTTP error all classify as `UNKNOWN`. Only an
authoritative, recognisable terminal failure (e.g. Paystack `failed`/`cancelled`,
Flutterwave `failed`/`error`) may transition a payout to `FAILED`. This guarantees the
funds reservation stays intact until the outcome is proven — the platform can never
"lose" a transfer by misclassifying an outage as a failure and double-paying on retry.

## 2. Result categories and operator procedures

| Result | Meaning | Resolution |
| --- | --- | --- |
| `MATCHED` | Provider and internal state agree (settled+PAID, failed+FAILED, reversed+REVERSED). | **No action.** Auto-recorded. |
| `PROVIDER_SUCCESS_INTERNAL_PENDING` | Provider says settled; internal ledger has not caught up (internal PROCESSING/REQUIRES_RECONCILIATION). | **Auto-resolvable:** `PayoutService` finalizes the withdrawal to `PAID`, posts the ledger, audits `PAYOUT_SETTLED_PROVIDER_VERIFIED`. Operator just confirms the withdrawal shows `PAID`. |
| `PROVIDER_FAILED_INTERNAL_PROCESSING` | Authoritative provider failure while internal state is PROCESSING. | **Auto-resolvable:** attempt → `FAILED`, withdrawal → `FAILED` (audit `PAYOUT_ATTEMPT_FAILED_AUTHORITATIVE`). Funds release; the payout is now eligible for `POST /api/v1/withdrawals/:id/retry`. |
| `PROVIDER_PENDING` | Provider still processing (Paystack `pending/otp/processing/queued`, Flutterwave `pending/queued/new/processing/in_progress`). | **Wait + re-verify.** Attempt → `PENDING`; withdrawal PROCESSING → `REQUIRES_RECONCILIATION`. Reservation intact. Re-run verification later; never start a new transfer. |
| `PROVIDER_UNKNOWN` | Verification unavailable/unrecognised while internal state is PROCESSING. | **Re-verify.** Attempt → `UNKNOWN`; withdrawal → `REQUIRES_RECONCILIATION`. NEVER treated as FAILED. Retry verification (provider outage usually clears). If it persists, escalate to manual investigation. |
| `AMOUNT_MISMATCH` | Provider-reported amount ≠ expected attempt amount. | **Manual investigation.** Attempt → `UNKNOWN`, withdrawal → `REQUIRES_RECONCILIATION` (audit `RECONCILIATION_AMOUNT_MISMATCH`). Settlement is refused. Compare provider statement vs `PayoutAttempt.amount`; check for partial transfers or currency conversion; involve finance before any state change. |
| `CURRENCY_MISMATCH` | Provider currency ≠ expected currency. | **Manual investigation**, same handling. Common cause: wrong provider account/config. |
| `DESTINATION_MISMATCH` | Provider destination hash ≠ attempt destination hash. | **Manual investigation.** Potential misdirected transfer — treat as high severity; contact the provider to trace/return funds. |
| `DUPLICATE_REFERENCE` | The provider reference is already bound to a **different** attempt (unique `PayoutAttempt.providerTransferRef`). | **Manual investigation.** Recorded, never applied. Someone may be replaying evidence or the ref was mistyped. Identify both attempts; correct the reference or escalate. |
| `REQUIRES_MANUAL_INVESTIGATION` | Internal state is `REQUIRES_RECONCILIATION` and no usable verification exists (or UNKNOWN classification persists). | **Manual investigation** — the only state where an operator pulls provider statements and attaches evidence (§4). |

Quick triage: **auto-resolved** = `MATCHED`, `PROVIDER_SUCCESS_INTERNAL_PENDING`,
`PROVIDER_FAILED_INTERNAL_PROCESSING`; **re-verify later** = `PROVIDER_PENDING`,
`PROVIDER_UNKNOWN`; **human investigation required** = `AMOUNT_MISMATCH`,
`CURRENCY_MISMATCH`, `DESTINATION_MISMATCH`, `DUPLICATE_REFERENCE`,
`REQUIRES_MANUAL_INVESTIGATION`.

## 3. How to run verification / reconciliation

Both are ADMIN routes requiring fresh MFA (purpose `PAYOUT_RECONCILIATION`; see
`docs/PAYOUT_OPERATIONS_GUIDE.md` §2 for challenge issuance, TTL 120s, single-use,
scope = the withdrawal id for `/withdrawals/:id/reconcile`).

```bash
# 1. Find payouts needing attention
curl "$API/api/v1/withdrawals/admin/all?status=REQUIRES_RECONCILIATION" \
     -H "Authorization: Bearer $ADMIN_JWT"

# 2. Verify a specific attempt against the provider transfer API
#    (fresh MFA challenge purpose=PAYOUT_RECONCILIATION)
curl -X POST "$API/api/v1/withdrawals/attempts/$ATTEMPT_ID/verify" \
     -H "Authorization: Bearer $ADMIN_JWT" \
     -H "x-mfa-challenge: $CHALLENGE_TOKEN"
# -> { attempt, applied, verification { classification, providerStatus, ... } }

# 3. Reconcile a withdrawal (verifies its latest attempt, or a given attempt via body)
curl -X POST "$API/api/v1/withdrawals/$WITHDRAWAL_ID/reconcile" \
     -H "Authorization: Bearer $ADMIN_JWT" -H "x-mfa-challenge: $CHALLENGE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"note":"morning sweep"}'
# -> { withdrawalId, attemptId, verification | result | "NO_ATTEMPTS" }
```

Behaviour notes:

- Verifying an already-resolved attempt (`SUCCESSFUL`/`REVERSED`) is a no-op
  (`applied: false, reason: "Attempt already resolved"`).
- `MANUAL_*` providers have no API verifier — verification returns 400; resolve them via
  reconciliation evidence instead (`evidenceFileId` on `/withdrawals/:id/reconcile` is a
  registered private `PAYOUT_EVIDENCE` StoredFile, scanned CLEAN, bound to this
  withdrawal).
- `/withdrawals/:id/reconcile` is idempotent and read-only on money: it re-checks
  resolved attempts and records a fresh `PayoutReconciliation` row; it never mutates
  balances by itself (state changes only happen through the classified application in
  `PayoutService`).
- Every verification stores `providerEvidence` (classification, provider reference,
  amount, currency, destination hash) — the audit trail for later investigation.
- Escalating results (mismatches, duplicates, manual-investigation) set the attempt to
  `UNKNOWN` and the withdrawal to `REQUIRES_RECONCILIATION`; the funds reservation is
  never released by reconciliation itself.

State edges available from `REQUIRES_RECONCILIATION` (canonical state machine): `PAID`
(verified successful transfer), `FAILED` (verified terminal failure only), `REJECTED`
(kept for machine completeness; the admin reject route targets only pre-transfer
states — do not use rejection to "clean up" an in-flight transfer).

## 4. Manual investigation procedure

1. Pull the withdrawal's full trail: `GET /api/v1/withdrawals/:id` (detail),
   `GET /api/v1/withdrawals/:id/evidence-url` (300s signed URL for attached evidence),
   the `PayoutReconciliation` rows for the withdrawal, and the AuditLog entries
   (`RECONCILIATION_*`, `PAYOUT_STATE_*`).
2. Pull the provider-side statement/transfer record (Paystack/Flutterwave dashboard or
   API) for the attempt's `providerTransferRef`.
3. Classify the truth:
   - Money **arrived** (correct amount/currency/destination): attach evidence, run
     verification again — `PROVIDER_SUCCESS_INTERNAL_PENDING` finalizes to `PAID`.
   - Money **failed authoritatively**: verification maps to FAILED; then decide on
     `POST /api/v1/withdrawals/:id/retry` (needs purpose `PAYOUT_RETRY`, and is only
     permitted from `FAILED` with no unresolved attempt and a recorded failure reason).
   - Money **mismatched/misdirected/duplicated**: do NOT retry and do NOT settle. Open a
     finance ticket; the provider must trace/return funds. Resolution is recorded as a
     new reconciliation row with a note once finance decides.
4. Never edit `PayoutReconciliation` rows directly; append new rows via the endpoints.

## 5. Reconciliation digest cron

Render cron service `kindora-reconciliation-digest` (from `render.yaml`):

- Schedule: `0 4 * * *` (daily 04:00 UTC) → `node dist/cron/reconciliation-digest.js`
  (`workers/src/cron/reconciliation-digest.ts`).
- Holds a Redis lock (`cron:reconciliation-digest`, 10 min TTL, SET NX PX) so only one
  instance runs.
- Collects, **without calling any provider API** and without state changes:
  - `WebhookEvent` rows with status `FAILED` created in the last 24h (latest 20 listed,
    with provider/eventType/reference/error),
  - stale `PENDING` donations older than 30 minutes on a live provider (provider
    != MANUAL, oldest 20 listed).
- Emails the digest to `ADMIN_EMAILS` via SMTP. If there is nothing to report it logs
  "all clear" and sends nothing; if `ADMIN_EMAILS` is empty it logs a warning and the
  findings are skipped — so keep `ADMIN_EMAILS` populated (see
  `docs/PRODUCTION_ENVIRONMENT_VARIABLES.md` §4).
- This digest covers the **payment intake** side (donations/webhooks). **Payout-side**
  reconciliation is driven by the verify/reconcile endpoints (§3) — the withdrawal
  admin queue (`status=REQUIRES_RECONCILIATION`) is the operator's daily payout sweep.

## 6. The exactly-once ledger guarantee

- Every settlement — provider-verified (`finalizeSuccess`) or manual
  (`settleManual`) — posts through `LedgerService.postWithdrawal`, whose transaction
  reference is **`withdrawal:<id>`**, with a UNIQUE constraint on ledger references.
- Because the reference is deterministic per withdrawal, any double-settlement race
  (two concurrent verifications, a retry of the same HTTP request, a replayed settle)
  collides on the unique index: Prisma `P2002` → **409 Conflict**
  (`"This withdrawal has already been settled (duplicate payout prevented)"`), and the
  transaction (attempt update + withdrawal update + ledger posting + audit) rolls back.
- Additional unique barriers in the same layer:
  - `PayoutAttempt.idempotencyKey = payout:<withdrawalId>:<attemptNo>` — provider-level
    retries (HTTP retry, job retry, webhook replay) map to the **same** attempt row.
  - `PayoutAttempt.providerTransferRef` UNIQUE — one provider reference belongs to
    exactly one attempt; reuse surfaces as `DUPLICATE_REFERENCE`.
  - `PayoutAttempt (withdrawalId, attemptNo)` UNIQUE — attempt numbering is monotonic.
  - `WithdrawalApproval (withdrawalId, cycle, role)` UNIQUE — one role-holder per cycle.
- Net effect: for any withdrawal id, the ledger contains **at most one** withdrawal
  posting. Operator corollary: a 409 on settle/verify is *protective* — investigate why
  a second settlement was attempted (usually a stale UI tab) rather than working around
  it.

## 7. Daily operator checklist

- [ ] Inbox: reconciliation digest delivered (or "all clear" in worker logs).
- [ ] `GET /api/v1/withdrawals/admin/all?status=REQUIRES_RECONCILIATION` — queue empty
      or every item has an owner + finance ticket.
- [ ] No attempt stuck in `UNKNOWN`/`PENDING` > 24h without a re-verify.
- [ ] All `AMOUNT/CURRENCY/DESTINATION_MISMATCH` and `DUPLICATE_REFERENCE` rows have a
      manual-investigation note and no settlement was forced around them.
- [ ] `GET /api/v1/health/redis` is `ok` — verification and MFA depend on it.
