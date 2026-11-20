# KINDORA v1.0.4 — Payout Operations Guide (Operator Runbook)

Audience: administrators executing withdrawal payouts in production. Every endpoint
below is prefixed `/api/v1` and every state-changing admin route requires **fresh MFA**:
a single-use challenge token sent in the `x-mfa-challenge` header. Read-only routes
(`GET /withdrawals/admin/all`, `GET /withdrawals/:id`, `GET /withdrawals/:id/evidence-url`)
use normal ADMIN JWT auth only.

The legacy `mark-paid` / `mark-processing` / `mark-failed` endpoints no longer exist.
No human can push a payout to FAILED; only authoritative provider verification can.

## 1. One-time setup: fresh MFA enrollment (each admin)

Every payout role (approver, second approver, executor, reconciler) must have MFA
ACTIVE. Enrollment is ADMIN-only and tied to your JWT identity:

```bash
# 1. Enroll — returns an otpauth:// URI + secret shown EXACTLY ONCE
curl -X POST $API/api/v1/mfa/enroll -H "Authorization: Bearer $JWT"
# 2. Add the secret to your authenticator app (TOTP, 6-digit codes)
# 3. Confirm with a current code
curl -X POST $API/api/v1/mfa/confirm -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" -d '{"code":"123456"}'
# 4. Check status
curl $API/api/v1/mfa/status -H "Authorization: Bearer $JWT"
```

If you lose your authenticator: `POST /api/v1/mfa/disable`, then enroll again
(`MFA is disabled. Enroll again before performing payout approvals.`).

## 2. Per-operation MFA challenges

Each sensitive operation needs a **fresh** challenge bound to a purpose and to the
target withdrawal:

```bash
curl -X POST $API/api/v1/mfa/challenge -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"purpose":"PAYOUT_FIRST_APPROVAL","scope":"<withdrawalId>","code":"<current 6-digit code>"}'
# -> { "challengeToken": "...", "expiresInSeconds": 120, "purpose": "...", "scope": "..." }
```

Properties (enforced by `MfaService`): TTL **120 seconds**, **single-use** (atomic
consume — a replay returns 403), **purpose-bound** (a challenge for one purpose cannot
authorize another), **scope-bound** (a challenge scoped to withdrawal A cannot authorize
withdrawal B), **fail-closed** (Redis unavailable → 503 and the operation is rejected).
A TOTP code can be exchanged once per time step (`mfa:code:<userId>:<counter>`).
`GET /api/v1/mfa/policy` introspects which routes require fresh MFA.

| Purpose | Endpoint that consumes it |
| --- | --- |
| `PAYOUT_STATE_CHANGE` | `POST /withdrawals/:id/under-review`, `:id/require-info`, `:id/reject` |
| `PAYOUT_FIRST_APPROVAL` | `POST /withdrawals/:id/approve` |
| `PAYOUT_SECOND_APPROVAL` | `POST /withdrawals/:id/second-approval` |
| `PAYOUT_SETTLEMENT` | `POST /withdrawals/:id/settle` |
| `PAYOUT_RETRY` | `POST /withdrawals/:id/retry` |
| `PAYOUT_RECONCILIATION` | `POST /withdrawals/attempts/:attemptId/verify`, `POST /withdrawals/:id/reconcile` |

## 3. Roles: three distinct administrators

The standard workflow uses **three different people**:

1. **First approver** — reviews the request (`:id/under-review` → `:id/approve`).
2. **Second approver** — independently confirms (`:id/second-approval`).
3. **Executor** — performs the settlement (`:id/settle`) or authorizes the provider
   transfer and verifies it.

Hard rules enforced server-side (`WithdrawalsService` + `PayoutService`):

- The **requester** of a withdrawal can never approve, second-approve, reject, settle,
  or retry it.
- The **first approver can never also be the second approver** — there is no
  UNDER_REVIEW exception; identity is checked before state.
- The **executor must not be the second approver** (executor separation). The second
  approver never executes; only in the degenerate case where a third administrator is
  impossible may the first approver execute.
- No administrator may satisfy two approval roles.
- Approvals bind to the exact **amount + currency**: if either changed since the first
  approval, the cycle is invalidated (`approvalCycle` increments) and a new first
  approval is required.
- `WITHDRAWAL_DUAL_APPROVAL_MODE=ALL` (production default) applies this to **every**
  payout; `THRESHOLD` mode applies it above the configured minor-unit threshold. There
  is no configuration that disables dual approval.

## 4. The standard payout workflow

```text
REQUESTED(PENDING) → UNDER_REVIEW → APPROVED → [second-approval] → settle/transfer
                                   ↘ REQUIRES_INFORMATION / REJECTED
PROCESSING → PAID (verified) | REQUIRES_RECONCILIATION (ambiguous) | FAILED (verified)
```

### Step 1 — Under review (Admin A)
```
POST /api/v1/withdrawals/:id/under-review        purpose: PAYOUT_STATE_CHANGE
```

