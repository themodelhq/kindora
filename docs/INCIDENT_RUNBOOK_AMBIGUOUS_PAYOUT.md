# Incident Runbook — Ambiguous Payout (v1.0.9)

Scenario: KINDORA cannot prove whether a provider executed a payout. This runbook is for on-call operators and reviewers.

## 0. Golden rules

1. An ambiguous outcome is NEVER a failure. Do not mark anything FAILED by hand.
2. Never release the funds reservation while a provider transfer may exist.
3. Never generate or send a "replacement" transfer — the pipeline re-arms the SAME attempt with the SAME reference only after the provider authoritatively says it does not exist.
4. Never settle manually while a provider submission may be in flight — the coordination guard will refuse (409), and that refusal is correct behavior, not a malfunction.

## 1. Identify the case

Signals:

- Withdrawal in `REQUIRES_RECONCILIATION` (or attempt `SUBMISSION_PENDING` / `UNKNOWN` / `MANUAL_REVIEW`).
- Audit events: `PAYOUT_SUBMISSION_AMBIGUOUS`, `PAYOUT_VERIFICATION_PENDING`, `PAYOUT_RECONCILIATION_ESCALATED`, `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE`.
- Attempt/outbox rows: `lastLookupOutcome = AMBIGUOUS | ERROR | NOT_FOUND`.
- Open manual review case (category `PROVIDER_UNKNOWN`, `INTERNAL_STATE_MISMATCH`, `PROVIDER_DATA_INCOMPLETE`, `DUPLICATE_REFERENCE`, …).
- Metrics: `ambiguousLookupOutcomes`, `errorLookupOutcomes`, `submissionAmbiguities`, `unresolvedProviderReferences` (GET /internal/payouts/security-metrics).

## 2. Triage

```sql
SELECT a.id, a.status, a."lastLookupOutcome", a."lastLookupAt", a."providerTransferRef",
       w.status AS withdrawal_status, w.currency, w.amount, a.failure_reason
FROM "PayoutAttempt" a JOIN "Withdrawal" w ON w.id = a."withdrawalId"
WHERE a.status IN ('SUBMISSION_PENDING','UNKNOWN','MANUAL_REVIEW','INITIATED')
ORDER BY a."updatedAt" DESC;
```

Classification:

| `lastLookupOutcome` | Meaning | Next step |
| --- | --- | --- |
| `AMBIGUOUS` | Provider unreachable / rate-limited / malformed | Wait for automatic lookup retries (backoff). If > `PAYOUT_UNKNOWN_ESCALATION_MINUTES` (default 120), the attempt escalates to MANUAL_REVIEW automatically. |
| `ERROR` (401/403) | Credentials/configuration problem | Fix the provider credentials/config FIRST — verification cannot proceed until the API answers. |
| `NOT_FOUND` on an attempt WITH a persisted ref | Provider authoritatively reports the accepted reference missing | The recovery path resolves it (adopt/re-arm). If it persists, treat as a data-consistency case with the provider (§5). |
| `FOUND` | Provider has the transfer | Automatic verification/reconciliation proceeds; if reconciliation blocked the settlement, check the reconciliation row + review case for the precise reason. |

## 3. What the system does automatically (no operator action)

- Lookup retries with bounded exponential backoff (30s → 15min).
- Reconcile-before-resubmit on any expired lease.
- Escalation to a manual review case after the uncertainty window.
- Guard-enforced mutual exclusion of manual/provider settlement (blocked attempts are counted on the guard row).

## 4. Operator actions by case

### 4.1 Provider outage (AMBIGUOUS, ongoing)

1. Confirm the provider status page / support channel.
2. No KINDORA action needed — retries continue. Communicate that the beneficiary payout is DELAYED, not lost: the reservation stays intact.
3. After the provider recovers, verification resolves the outcome automatically; confirm the withdrawal leaves REQUIRES_RECONCILIATION.

### 4.2 Credentials rejected (ERROR 401/403)

1. Rotate/fix the provider API key (deploy config — never in the database).
2. Re-run verification for affected attempts.
3. Review the audit trail for how many attempts were affected during the window.

### 4.3 Provider says NOT_FOUND but we persisted an acceptance (rare, data-consistency)

1. Pull the initiation evidence (attempt evidence + audit `PAYOUT_TRANSFER_ACCEPTED`): the reference/id we persisted and the provider's acceptance response.
2. Ask the provider to search by the EXACT reference (`kdo-...`) and by internal id; ask for their authoritative "not found" response.
3. Do NOT resubmit by hand. If the provider confirms non-existence with a documented response, the recovery path re-arms the same attempt automatically on the next sweep; if the provider cannot answer authoritatively, the case stays in MANUAL_REVIEW until they can.

### 4.4 Reconciliation blocked the settlement (review case open)

1. Read the reconciliation row: `result` + `providerEvidence.approvalCycleInvalidReason` (or mismatch fields).
2. Amount/currency/beneficiary mismatches are provider-data problems — verify the destination with the provider; never "fix" data to force a match.
3. `DUPLICATE_REFERENCE` — the provider reference belongs to another attempt: treat as a possible double-execution; involve engineering before any payout decision.
4. `INTERNAL_STATE_MISMATCH` — an approval-cycle failure at settlement time: the payout MUST NOT settle; restart the approval cycle if approvers/destination changed; the provider outcome is recorded as evidence.

### 4.5 Manual settlement was refused (409)

The refusal IS the control working. Check the message:

- `unresolved` / `pending or in flight` → resolve the provider outcome first (§4.1–4.4).
- `settlement path is active` → another path holds the guard or the withdrawal is already settled; re-check status; never force.

