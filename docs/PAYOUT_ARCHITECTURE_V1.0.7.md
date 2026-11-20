# KINDORA Payout Execution Architecture — v1.0.7

**Release:** KINDORA v1.0.7_SECURITY_COMPLETE (targeted payout execution integrity upgrade)
**Baseline:** KINDORA v1.0.6
**Scope:** the money-leaving path (provider payouts), from administrator approval to verified settlement.

This document describes the payout execution architecture implemented in v1.0.7 under
`backend/src/payouts/`, `backend/src/withdrawals/`, `backend/src/internal/`, `workers/src/`
and the admin surfaces in `frontend/src/`. Donation checkout (`backend/src/payments/`) is a
separate concern and is unchanged.

Related: [PROVIDER_INTEGRATION_V1.0.7.md](PROVIDER_INTEGRATION_V1.0.7.md) |
[MANUAL_REVIEW_PROCEDURES_V1.0.7.md](MANUAL_REVIEW_PROCEDURES_V1.0.7.md) |
[KINDORA_v1.0.7_RELEASE_NOTES.md](KINDORA_v1.0.7_RELEASE_NOTES.md) |
[KINDORA_v1.0.7_TEST_REPORT.md](KINDORA_v1.0.7_TEST_REPORT.md) |
[PAYOUT_STATE_MACHINE_V1.0.4.md](PAYOUT_STATE_MACHINE_V1.0.4.md)

---

## 1. Design principles

1. **Fail closed.** Missing, ambiguous or unparseable provider evidence can never settle a
   payout. Unknown is never FAILED. A settlement requires complete, matching, provider-sourced
   evidence.
2. **Single owner of the state machine.** Every withdrawal and attempt transition is expressed
   through `assertTransition` / `assertAttemptTransition` (`payout-state-machine.ts`) inside
   the backend payout services. Workers never write financial state; they only trigger
   backend endpoints.
3. **Durable intent before any provider call.** The attempt + outbox intent is committed in
   one PostgreSQL transaction before the provider transfer API is ever called. No database
   transaction is held open across a provider HTTP call.
4. **Ambiguity is never retried blindly.** A timeout, HTTP 5xx or lost response after a
   submission is reported as possibly-created; the provider is queried for the existing
   transfer instead of re-submitting.
5. **Verification is authoritative.** Settlement decisions are derived from a fresh,
   read-only fetch of the provider transfer API. Webhooks only trigger verification.
6. **Honest provider support.** Providers without a real payout implementation (Stripe,
   PayPal in v1.0.7) are explicit rejectors, never silently routed through another
   provider's verification logic.

## 2. New data model (migration `0004_payout_execution_integrity`)

| Object | Purpose |
| --- | --- |
| `PayoutBeneficiary` | Provider-validated beneficiary identity per `(withdrawalId, provider, destinationVersion)` (unique). Carries `externalRef` (provider-native identity), `fingerprint`, masked details, status (`VALIDATING/ACTIVE/RETIRED/INVALIDATED`). |
| `PayoutOutbox` | Durable submission intent, 1:1 with `PayoutAttempt` (`attemptId` unique, `idempotencyKey` unique). Statuses `PENDING/IN_FLIGHT/SUBMITTED/FAILED_PERMANENT/EXHAUSTED`; conditional claim fields (`claimedAt`, `claimedBy`, `nextRunAt`). |
| `PayoutVerificationEvidence` | One immutable row per provider verification pass (source, raw status, classification, amount, currency, beneficiary ref, `evidenceHash`, sanitized payload). |
| `ManualReviewCase` | Escalation case with category, open/resolve lifecycle, resolution type, reviewer binding, `mfaPurposeUsed`. |
| `Withdrawal.destinationVersion` | Integer (default 1) bumped on every destination change; approvals and beneficiaries bind to it. |
| `WithdrawalApproval.destinationVersionAtApproval`, `.snapshotHash` | Approval-time binding of destination version + canonical approval snapshot hash. |
| `PayoutAttempt.providerTransferId`, `.requestFingerprint`, `.beneficiaryId` | Provider transfer id, unique request fingerprint, FK to the validated beneficiary. |
| Enum extensions | `PayoutAttemptStatus` += `SUBMISSION_PENDING`, `PROVIDER_ACCEPTED`, `MANUAL_REVIEW`. `ReconciliationResult` += `PROVIDER_REVERSED`, `REFERENCE_MISMATCH`, `INTERNAL_STATE_MISMATCH`, `PROVIDER_DATA_INCOMPLETE`, `MANUAL_REVIEW_REQUIRED`. |
| Immutability triggers | Database-level blocks: UPDATE/DELETE on `PayoutReconciliation` and `PayoutVerificationEvidence`; DELETE on `PayoutAttempt`, `WithdrawalApproval`, `PayoutOutbox`, `ManualReviewCase`, `PayoutBeneficiary`. |

