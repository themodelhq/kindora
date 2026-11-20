# KINDORA Payout Architecture — v1.0.10

Provider reference integrity, reconciliation lockdown and payout concurrency fixes.
This document describes the v1.0.10 security-hardening release on top of the v1.0.9
payout architecture (`PAYOUT_ARCHITECTURE_V1.0.9.md`). Nothing was redesigned: the
same state machine, coordination guard, outbox pipeline and reconciliation service
carry the fixes. v1.0.10 closes the four findings of the v1.0.9 review.

---

## 1. Exact provider reference identity verification (finding 2)

**Rule: a FOUND lookup result is only authoritative when the provider's own
transfer record carries the EXACT requested merchant reference.** A transfer id,
transfer code or database id is never a substitute for the logical reference in
reference-based recovery.

### Paystack (`paystack-payout.adapter.ts`)

`findTransferByReference(reference)` wraps the strict `getTransfer` classification
with an identity gate:

1. The requested reference is preserved from the beginning of the lookup.
2. `NOT_FOUND / AMBIGUOUS / ERROR` outcomes propagate unchanged.
3. A FOUND record is adopted **only** when the authoritative record's own
   `data.reference` field (exposed as `evidence.reference`) is:
   - present and non-empty — a record with only `transfer_code`/`id` is
     **AMBIGUOUS** (`recordHasTransferCode`/`recordHasTransferId` evidence flags);
   - EXACTLY equal to the requested reference (case-sensitive, deterministic —
     Paystack resolves merchant references verbatim; no normalization, §4.3).
4. A different reference is AMBIGUOUS (identity mismatch), never adopted.

The verification path (`getTransfer` by id/code) is unchanged: an existing transfer
is still positive evidence, and reference *belonging* is enforced downstream by the
reconciliation `REFERENCE_MISMATCH` gate (fail closed).

### Flutterwave (`flutterwave-payout.adapter.ts`)

`findTransferByReference(reference)` performs the reference-filtered list query and:

1. Preserves the original requested reference through every stage.
2. Matches list entries with EXACT string equality (case-sensitive; Flutterwave
   echoes the merchant reference verbatim). More than one entry carrying the same
   reference is unresolved identity → AMBIGUOUS (`matchCount` evidence).
3. Verifies the matched entry through the detailed transfer lookup
   (`GET /v3/transfers/:id`) and adopts the FOUND result **only** when:
   - the detailed record carries the exact requested reference
     (`evidence.reference` present and equal — an id-only record is AMBIGUOUS);
   - the detailed record belongs to the transfer identified in the list
     (`evidence.id === String(listId)` — disagreement is AMBIGUOUS);
   - the detail lookup did NOT contradict the list: a NOT_FOUND detail behind an
     existing list match is a **contradiction → AMBIGUOUS** — it is never
     propagated as NOT_FOUND, because that would authorize a duplicate submission
     while the provider has provably seen the reference.
4. AMBIGUOUS/ERROR detail outcomes propagate unchanged (never collapsed).

### Submission protection (§4.5)

An AMBIGUOUS lookup can never trigger a new transfer submission: the outbox
processor (`payout-initiation.service.ts`) submits only after an authoritative
NOT_FOUND, and the durable idempotency key + provider reference
(`providerSubmissionReference(idempotencyKey)`) are stable across retries — a
replacement reference is never minted.

---

## 2. Flutterwave pagination validation (finding 1)

**An empty list alone must never be treated as proof that a transfer was not
executed.** The reference-filtered list query is the only authoritative
non-existence proof in the Flutterwave v3 API, so its pagination metadata is
validated before any absence conclusion (`isAuthoritativeFlwReferenceNotFound`).

The validator handles both documented response shapes:

- **Plain array** (`data: []`) — a complete non-paginated result set; there is no
  pagination structure that could contradict it → authoritative absence when empty.