### Step 2 — First approval (Admin A)
```
POST /api/v1/withdrawals/:id/approve             purpose: PAYOUT_FIRST_APPROVAL
```
Records `WithdrawalApproval(role=FIRST_APPROVER)` for the current cycle and returns
`"Approved. A second administrator must confirm this payout before it can be paid."`

### Step 3 — Second approval (Admin B, ≠ Admin A, ≠ requester)
```
POST /api/v1/withdrawals/:id/second-approval     purpose: PAYOUT_SECOND_APPROVAL
body: {"note":"Independent review of bank details and campaign balance"}
```
Records `role=SECOND_APPROVER`. Concurrent approvals race safely — only the first write
wins (`409 Second approval already recorded`).

### Step 4 — Settlement (Admin C — the executor)
The executor must NOT be the second approver. Two paths:

**a) Provider transfer (Paystack/Flutterwave):** initiate the transfer, then verify it
(§5). Verification is the only path that settles API-provider payouts.

**b) Manual settlement (bank portal / off-API channel):** upload evidence first (§4.1),
then:
```
POST /api/v1/withdrawals/:id/settle              purpose: PAYOUT_SETTLEMENT
body: {
  "payoutProvider": "MANUAL_BANK",            // channel; PAYSTACK_TRANSFER etc. for API channels
  "providerTransferRef": "NUBAN-ref-123456",  // required proof of settlement
  "payoutProviderTxnId": "optional-provider-txn-id",
  "evidenceFileId": "<StoredFile id>",        // required; see §4.1
  "note": "Sent via bank portal"
}
```
Settlement writes the `EXECUTOR` approval row, a `PayoutAttempt` (SUCCESSFUL), a
`PayoutReconciliation` (MATCHED, `providerStatus=MANUAL_CONFIRMED`), and posts the
ledger entry. Exactly-once: the ledger reference `withdrawal:<id>` is unique — a
duplicate settlement returns **409**.

### 4.1 Evidence file requirements (manual settlement / reconcile evidence)

Evidence is a registered `StoredFile` id — **never an arbitrary URL**. `validateEvidenceFile`
enforces:

- Uploaded **by the submitting administrator** (executor) themselves.
- `visibility = PRIVATE` (payout-evidence kind is private by construction; it never
  receives a public URL).
- `kind = PAYOUT_EVIDENCE`.
- Security scan **completed and CLEAN** — files still `SCANNING`/`PENDING` or
  `QUARANTINED`/`REJECTED`/`FAILED` are rejected. Upload early: scans are asynchronous
  (worker `media.scan-file`; needs `MALWARE_SCAN_ENDPOINT` on the worker — without a
  scanner, sensitive files stay quarantined).
- Bound to exactly **this** withdrawal — the unique
  `StoredFile.evidenceForWithdrawalId` index makes reuse across withdrawals impossible.

Upload flow:
```bash
# 1. Get a presigned POST policy
curl -X POST $API/api/v1/storage/presign -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"filename":"swift-receipt.pdf","contentType":"application/pdf","kind":"payout-evidence"}'
# 2. POST the file to the returned postUrl with the returned fields
# 3. Confirm and enter the scan lifecycle
curl -X POST $API/api/v1/storage/confirm -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" -d '{"key":"payout-evidence/<userId>/..."}'
# 4. Poll GET /api/v1/storage/mine until status APPROVED and scanVerdict CLEAN
```

Short-lived, audited evidence download (300s signed URL):
`GET /api/v1/withdrawals/:id/evidence-url` (normal admin auth).

### Step 5 — Reconcile (post-settlement documentation / checks)
```
POST /api/v1/withdrawals/:id/reconcile           purpose: PAYOUT_RECONCILIATION
body: {"evidenceFileId":"<optional StoredFile id>","note":"..."}
```
Idempotent and read-only on money: re-verifies the latest (or given) attempt, records a
`PayoutReconciliation` row, and audits `WITHDRAWAL_RECONCILED`.

## 5. How verification works

`POST /api/v1/withdrawals/attempts/:attemptId/verify` (purpose `PAYOUT_RECONCILIATION`)
queries the provider's transfer API for the authoritative outcome:

- `PAYSTACK` / `PAYSTACK_TRANSFER` attempts → Paystack transfer API.
- `FLUTTERWAVE` / `FLUTTERWAVE_TRANSFER` attempts → Flutterwave transfer API.
- `MANUAL_*` attempts have no API verifier — resolve via reconciliation evidence
  (`400 Provider ... does not support transfer verification`).

The raw provider status is classified by `classifyTransferStatus` into the closed set
`SUCCESSFUL | FAILED | PENDING | UNKNOWN | REVERSED`:

- Recognized Paystack statuses: success/successful; pending/otp/processing/queued;
  failed/incorrect_pin/cancelled/banned; reversed. Recognized Flutterwave statuses:
  successful/success; pending/queued/new/processing/in_progress; failed/error/cancelled;
  reversed/reverse_initiated/reversing.