The migration was generated and reviewed but **was NOT executed against a real PostgreSQL
instance** in the release sandbox (no database service is available there). Schema-level
validation was done via `prisma validate` only. See the release notes for the migration
procedure and the test report for the honest verification status.

## 3. Withdrawal state machine

Canonical graph (`payout-state-machine.ts`); every other edge is rejected with 409:

```
PENDING ──> UNDER_REVIEW ──> APPROVED ──> PROCESSING ──> PAID ──> REVERSED
   │  │            │            │            │  │  │              (terminal)
   │  │            │            │            │  │  └─> REVERSED
   │  │            │            │            │  └─> REQUIRES_RECONCILIATION
   │  │            │            │            └─> FAILED        (authoritative failure only)
   │  │            │            └─> REJECTED
   │  └─> REQUIRES_INFORMATION ──> UNDER_REVIEW / APPROVED / REJECTED / CANCELLED
   └─> CANCELLED

REQUIRES_RECONCILIATION ──> PAID     (verified successful transfer)
REQUIRES_RECONCILIATION ──> FAILED   (verified terminal failure)
REQUIRES_RECONCILIATION ──> REJECTED
FAILED ──> PROCESSING                (authorized retry: new attempt, rules re-checked)
APPROVED ──> PAID                    (manual settlement path: evidence + dual approval + MFA)
```

Critical invariants:

- `PROCESSING -> FAILED` is reachable ONLY through an authoritative provider failure applied
  by the atomic reconciliation service. No administrator, worker or webhook can force it.
- `PAID` is terminal except for a verified provider reversal (`REVERSED`).
- A withdrawal with an unresolved attempt (`INITIATED`, `SUBMISSION_PENDING`,
  `PROVIDER_ACCEPTED`, `PENDING`, `UNKNOWN`, `MANUAL_REVIEW`) can never start a new transfer.
- Terminal states (`REJECTED`, `CANCELLED`, `REVERSED`) have no outgoing edges.

## 4. Payout attempt state machine

| State | Meaning | Permitted successors |
| --- | --- | --- |
| `INITIATED` | Intent committed locally (attempt + outbox), not yet submitted. | `SUBMISSION_PENDING`, `PROVIDER_ACCEPTED`, `PENDING`, `FAILED`, `UNKNOWN`, `MANUAL_REVIEW` |
| `SUBMISSION_PENDING` | Submission was AMBIGUOUS (timeout/5xx/lost response): the transfer MAY exist. Re-submission is forbidden. | `PROVIDER_ACCEPTED`, `PENDING`, `SUCCESSFUL`, `FAILED`, `UNKNOWN`, `MANUAL_REVIEW` |
| `PROVIDER_ACCEPTED` | Provider accepted/registered the transfer; provider identity persisted. | `PENDING`, `SUCCESSFUL`, `FAILED`, `UNKNOWN`, `REVERSED`, `MANUAL_REVIEW` |
| `PENDING` | Provider reports the transfer in progress. | `SUCCESSFUL`, `FAILED`, `UNKNOWN`, `REVERSED`, `MANUAL_REVIEW` |
| `SUCCESSFUL` | Authoritative verified settlement (exactly once). | `REVERSED` |
| `FAILED` | Authoritative terminal failure (definite 4xx rejection or verified provider failure). | (terminal) |
| `UNKNOWN` | Verification could not classify the transfer. | `SUCCESSFUL`, `FAILED`, `PENDING`, `REVERSED`, `MANUAL_REVIEW` |
| `MANUAL_REVIEW` | Escalated to a controlled manual review case. | `SUCCESSFUL`, `FAILED`, `UNKNOWN`, `REVERSED` |
| `REVERSED` | Verified provider reversal. | (terminal) |

`SUBMISSION_PENDING` has no edge back to `INITIATED`: an ambiguous submission can only be
resolved through provider lookup (`findTransferByReference`) or manual review — never by
sending the money request again.

## 5. End-to-end sequence