- **Paginated shape** (`data: { content: [...], meta: {...} }`) — authoritative
  absence requires ALL of:
  1. `status: "success"`;
  2. a well-formed `content` array that is EMPTY;
  3. pagination metadata that is PRESENT (`meta`, or `meta.pagination` per the v3
     contract) and INTERNALLY CONSISTENT:
     - a provider-supplied result count is REQUIRED — missing count ⇒ INCOMPLETE
       (values are never invented);
     - `total` (aliases `total_count`/`totalCount`/`count` checked defensively)
       must be a finite number; a string or non-numeric total is malformed ⇒
       AMBIGUOUS;
     - `total > 0` with empty content ⇒ AMBIGUOUS (the finding example
       `{content:[], meta:{total:1}}`);
     - contradictory counts (total < returned records, alias disagreement,
       `total > per_page × total_pages`, `current_page > total_pages`) ⇒ AMBIGUOUS;
     - zero totals cannot coexist with pagination implying more pages
       (`current_page > 1` with `total = 0`);
     - a page reporting MORE records than it returned (truncated) ⇒ INCOMPLETE —
       absence cannot be proven from it;
     - missing or malformed `meta` on the paginated shape ⇒ AMBIGUOUS ("required
       pagination fields are unexpectedly missing").

The same consistency gate runs BEFORE any positive adoption in
`findTransferByReference` (§9 matrix: contradictory pagination is AMBIGUOUS in both
directions — even when a matching entry is present). The verdict function is
exported for the unit matrix (`flwPaginationVerdictForTesting`).

### What constitutes authoritative NOT_FOUND (summary)

| Provider | Authoritative NOT_FOUND requires |
| --- | --- |
| Paystack | HTTP 404 + `{ status: false, message: "Transfer not found" }` exactly (no `data`) |
| Flutterwave | HTTP 200 + `status: "success"` + well-formed EMPTY list + validated, internally consistent pagination |

Everything else — 401/403 (ERROR), 429/5xx (AMBIGUOUS), timeouts, connection
resets, malformed JSON, empty bodies, unexpected shapes (AMBIGUOUS) — never proves
non-existence and never arms a resubmission.

---

## 3. Final reconciliation uses the LOCKED executor identity (finding 3)

`payout-reconciliation.service.ts` — the single atomic reconciliation transaction:

1. Locks the withdrawal row (`SELECT ... FOR UPDATE`).
2. Locks the payout attempt row with an EXPLICIT column list that now includes
   `initiatedById` together with `withdrawalId`, `provider`, `providerTransferRef`,
   `idempotencyKey`, `status`, `amount`, `currency`, `beneficiaryId`,
   `reversalState` (v1.0.10 §5.2).
3. Re-proves the authoritative association under the lock: a locked row whose
   `withdrawalId`, `idempotencyKey`, `provider`, `amount` or `currency` diverges
   from the caller's pre-transaction read aborts the reconciliation before any
   write (stale-payload tripwire, §5.5).
4. Passes **`locked.initiatedById`** — the identity read UNDER the row lock — to
   the approval-cycle validator (`requireExecutor: true`). The pre-transaction
   attempt object, a stale worker payload, a cached identity and a caller-supplied
   executor are never used for the final authorization decision (§5.3).
5. A missing locked executor invalidates the cycle → settlement is BLOCKED
   (`PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE` audit event carries
   `executorId: null` and the validator's invalid reason).
6. Four-person separation (requester, first approver, second approver, persisted
   executor — all distinct) is re-proven INSIDE the transaction by
   `PayoutApprovalCycleService.validate` against the authoritative rows; any
   collision blocks settlement.
7. Every post-lock use of the provider identity reads `locked.provider` (evidence
   rows, audit events, withdrawal settlement, reversal lifecycle) — the locked
   records are the source of truth.
8. The `PAYOUT_SETTLED_PROVIDER_VERIFIED` audit event records
   `executorId: locked.initiatedById`, proving the locked identity authorized the
   settlement.

---

## 4. Manual settlement / provider submission coordination (§7 — verified)

The v1.0.9 coordination mechanism was audited and is UNCHANGED (no race found):

- **One durable boundary.** `PayoutSettlementGuard` (one row per withdrawal,
  `withdrawalId` UNIQUE) is the single arbitration point. Manual settlement and
  provider submission claim it with atomic conditional `UPDATE`s:
  - `claimManualSettlementGuard` — `MANUAL_SETTLEMENT_ACTIVE`, succeeds only from
    `IDLE` or an EXPIRED provider lease;
  - `claimSubmissionGuard` — `PROVIDER_SUBMISSION_ACTIVE` with a lease, claimed in
    the SAME transaction that revalidates the approval cycle under the withdrawal
    row lock.
- **PostgreSQL-only.** Redis is never consulted for financial correctness. No
  PostgreSQL transaction is held open during an external provider HTTP call: the
  guard is claimed and committed, the provider request runs transaction-free, and
  the outcome (acceptance / SUBMISSION_PENDING / definite rejection) is persisted
  in its own locking transaction.
- **In-lock rechecks.** `settleManual` re-checks unresolved provider attempts and
  pending/in-flight outbox events UNDER the withdrawal row lock (the v1.0.8
  TOCTOU fix); the submission path revalidates the full approval cycle under the
  same lock.
- **Leases.** An expired provider lease NEVER releases the unresolved state: the
  reclaim path performs the provider-reference lookup FIRST (reconcile-before-
  resubmit). Manual settlement stays blocked while any attempt is unresolved —
  `SUBMISSION_PENDING` and `UNKNOWN` are unresolved states.
- **Terminal state.** Settlement (provider-verified or manual) marks the guard
  `SETTLED` — no future claim can ever succeed.

---

## 5. The corrected concurrency proof (finding 4)

The v1.0.9 `§3.2/§12.5` test was RETIRED (§6.1): it called `settleManual()`
directly without an authorized manual intent and had no controlled provider delay,
so it only proved the rejection of an INVALID manual attempt. The replacement suite
(`test/payout-lockdown.e2e-spec.ts`, v1.0.10 §6.3–§6.9) runs on REAL PostgreSQL 17
+ Redis 7.2.5 with a deterministic mock provider:

- **Deterministic barriers.** The mock adapter can HOLD a transfer request at the
  provider boundary behind a deferred promise (`setInitiationHold(armed,
  { reference })` — scoped to the exact logical payout), signal the exact moment
  the request reaches the boundary (`onInitiationHeld`), and complete it
  deterministically (`releaseHeldInitiation('accept' | 'reject' | 'timeout' |
  'connection-lost')`). Duplicate-reference submissions are rejected with a
  transport error (mirroring real provider behaviour). No arbitrary sleeps.
- **Durable assertions.** Scenarios assert final withdrawal status, attempt
  status, lease/guard state, provider request count (`initiationCount`),
  provider reference existence (`hasTransfer`), settlement records, ledger entry
  count (exactly one), the amount in minor units and the audit trail — using
  bounded condition waits on the DATABASE state, never on caller identity (the
  1s outbox sweeper may legitimately win a lease race; the durable outcome is
  identical).

| Scenario | Proves |
| --- | --- |
| A (§6.3) | An authorized manual-settlement intent and an API provider initiation race — exactly ONE path acquires the settlement/submission right; the loser is rejected; zero ledger entries. |
| B (§6.4) | Provider request held in flight → durable submission state active → manual settlement through the AUTHORIZED workflow is 409-blocked → provider release → reconcile → the provider payout is the ONLY settlement. |
| C (§6.5) | Authorized manual intent wins FIRST → provider initiation cannot obtain submission authorization (fail-closed 409, zero provider artifacts) → manual settlement completes → outbox worker cannot submit → exactly one settlement. |
| D (§6.6) | Provider ACCEPTED, worker crashed before persisting (both leases expired) → recovery adopts the ORIGINAL exact-reference transfer → never submits twice → one settlement. |
| E (§6.7) | Ambiguous/error lookups (401/403/429/500/timeout/malformed/identity-mismatch classes) preserve the reservation, block manual settlement, forbid resubmission; once lookups recover the original transfer is reconciled — one settlement. |
| F (§6.8) | Lease expiry while the request is in flight → recovery reconciles (never assumes failure) → manual settlement blocked throughout → no second submission possible → one settlement. |
| G (§6.9) | Duplicate workers on the same outbox item → one authoritative claim (the loser `LOOKUP_PENDING`) → one provider request → repeated reconciliation posts ONE ledger entry. |

For every logical withdrawal: **at most one successful payout settlement and at
most one corresponding payout ledger posting.**

---

## 6. Outcome model (§8) and regression matrix (§9)

The four-valued outcome contract is unchanged (`FOUND | NOT_FOUND | AMBIGUOUS |
ERROR`) and is now unit-proven for both adapters against realistic provider
fixtures (`payout-adapters-v110.spec.ts`, `payout-lookup-classification.spec.ts`):
exact reference found (FOUND), different/missing/null/empty reference
(AMBIGUOUS), transfer-id-only records (AMBIGUOUS), list/detail reference or id
disagreement (AMBIGUOUS), duplicate matching references (AMBIGUOUS), documented
authoritative absence (NOT_FOUND), 401/403 (ERROR), 404-with-documented-body
(NOT_FOUND — Paystack only), 404-unknown (AMBIGUOUS), 429/500 (AMBIGUOUS),
timeout/reset (AMBIGUOUS), empty/malformed bodies (AMBIGUOUS), unexpected status
(ERROR), contradictory pagination (AMBIGUOUS).

One v1.0.9 expectation was CORRECTED (not weakened): an empty paginated list
WITHOUT pagination metadata was accepted as authoritative absence in v1.0.9; the
v1.0.10 contract requires validated, consistent metadata — that case is now
AMBIGUOUS, with the consistent-zero-total case explicitly NOT_FOUND.

---

## 7. Financial state and reservation guarantees (§10)

- Ambiguous provider outcomes preserve the reservation (withdrawal stays
  `PROCESSING`; the attempt stays unresolved).
- Lookup failures never mark withdrawals failed; worker crashes never release
  unresolved reservations; lease expiration never authorizes automatic
  resubmission (lookup-first recovery).
- Manual settlement cannot compete with an unresolved provider attempt;
  reconciliation is idempotent (replay = `MATCHED`, `applied=false`); ledger
  posting is exactly-once via the unique ledger reference; provider references
  remain UNIQUE (`providerTransferRef @unique`).
- Reversals remain a separate lifecycle (never an ordinary failure); duplicate
  webhook deliveries and repeated recovery jobs cannot create additional ledger
  postings; stale workers cannot overwrite newer payout states (in-lock tripwires
  abort divergent rows).
- Money stays in integer minor units (BigInt) — no floating point anywhere.
- No schema change was required for v1.0.10; migrations 0001–0006 are unchanged
  (fresh `migrate deploy` verified; `prisma migrate diff` reports no drift).