## 5. Escalation to engineering (mandatory for)

- Any suspected duplicate payout at the provider (two references for one logical attempt).
- Any case where the provider reports a transfer we never recorded, or vice versa.
- Any need to modify payout state outside the API (must never happen; corrections go through reviewed engineering changes with audit + ledger adjustments).

## 6. After the incident

1. Confirm final state: withdrawal PAID via verified reconciliation, or FAILED via an authoritative provider failure, or REVERSED via the reversal lifecycle — nothing in between stays unresolved without an OPEN review case.
2. Capture the metrics snapshot + relevant audit events for the post-mortem.
3. Record missing sandbox coverage (if the ambiguity class was provider-specific) in the sandbox verification backlog.

---

## v1.0.10 addendum — pagination-ambiguity cases and the locked executor gate

New AMBIGUOUS classes introduced by the v1.0.10 hardening (all fail closed — no
operator action beyond the standard verification loop):

| Signal | Meaning | Action |
| --- | --- | --- |
| `lastLookupOutcome=AMBIGUOUS` with reason `reference lookup pagination metadata is malformed/internally contradictory/incomplete` | Flutterwave returned an empty or matched list whose pagination metadata could not be trusted (e.g. `{content:[], meta:{total:1}}`). NOT classified as NOT_FOUND — the transfer may exist. | Re-run the verification sweep; if it persists, query the provider dashboard by reference. The reservation stays; no resubmission. |
| `lastLookupOutcome=AMBIGUOUS` with reason `detailed transfer record does not carry the merchant reference` / `reference differs from the requested reference` | The provider returned a transfer whose identity could not be proven to be OURS (id/code-only record or mismatched reference). | Do NOT adopt. Confirm the reference in the provider dashboard; keep the attempt unresolved until identity is proven. |
| `lastLookupOutcome=AMBIGUOUS` with reason `reference lookup found a matching transfer in the list but the detailed lookup reported it absent` | List/detail contradiction — the provider answered inconsistently between its list and detail endpoints. | Treat as existing-until-proven-absent. Re-verify later; never resubmit on this signal. |
| `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE` with `executorId: null` / `invalidReason: …executor…` | The final reconciliation used the LOCKED executor identity; it was missing or collided with requester/approvers — settlement blocked by design. | Investigate who initiated the attempt (`initiatedById`) and why the identity is missing/colliding; this is an authorization incident, not a provider issue. |

Recovery semantics are unchanged: ambiguous outcomes preserve the reservation and
the durable attempt; only an authoritative NOT_FOUND (Paystack documented body /
Flutterwave validated-empty pagination) can re-arm the SAME attempt with the SAME
reference. See `PAYOUT_ARCHITECTURE_V1.0.10.md` §2 and `OUTBOX_RECOVERY_V1.0.10.md`.

## v1.0.11 addendum — pagination integrity and transfer identity lockdown

v1.0.11 tightens WHEN the Flutterwave adapter classifies at all. New AMBIGUOUS
reason strings an operator may now see (all fail closed — reservation kept, no
resubmission, no manual settlement until resolved):

| New signal (adapter reason) | Meaning | Operator action |
|---|---|---|
| `response shape is not verifiable: ... failed pagination validation` | The provider page failed the strict pagination gate: malformed integers, disagreeing aliases (e.g. `current_page` vs `page`), contradictory relationships (records beyond the declared page size, zero results spanning pages, `current_page > total_pages`), truncated page sets, or missing required `total`. Covers BOTH the official `meta.page_info` container and the content-revision containers. | Screenshot/export the raw provider response (sans secrets), open a provider support case with the reference, and re-verify later. Do NOT hand-settle. |
| `the paginated list response carries NO pagination metadata` | A paginated-shaped response arrived without metadata — completeness cannot be established, so a matching reference inside it is NOT adopted (the v1.0.10 gap is closed). | Same as above; expect the attempt to remain unresolved until the provider returns verifiable metadata. |
| `list identity could not be established: ... duplicate provider transfer ids carrying conflicting merchant references` / `... malformed (must be a positive integer)` | The provider's own list content is internally inconsistent or malformed. | Treat as a provider data-integrity incident; escalate to engineering. |
| `the matching list record does not carry a valid transfer id` | The list match has no usable provider id — the list-to-detail identity link cannot be established. | Re-verify later; the pipeline will retry lookups on schedule. |
| `detailed transfer record does not carry a valid transfer id — the list-to-detail transfer identity cannot be established` | The detail response has a matching reference but NO usable transfer id. v1.0.11 makes the detail id MANDATORY (v1.0.10 allowed a missing id to pass). | Never adopt on reference alone. Confirm the transfer id in the provider dashboard and re-verify. |
| `detailed transfer record does not belong to the transfer identified in the list` (with `detailTransferId`) | List id ≠ detail id — contradictory identity evidence. | Record both ids in the incident; contact the provider; keep the reservation. |

The classification gate order is: HTTP result → provider status → response
shape (S1 official paginated array / S2 content revision / S3 legacy complete
array / S4 unsupported) → pagination metadata (MANDATORY for S1/S2) →
authoritative-empty check → list record identity → exact reference match →
list transfer id → detail lookup → exact detail reference → detail id
present + equal to list id → FOUND. See
`PROVIDER_INTEGRATION_V1.0.11.md` §4 and `PAYOUT_ARCHITECTURE_V1.0.10.md` §2.
Recovery semantics are UNCHANGED from v1.0.10: only a genuine authoritative
NOT_FOUND re-arms the SAME attempt with the SAME reference.