```
 Admin A            Admin B            Admin E (executor)
    │ approve (MFA PAYOUT_FIRST_APPROVAL)      │
    │────────────►  WithdrawalApproval(FIRST_APPROVER, amount/currency/destinationVersion bound)
    │                second-approval (MFA PAYOUT_SECOND_APPROVAL)
    │                first-approval row SELECT ... FOR UPDATE inside the same transaction
    │                WithdrawalApproval(SECOND_APPROVER)
    ▼
 Admin E: POST /withdrawals/:id/execute  (fresh MFA PAYOUT_EXECUTION)
    │
    ▼
 PayoutInitiationService.initiate()
    1. registry.require(provider)         -- Stripe/PayPal rejected here, honestly
    2. executor separation matrix          -- BEFORE any external call
    3. beneficiary resolution              -- provider call OUTSIDE any transaction
    4. snapshot binding (hash verify)
    5. ONE transaction: lock withdrawal (FOR UPDATE) -> re-validate approvals ->
       APPROVED/FAILED => PROCESSING -> create PayoutAttempt(INITIATED) +
       PayoutOutbox(PENDING) -> bind snapshotHash onto approvals -> audit
    6. after commit: enqueue payouts.submit-outbox (BullMQ; optional)
    ▼
 submitOutbox(attemptId)   [worker job, or in-process sweeper if Redis is down]
    1. durable conditional claim: PayoutOutbox PENDING -> IN_FLIGHT (nextRunAt due)
    2. crash recovery: attempt already carries provider identity => never resubmit
    3. state re-validation under FOR UPDATE (withdrawal + attempt + approvals + beneficiary)
    4. provider initiateTransfer()          -- the ONLY provider money call
       ├─ success          => PROVIDER_ACCEPTED/PENDING + outbox SUBMITTED -> verify
       ├─ 4xx rejection    => attempt FAILED + withdrawal FAILED (only initiation route to FAILED)
       └─ timeout/5xx/lost => SUBMISSION_PENDING (ambiguous) -> provider lookup loop
    ▼
 PayoutVerificationService.verifyAttempt()   [webhooks only TRIGGER this]
    1. fresh read-only GET of the transfer from the provider API
    2. classifyTransferStatus => SUCCESSFUL / FAILED / PENDING / UNKNOWN / REVERSED
    ▼
 PayoutReconciliationService.apply()   -- ONE transaction for EVERY outcome
    1. lock withdrawal + attempt (FOR UPDATE)
    2. validate attempt<->withdrawal relation and the approval cycle
    3. evaluateReconciliation (fail closed)
    4. persist PayoutVerificationEvidence + PayoutReconciliation (immutable)
    5. attempt transition + withdrawal transition (conditional updates)
    6. ledger posting exactly once (unique reference withdrawal:<id>)
    7. audit event
    ▼
 PAID (PROVIDER_SUCCESS_INTERNAL_PENDING)  |  FAILED  |  REQUIRES_RECONCILIATION
       + manual review case for every non-settlable mismatch/incomplete outcome
```

The full path from execute to PAID involves at most two provider interactions the executor
never sees directly: beneficiary validation and the transfer call. The executor can never
choose an amount, currency or destination at execution time — everything comes from the
approval-bound snapshot.

## 6. Idempotency identities

These identifiers exist for different purposes and are NEVER interchangeable:

| Identity | Example shape | Where created | Where stored | Purpose |
| --- | --- | --- | --- | --- |
| Internal attempt id | cuid (`PayoutAttempt.id`) | intent transaction | `PayoutAttempt.id` | internal FK/lookup target |
| Idempotency key | `payout:<withdrawalId>:<attemptNo>` | intent transaction | `PayoutAttempt.idempotencyKey`, `PayoutOutbox.idempotencyKey` (unique) | correlates attempt + outbox; deterministic attempt numbering |
| Provider submission reference | `kdo-<sanitized idempotency key>` (lowercase `[a-z0-9-_]`, >=16 chars for Paystack) | derived 1:1 from the idempotency key by `providerSubmissionReference()` | `PayoutOutbox.payload.providerReference` | the reference SENT to the provider; reconstructable from the key for ambiguity lookup |
| Provider transfer ref | provider-returned `reference` (or `transfer_code` echo) | provider response | `PayoutAttempt.providerTransferRef`, `Withdrawal.providerTransferRef` | primary verification lookup key |
| Provider transfer id | Paystack `data.id` / Flutterwave `data.id` (stringified) | provider response | `PayoutAttempt.providerTransferId` (indexed) | fallback verification lookup key |
| Beneficiary externalRef | Paystack `recipient_code`; Flutterwave `flw-bank:<hash>` / `flw-mm:<hash>` | beneficiary resolution | `PayoutBeneficiary.externalRef` | the ONLY beneficiary identity compared against provider verification data |
| Request fingerprint | SHA-256 over key/provider/amount/currency/destVersion/beneficiary | intent transaction | `PayoutAttempt.requestFingerprint` (unique) | detects duplicate intents; outbox carries a copy |
| Ledger settlement reference | `withdrawal:<id>` | settlement | ledger transaction reference (unique) | makes double settlement a DB-level conflict |

