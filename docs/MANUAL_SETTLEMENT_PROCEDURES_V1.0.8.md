# KINDORA v1.0.8 — Manual Settlement Procedures

Supersedes the v1.0.7 manual-settlement sections for the allowlist, evidence and transaction-integrity rules. The MFA policy (ADMIN_FRESH_MFA_POLICY.md) and dual-approval policy (DUAL_APPROVAL_SECURITY.md) are unchanged.

---

## 1. Approved manual settlement channels (closed allowlist)

Only these three channels can EVER settle a payout manually. The allowlist is enforced at three independent layers; bypassing any one is not enough:

1. **DTO** — `SettlePayoutDto.payoutProvider` uses `@IsIn(MANUAL_SETTLEMENT_CHANNELS)`; any other value is a 400 before the controller body runs.
2. **Controller** — the route additionally requires the ADMIN role and a fresh `PAYOUT_SETTLEMENT` MFA challenge bound to the withdrawal id.
3. **Service (mandatory)** — `PayoutService.settleManual()` calls `assertManualSettlementChannel()` itself, and the channel is re-checked implicitly by the enum-typed `manualChannel` column.

| Channel | Meaning |
| --- | --- |
| `MANUAL_BANK_TRANSFER` | Funds sent through the organization's bank portal / branch transfer |
| `CASH` | Cash settlement with a signed receipt |
| `APPROVED_OFFLINE_CHANNEL` | Any other channel explicitly approved in the withdrawal's approval record |

REJECTED (with explicit "API settlement provider" errors): `PAYSTACK`, `PAYSTACK_TRANSFER`, `FLUTTERWAVE`, `FLUTTERWAVE_TRANSFER`, `STRIPE`, `PAYPAL`, `MOCK`, the legacy `MANUAL_BANK` name, case variants, whitespace-padded aliases, and every arbitrary string. A manual settlement can never manufacture an API-provider verification result.

Legacy `MANUAL_BANK` rows remain readable (`normalizeLegacyManualChannel`) for retry continuity and list rendering — they are not valid settlement inputs.

## 2. Evidence requirements (v1.0.8 §3.5)

Evidence is an authorized `StoredFile` record — arbitrary external URLs are structurally impossible. The canonical checks (`PayoutEvidenceService.validateEvidenceFile`) run on the controller path AND again inside the settlement transaction:

- file exists, not EXPIRED/FAILED/QUARANTINED/REJECTED (availability);
- scan verdict `CLEAN`, scan completed;
- StoredFile status `APPROVED`;
- visibility `PRIVATE`;
- kind `PAYOUT_EVIDENCE`;
- uploaded by the submitting administrator (the executor);
- bound to exactly THIS withdrawal — a file can be evidence for at most one settlement (unique `evidenceForWithdrawalId`).

## 3. Settlement procedure (executor runbook)

1. Confirm the withdrawal is APPROVED (or PROCESSING/REQUIRES_RECONCILIATION after an authoritative outcome) and the current approval cycle is valid: first + second approvers distinct, requester excluded, approvals bound to the current amount/currency/destinationVersion.
2. Execute the transfer through one of the three approved channels OUTSIDE the API.
3. Scan and upload the receipt (private, PAYOUT_EVIDENCE), wait for scan CLEAN + APPROVED.
4. `POST /api/v1/withdrawals/:id/settle` with fresh `PAYOUT_SETTLEMENT` MFA, `{ payoutProvider, providerTransferRef, payoutProviderTxnId?, evidenceFileId, note? }`.
5. The service, inside ONE transaction: locks the withdrawal → revalidates the approval cycle → validates the evidence → records the attempt (`manualChannel` set) → writes a `MANUAL_EVIDENCE_RECORDED` reconciliation row → posts the ledger exactly once (`withdrawal:<id>`) → writes the immutable audit event `WITHDRAWAL_PAID_MANUAL_SETTLEMENT` (channel, cycle id, snapshot hash, all four identities).

## 4. What the operator sees when settlement is refused

- `"..." is an API settlement provider — it can never be used for manual settlement` — wrong channel; use the API payout execution flow instead.
- `Manual settlement blocked: the approval cycle is invalid — ...` — the cycle was invalidated (material change) or never completed; restart approvals for the current cycle.
- `Evidence file is not APPROVED (current: ...)` — the scan lifecycle has not completed.
- `This withdrawal has already been settled (duplicate payout prevented)` — the exactly-once ledger reference detected a replay (409).

A refused settlement NEVER mutates financial state: every check runs before the first write, and any conditional-update failure aborts the entire transaction.
