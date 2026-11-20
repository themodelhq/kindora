# KINDORA Manual Settlement Procedures — v1.0.9

v1.0.9 changes the manual settlement workflow to a TWO-STEP protocol. The immutable approval snapshot is mandatory; legacy withdrawals are never grandfathered.

## 1. Prerequisites

- The withdrawal is fully approved: active FIRST + SECOND approval by two distinct administrators, neither being the requester (destination changes bump `destinationVersion` and invalidate the cycle — restart approvals in that case).
- The settling administrator (the executor) is a FOURTH identity, distinct from the requester and both approvers.
- Fresh purpose-bound MFA for every call (`PAYOUT_EXECUTION` for step 1, `PAYOUT_SETTLEMENT` for step 2).
- Evidence: a registered StoredFile — kind `PAYOUT_EVIDENCE`, PRIVATE visibility, scan CLEAN, status APPROVED, uploaded by the settling administrator, not already bound to another withdrawal. Arbitrary URLs are structurally impossible.
- The withdrawal has NO unresolved provider attempt and NO pending/in-flight outbox event (a provider transfer whose outcome is unknown must be verified first — see INCIDENT_RUNBOOK_AMBIGUOUS_PAYOUT.md).

## 2. Step 1 — authorize the manual payout intent

```
POST /api/v1/withdrawals/:id/execute
Authorization: Bearer <executor token>
x-mfa-challenge: <fresh PAYOUT_EXECUTION challenge for THIS withdrawal>
{ "payoutProvider": "MANUAL_BANK_TRANSFER", "note": "offline settlement authorized" }
```

- Channels: `MANUAL_BANK_TRANSFER` | `CASH` | `APPROVED_OFFLINE_CHANNEL` (exact values; API providers and the legacy `MANUAL_BANK` name are rejected).
- Effects (one transaction, withdrawal row locked): four-person separation validated; the immutable manual approval snapshot (withdrawal, requester, amount, currency, destination binding, destination version, channel, MANUAL_SETTLEMENT designation, cycle, both approvers + approval ids + timestamps) is bound onto BOTH approval records; a manual attempt (`INITIATED`) is registered; audit `PAYOUT_MANUAL_INTENT_AUTHORIZED`.
- The intent does NOT move money and does NOT create a provider submission.

## 3. Step 2 — settle with evidence

```
POST /api/v1/withdrawals/:id/settle
Authorization: Bearer <executor token>
x-mfa-challenge: <fresh PAYOUT_SETTLEMENT challenge for THIS withdrawal>
{
  "payoutProvider": "MANUAL_BANK_TRANSFER",
  "providerTransferRef": "<bank reference>",
  "payoutProviderTxnId": "<optional provider txn id>",
  "evidenceFileId": "<stored file id>",
  "note": "paid at the bank branch"
}
```

- The channel must match the authorized intent's channel (the snapshot binds it — a different channel fails snapshot verification).
- All checks run INSIDE the settlement transaction (withdrawal row locked): payable state; no unresolved provider attempts; no pending outbox events; guard claim; approval-cycle validation WITH the required snapshot (constant-time recomputed comparison); the intent attempt exists; executor non-collision; evidence re-validated; approved amount/currency asserted; conditional `PAID`; guard → `SETTLED`; `MANUAL_EVIDENCE_RECORDED` reconciliation row (never MATCHED — manual settlements never manufacture provider verification); exactly-once ledger posting; immutable audit.

## 4. Blocked settlements (what the errors mean)

| Error | Meaning | Remedy |
| --- | --- | --- |
| 400 `approved manual channels` | channel not allowlisted | use exactly one of the three channels |
| 403 `No authorized manual payout intent exists` | settlement attempted without step 1 (or legacy withdrawal) | perform step 1; do NOT attempt to bypass |
| 403 `the approval cycle is invalid — …` | approvals invalidated (destination change / stale binding / snapshot mismatch / separation collision) | restart the approval cycle; never fabricate evidence |
| 409 `A provider transfer attempt is unresolved` | a provider transfer's outcome is not established | verify/reconcile first (see runbook) |
| 409 `A provider submission is pending or in flight` | outbox event pending/in flight | let the pipeline resolve; then settle |
| 409 `A settlement path is active — … coordination guard` | another settlement path holds the guard, or the withdrawal is already settled | check withdrawal status; never retry against SETTLED |
| 409 `already been settled` | ledger uniqueness barrier (defense in depth) | stop — the payout is done |

## 5. Legacy withdrawals (pre-v1.0.9)

Withdrawals whose approvals carry no (or a provider-path) snapshot hash cannot be settled manually. Step 1 binds the snapshot for the CURRENT approval cycle; if the cycle itself is stale/invalid, obtain fresh approvals. Historical approval evidence is never fabricated.

## 6. Audit trail

Every step writes immutable audit events with the full authorization context (actor, channel, snapshot hash, cycle id, requester/first/second/executor ids) — no secrets, no full beneficiary PII. The reconciliation row records `MANUAL_EVIDENCE_RECORDED` with the evidence file id and the snapshot hash.

## 7. Reversal of a manual settlement

Contact engineering with the audit trail. Manual settlements are PAID-state withdrawals; only a verified provider reversal lifecycle changes a PAID withdrawal to REVERSED, and a manual settlement has no provider transfer — corrections are recorded as explicit, approved accounting adjustments by engineering, never by re-running the settlement path.