The destination JSON hash (`destinationRef`) is retained for audit history only and is NEVER
compared against provider responses.

## 7. Beneficiary identity model

- Resolution happens via `PayoutBeneficiaryService.ensureBeneficiary` BEFORE the intent is
  committed; a provider failure aborts initiation before any intent row exists.
- Identity is provider-specific (see [PROVIDER_INTEGRATION_V1.0.7.md](PROVIDER_INTEGRATION_V1.0.7.md)):
  Paystack = `recipient_code` from `POST /transferrecipient`; Flutterwave = normalized
  `bank:account:name` fingerprint (Flutterwave has no stored recipient record).
- A beneficiary row is bound to `(withdrawalId, provider, destinationVersion)`. A destination
  change bumps the version, so a stale recipient can never be reused for a changed
  destination.
- Verification compares the provider-reported beneficiary evidence against the attempt's
  bound `externalRef` — never against the local destination JSON hash.

## 8. Outbox and crash recovery

- `PayoutOutbox` is committed in the SAME transaction as the attempt: a crash after the
  provider call but before bookkeeping can never lose or duplicate the intent.
- Submission uses a durable conditional claim (`UPDATE ... WHERE status='PENDING' AND
  nextRunAt <= now`): with N API instances, workers and the sweeper firing concurrently,
  exactly one claim wins; the losers become no-ops.
- Backoff: `30s * 2^n`, capped at 15 minutes, with jitter. `FAILED_PERMANENT` and
  `EXHAUSTED` intents are never retried.
- Crash recovery rule: if the attempt already carries a provider identity
  (`providerTransferRef` or `providerTransferId`), the submission path NEVER re-sends the
  transfer — it drives verification instead.
- In-process sweeper (`payout-outbox.sweeper.ts`): every `PAYOUT_OUTBOX_SWEEP_SECONDS`
  (default 30, minimum 5 or disabled) the API process runs `recoverySweep()`: due outbox
  submissions, verification passes for accepted transfers not verified within 5 minutes, and
  escalation of stale unknowns. This is the crash-recovery floor for deployments without
  Redis or workers.
- Workers accelerate the same work through the `payouts` BullMQ queue; they hold no
  financial logic (Section 12).

## 9. Ambiguity handling and escalation windows

- Any `PayoutTransportError` from initiation (timeout, network failure, HTTP 5xx, unparseable
  response, duplicate-reference error) puts the attempt into `SUBMISSION_PENDING` and the
  outbox back to `PENDING` with backoff. The next submission pass performs
  `findTransferByReference`:
  - transfer found => `PROVIDER_ACCEPTED`/`PENDING` with the recovered identity -> verification;
  - not found => wait and re-look-up (never re-submit);
  - unresolved beyond `PAYOUT_UNKNOWN_ESCALATION_MINUTES` (default 120) => attempt
    `MANUAL_REVIEW`, outbox `EXHAUSTED`, manual review case `PROVIDER_UNKNOWN` opened.
- Definite 4xx rejections (`PayoutProviderRejectedError`) are the ONLY initiation-phase route
  to `FAILED`: attempt `FAILED`, withdrawal `FAILED`, outbox `FAILED_PERMANENT`. v1.0.7
  replaces any silent escalation of these states with a visible manual review case.

## 10. Executor separation and approval snapshot binding

Enforced BEFORE any external provider call (beneficiary resolution included) and re-validated
inside the intent transaction under `SELECT ... FOR UPDATE`:

| Rule | Error |
| --- | --- |
| executor != requester | 403 |
| executor != first approver | 403 |
| executor != second approver | 403 |
| first approver != second approver | 403 |
| requester != first approver | 403 |
| requester != second approver | 403 |
| active FIRST_APPROVER + SECOND_APPROVER rows exist | 403 |
| amount + currency still match at approval | 409 |
| approvals bound to the CURRENT `destinationVersion` | 409 |
| stored `snapshotHash` (if present) equals the recomputed hash | 409 |