- **Anything unrecognised maps to UNKNOWN — never FAILED.** A transport timeout or HTTP
  error is also UNKNOWN.

Application of the result (`applyProviderVerification`, the only writer of withdrawal
status besides the approval/settlement paths): SUCCESSFUL with matching
amount/currency/destination settles the payout (ledger post, audit
`PAYOUT_SETTLED_PROVIDER_VERIFIED`); authoritative FAILED is the **only** route to
`FAILED` (audit `PAYOUT_ATTEMPT_FAILED_AUTHORITATIVE`); PENDING/UNKNOWN keep the funds
reserved and move the withdrawal to `REQUIRES_RECONCILIATION`; mismatches escalate (see
`docs/FINANCIAL_RECONCILIATION_GUIDE.md`).

## 6. What an administrator can NEVER do

| Attempted action | Result |
| --- | --- |
| Force-fail a PROCESSING/ambiguous transfer by hand | Impossible — the `mark-failed` endpoint was removed; only authoritative provider verification transitions to FAILED |
| Retry a pending/unknown/processing transfer, or retry with an unresolved attempt (`INITIATED`/`PENDING`/`UNKNOWN`) | `409 Retry requires a FAILED withdrawal ... A pending, ambiguous or processing transfer can never be retried.` / `409 An unresolved attempt exists — retry is impossible until it is authoritatively resolved` |
| Approve their own request | `403 The requester of a withdrawal cannot approve it (separation of duties)` |
| Act as both first and second approver | `403 The first approver cannot also be the second approver` |
| Execute as the second approver | `403 The second approver cannot execute the payout (executor separation)` |
| Settle with an unresolved provider transfer outstanding | `409 A provider transfer attempt is unresolved — run verification ... before manual settlement` |
| Settle twice | `409 This withdrawal has already been settled (duplicate payout prevented)` (unique ledger reference `withdrawal:<id>`) |
| Reuse an evidence file on another withdrawal | `409/403 Evidence is bound to a different withdrawal — reuse across withdrawals is not permitted` |
| Use MOCK payouts in production | `403 MOCK payouts are forbidden in production` |
| Reject a transfer that has left APPROVED | `400 Withdrawal can no longer be rejected (already transferring/settled?)` |
| Bypass MFA (Redis down) | `503 MFA verification backend is unavailable — sensitive payout operations are rejected (fail-closed)` |

## 7. Status meanings

| WithdrawalStatus | Meaning |
| --- | --- |
| `PENDING` | Requested, awaiting review. |
| `UNDER_REVIEW` | First administrator is actively reviewing. |
| `REQUIRES_INFORMATION` | Missing info flagged (`:id/require-info`); requester resubmits. |
| `APPROVED` | First approval recorded; awaiting second approval (mode `ALL`). |
| `PROCESSING` | A payout attempt is underway (attempt registry owns it). |
| `PAID` | Settled — provider-verified or manual with evidence; ledger posted. Terminal except verified reversal. |
| `FAILED` | Authoritative terminal provider failure; funds released; eligible for retry. |
| `REQUIRES_RECONCILIATION` | Ambiguous outcome (timeout/unknown/pending/mismatch): funds remain reserved until verification resolves it. |
| `REJECTED` | Terminal administrative rejection pre-transfer. |
| `CANCELLED` | Terminal — requester cancelled while pending. |
| `REVERSED` | Terminal — provider confirmed a reversal of a PAID payout. |

Attempt statuses (`PayoutAttempt`): `INITIATED` → `PENDING`/`SUCCESSFUL`/`FAILED`/`UNKNOWN` (may resolve later); `REVERSED`. `INITIATED`/`PENDING`/`UNKNOWN` are the "unresolved" set that blocks new transfers.

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `403 MFA challenge purpose mismatch ...` / `scope does not match the target resource` | Challenge was issued for a different purpose, or `scope` is not the withdrawal id being acted on — request a new challenge per §2. |
| `403 MFA challenge is invalid or expired` / `was already used` | 120s TTL elapsed or token replayed — mint a fresh challenge. |
| `503 MFA verification backend is unavailable ...` | Redis is down/unreachable — MFA fails closed by design. Check `GET /api/v1/health/redis`, restore `kindora-redis`, then retry. No manual override exists. |
| `403 ForbiddenException` with separation-of-duties text (see §6) | Workflow violation, not a bug: use a different administrator for the role. |
| `409 ... not permitted by the canonical payout state machine` | Transition outside the graph — re-read §4; most cases are "verify before retry/settle". |
| `400 Evidence file security scan has not completed` | Upload earlier and retry after `scanVerdict=CLEAN`. |
| Challenge/`approve` works but settle returns `409` | The second approval may be missing (mode `ALL`) — check `WithdrawalApproval` rows for the current cycle, or the amount changed (new approval cycle required). |
| Verification returns UNKNOWN repeatedly | Provider outage or unrecognised status — do NOT retry the transfer; treat as reconciliation (companion guide §2). |