The snapshot hash is SHA-256 over `withdrawal | amount | currency | destV | provider |
beneficiary | requester | first | second | cycle`. `approve()` and `secondApproval()` now
SELECT the authoritative withdrawal (and, for the second approval, the first approval row)
`FOR UPDATE` INSIDE their transactions and return the committed record — the v1.0.6
stale-approval race (§10) is closed. Dual approval now also binds
`destinationVersionAtApproval`; changing the destination invalidates the approval cycle.

## 11. Destination changes (§5.4)

`POST /withdrawals/:id/destination` (requester or admin) runs one transaction that:

1. bumps `destinationVersion` and `approvalCycle`;
2. retires all `ACTIVE` `PayoutBeneficiary` rows (`INVALIDATED`);
3. invalidates all `ACTIVE` approvals of the current cycle;
4. writes an audit event.

It is refused with 409 once a transfer has been initiated (statuses beyond `APPROVED`).
Defensive check: if destination content changed without a version bump, beneficiary reuse
fails closed.

## 12. Workers, cron and internal ingest endpoints

- New `payouts` BullMQ queue with handlers `payouts.submit-outbox`, `payouts.verify-attempt`,
  `payouts.recovery` (`workers/src/processors/payouts.processor.ts`). Every handler is a
  THIN TRIGGER: it POSTs to the backend internal endpoints
  (`POST /api/v1/internal/payouts/outbox/submit`, `/attempts/verify`, `/recovery-sweep`,
  `/escalate-unknowns`) with the `x-worker-token` header (`WORKER_INGEST_TOKEN`) and lets
  BullMQ retry with exponential backoff. A worker interval producer enqueues a recovery pass
  every 5 minutes.
- The internal controller fails CLOSED: without a configured token every ingest request gets
  503 (token comparison is constant-time). Financial logic lives entirely in
  `InternalPayoutsModule`-imported backend services.
- `workers/src/cron/payout-recovery.ts` (`npm run cron:payout-recovery`) is a Redis-locked
  cron trigger for the same recovery sweep. Without `WORKER_INGEST_TOKEN` it exits 0 with a
  warning (the in-process sweeper owns recovery).

## 13. Webhook handling

- Paystack `transfer.success`, `transfer.failed`, `transfer.reversed` and Flutterwave
  `transfer.completed`, `transfer.failed`, `transfer.reversed` are classified
  `PAYOUT_TRANSFER` by the existing signed-webhook pipeline (`event-classification.ts`).
- The handler records the signed event and then TRIGGERS verification
  (`PayoutVerificationService.verifyFromWebhook`), which re-fetches the transfer from the
  provider API. The webhook payload is evidence only — it NEVER settles a payout by itself.
- Out-of-order or late events are safe: verification always derives the current state, and
  the reconciliation service's conditional transitions prevent regression of a newer
  authoritative state.
- Stripe/PayPal accept no payout transfer events (payouts are disabled / not implemented).

## 14. Fail-closed verification rules

Before a withdrawal can be marked PAID, verification independently establishes: the transfer
exists; the provider reference belongs to this attempt; a successful terminal state; the
exact approved amount (integer minor units); the exact approved currency (case-insensitive
exact match, never converted); the approved beneficiary identity (provider evidence vs the
bound `externalRef`); a valid approval cycle; and no prior settlement. Comparison semantics:

| Field | Comparison |
| --- | --- |
| Amount | integer minor units (`bigint`), exact equality |
| Currency | case-insensitive exact string match; no silent conversion |
| Beneficiary | provider `externalRef` (recipient code / FLW fingerprint) equality — NEVER the destination JSON hash |
| Reference | provider-returned reference must belong to this attempt (`REFERENCE_MISMATCH` otherwise) |
| Uniqueness | a provider reference bound to another attempt is `DUPLICATE_REFERENCE` |

Consequences (all applied by the atomic reconciliation service):

- Missing amount, currency or beneficiary evidence on an otherwise-successful transfer =>
  `PROVIDER_DATA_INCOMPLETE` => fail closed => `MANUAL_REVIEW` case. Missing evidence on an
  authoritative terminal FAILURE does not block the failure (no beneficiary proof is needed
  to accept a failure).
- Any mismatch (`AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DESTINATION_MISMATCH`,
  `REFERENCE_MISMATCH`, `DUPLICATE_REFERENCE`) => never settles, reservation intact, manual
  review case opened.
- Unknown classification or transport failure during verification => `UNKNOWN` /
  `PROVIDER_UNAVAILABLE`, withdrawal moves `PROCESSING -> REQUIRES_RECONCILIATION`
  (reservation held); NEVER `FAILED`.
- Verified reversal => recorded separately (`PROVIDER_REVERSED`); a `PAID` withdrawal moves
  to `REVERSED` for an auditable recovery decision — reversal is never an ordinary failure.
- Ledger posting is exactly once via the unique `withdrawal:<id>` reference; a duplicate
  settlement is a database-level conflict.
- `PROCESSING` payouts that cannot be verified KEEP `REQUIRES_RECONCILIATION` instead of
  being silently auto-moved; every blocked automatic settlement opens a manual review case.

## 15. Manual review

Escalating outcomes open `ManualReviewCase` rows (idempotent — one OPEN case per attempt)
with categories: `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `BENEFICIARY_MISMATCH`,
`REFERENCE_MISMATCH`, `DUPLICATE_REFERENCE`, `PROVIDER_REVERSAL`, `INTERNAL_STATE_MISMATCH`,
`PROVIDER_DATA_INCOMPLETE`, `PROVIDER_UNKNOWN`, `PROVIDER_PENDING`, `PROVIDER_UNAVAILABLE`,
`PROVIDER_SUCCESS_INSUFFICIENT_BENEFICIARY_EVIDENCE`, `STUCK_OUTBOX_EVENT`. Resolution types:
`RETURN_TO_VERIFICATION`, `CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE`,
`RECORD_REVERSAL_DECISION`, `NO_INTERNAL_CHANGE`.

Hard rules: resolution requires ADMIN + fresh purpose-bound MFA (`PAYOUT_MANUAL_REVIEW`);
`CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE` additionally requires a registered private evidence
file AND an independent reviewer (a second, distinct administrator) — and it NEVER settles
the payout: the withdrawal stays `REQUIRES_RECONCILIATION` and settlement still requires
authoritative provider verification or the separate manual-settlement path (evidence file +
dual approval + `PAYOUT_SETTLEMENT` MFA). Review can never manufacture a settlement by
entering a reference. Cases are never deleted (DB trigger). Operational procedures:
[MANUAL_REVIEW_PROCEDURES_V1.0.7.md](MANUAL_REVIEW_PROCEDURES_V1.0.7.md).

## 16. Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PAYOUT_SUPPORTED_PROVIDERS` | `PAYSTACK,FLUTTERWAVE` | Active payout provider set. Production startup validation refuses to start when it names unimplemented providers or lacks the matching secret keys. |
| `PAYOUT_UNKNOWN_ESCALATION_MINUTES` | `120` | How long `SUBMISSION_PENDING`/`UNKNOWN` may stay unresolved before escalating to `MANUAL_REVIEW`. |
| `PAYOUT_OUTBOX_SWEEP_SECONDS` | `30` | In-process sweeper interval; values below 5 disable the sweeper. |
| `WORKER_INGEST_TOKEN` | *(unset)* | Shared secret for worker -> backend internal ingest; unset means the internal surface is closed (503) and the sweeper owns recovery. |

## 17. Verification status (honest)

| Area | Status |
| --- | --- |
| State machines, initiation pipeline, adapters, atomic reconciliation, manual review, sweeper | Implemented and covered by backend unit tests executed with jest and mocked Prisma/providers: 255 tests / 16 suites passed, including the five payout suites listed in the test report. |
| Backend `tsc --noEmit`, `nest build`; workers `tsc --noEmit`; frontend `tsc --noEmit` + `vite build` | PASS (executed in the release sandbox). |
| Frontend vitest | 52 tests passed. |
| Migration `0004_payout_execution_integrity` against a real PostgreSQL instance | **NOT RUN** — the sandbox has no PostgreSQL. Schema validated via `prisma validate` only. |
| Provider sandbox execution (Paystack / Flutterwave test keys) | **NOT RUN / BLOCKED** — no provider credentials exist in the sandbox. No transfer IDs or references were observed or invented. |
| Database-level behaviors (immutability triggers, unique-index conflicts, `FOR UPDATE` concurrency) | **NOT RUN** — require a real PostgreSQL instance. |
| Multi-instance concurrency of the outbox claim on real infrastructure | **NOT RUN** — covered at unit level with mocked concurrency only. |
| Deployment | This release is **not deployed**. Classification: STAGING READY — see the release notes. |
