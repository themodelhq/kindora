# KINDORA — Final Engineering Report v1.0.10

**Provider Reference Integrity, Reconciliation Lockdown & Payout Concurrency Fixes**
Date: 2026-11-15 · Source tree: `kindora-v110/kindora` (git commits `07d1147` baseline → `303bbbc` build → packaging)

## A. Release summary

| Item | Value |
| --- | --- |
| Original version | v1.0.9 (`KINDORA_v1.0.9_SECURITY_COMPLETE.zip`, SHA-256 `6bc603cb42ab334cbe2fbb95ff0e18bceca964ea0227221cb4b8f45471b39d1b` per its external checksum file) |
| Final version | **v1.0.10** |
| Release classification | **STAGING READY** — source corrections implemented; 438 unit + 63 real-PostgreSQL/Redis integration + 53 frontend tests pass; builds and migration checks pass; no known critical source-level payout defect remains; external provider sandbox verification BLOCKED (no credentials). NOT PRODUCTION CANDIDATE by rule §18. |
| Main corrections | (1) Flutterwave authoritative-NOT_FOUND requires validated pagination metadata; (2) exact requested-reference identity verification on both provider adapters; (3) final reconciliation uses the LOCKED executor identity (`initiatedById` read under the row lock); (4) the ineffective manual/API concurrency test retired and replaced by seven deterministic scenarios on REAL PostgreSQL with a barrier-controlled mock provider. |
| Files changed | `backend/src/payouts/adapters/flutterwave-payout.adapter.ts`, `paystack-payout.adapter.ts`, `mock-payout.adapter.ts`, `payout-adapters-v110.spec.ts` (new), `payout-lookup-classification.spec.ts`, `backend/src/payouts/payout-reconciliation.service.ts`, `payout-reconciliation-atomic.spec.ts`, `backend/test/payout-lockdown.e2e-spec.ts`, `frontend/tests/unit/withdrawal-form.test.ts`, `README.md`, 9 docs (new/updated) |
| Migrations added | **None** — the existing schema safely supports the corrected implementation (§12). Fresh `prisma migrate deploy` verified on PostgreSQL 17; `prisma migrate diff` reports NO drift between `schema.prisma` and migrations 0001–0006. |

## B. Vulnerability closure matrix

### B1. Flutterwave false NOT_FOUND classification (v1.0.9 finding 1)

| Aspect | Detail |
| --- | --- |
| Original severity | **P1 / critical** (a false NOT_FOUND authorizes a second transfer while the first may exist → duplicate payment) |
| Root cause | `isAuthoritativeFlwReferenceNotFound()` returned `content.length === 0` without validating pagination metadata; `{status:"success", data:{content:[], meta:{total:1}}}` classified NOT_FOUND. |
| Correction | The paginated shape now requires PRESENT and INTERNALLY CONSISTENT pagination metadata for authoritative absence: a required provider result count (`total`/aliases), well-typed fields, no contradiction with the returned records (total < returned, alias disagreement, `total > per_page × total_pages`, `current_page > total_pages`), no truncation (`total > returned`), and zero-total/page-field consistency. Missing/malformed/contradictory meta is AMBIGUOUS. The plain non-paginated array shape remains authoritative absence (no pagination structure can contradict it). The same consistency gate runs before positive adoption (§9). |
| Files changed | `backend/src/payouts/adapters/flutterwave-payout.adapter.ts` |
| Tests added | 16 pagination cases (unit, §3.3 table) + verdict unit matrix + truncated-page adoption refusal; the v1.0.9 expectation "empty paginated list without metadata → NOT_FOUND" was corrected to AMBIGUOUS (documented in the test and test report). |
| Actual test result | **PASS** (unit: 438/438 including all new cases) |
| Remaining limitations | Provider-side sandbox verification of real Flutterwave responses is BLOCKED (no credentials); the validator follows the documented v3 contract with defensive aliases. |

### B2. Exact provider reference identity (v1.0.9 finding 2)

| Aspect | Detail |
| --- | --- |
| Original severity | **P1 / critical** (adopting another transfer's identity settles the wrong transfer, or a FOUND without identity arms a duplicate) |
| Root cause | Paystack `findTransferByReference` delegated to `getTransfer` whose `providerTransferRef` falls back `reference ?? transfer_code ?? id` — an id/code-only record could be adopted; Flutterwave propagated the id-based detail lookup outcome without confirming the original reference. |
| Correction | Paystack: a FOUND record is adopted only when the authoritative record's own `data.reference` is present and EXACTLY equal to the requested reference (id/code-only → AMBIGUOUS with `recordHasTransferCode`/`recordHasTransferId` evidence; mismatch → AMBIGUOUS). Flutterwave: list matches must carry the exact reference (duplicates → AMBIGUOUS), the detail record must carry the exact reference AND belong to the listed transfer (id disagreement → AMBIGUOUS), and a NOT_FOUND detail behind an existing list match is a contradiction → AMBIGUOUS (never NOT_FOUND). Comparison is exact and case-sensitive; no normalization (§4.3). AMBIGUOUS lookups never trigger a submission; the stable idempotency key and provider reference are preserved (§4.5 — `providerSubmissionReference` unchanged, unit-proven). |
| Files changed | `paystack-payout.adapter.ts`, `flutterwave-payout.adapter.ts` |
| Tests added | Paystack 13 identity cases + Flutterwave 14 identity cases (§4.4 list) |
| Actual test result | **PASS** (unit: 438/438) |
| Remaining limitations | Sandbox verification BLOCKED. |

### B3. Stale executor identity in final reconciliation (v1.0.9 finding 3)

| Aspect | Detail |
| --- | --- |
| Original severity | **P1 / high** (final authorization could be validated against a pre-transaction identity — weak guarantee that the persisted executor under the lock is the one validated) |
| Root cause | The `SELECT ... FOR UPDATE` on `PayoutAttempt` did not select `initiatedById`; the validator received `attempt.initiatedById` from the PRE-transaction read. |
| Correction | The locked query now explicitly selects `initiatedById` (plus `withdrawalId`, `provider`, `idempotencyKey`, `providerTransferRef`, settlement fields — §5.2); the validator receives `locked.initiatedById`; a missing locked executor invalidates the cycle → settlement BLOCKED (audit event carries `executorId: null` + reason); a locked row diverging from the pre-transaction read (`withdrawalId`/`idempotencyKey`/`provider`/`amount`/`currency`) aborts reconciliation before any write (§5.5 tripwires); all post-lock provider reads use `locked.provider`; `PAYOUT_SETTLED_PROVIDER_VERIFIED` records the LOCKED executor. Four-person separation (requester ≠ first ≠ second ≠ executor) is re-proven inside the transaction by the approval-cycle validator (§5.4). |
| Files changed | `backend/src/payouts/payout-reconciliation.service.ts`, `payout-reconciliation-atomic.spec.ts`, `backend/test/payout-lockdown.e2e-spec.ts` |
| Tests added | Unit §5.6 matrix (missing executor, first-approver collision, requester/first/second collisions, valid fourth person with locked-identity audit, pre-transaction divergence abort) + REAL-PostgreSQL §5.6 integration (missing → blocked, colliding → blocked, fourth person → settled with the locked identity in the audit event) |
| Actual test result | **PASS** (unit 438/438; integration §5.6 PASS on real PG) |
| Remaining limitations | none known |

### B4. Ineffective manual/API concurrency test (v1.0.9 finding 4)

| Aspect | Detail |
| --- | --- |
| Original severity | **P1 / high** (the claimed two-valid-paths guarantee was not actually exercised) |
| Root cause | The v1.0.9 test called `settleManual()` directly without an authorized manual intent, used no controlled provider delay, and was rejected by the unresolved-provider-attempt check before any real competition. |
| Correction | Test RETIRED (not renamed). New deterministic infrastructure: the mock provider can HOLD a transfer request at the provider boundary behind a deferred promise (`setInitiationHold(armed, { reference })` — scoped to the exact logical payout), signal the boundary crossing (`onInitiationHeld`), and release deterministically (`accept` / `reject` / `timeout` / `connection-lost`); duplicate-reference submissions are rejected with a transport error (mirroring real providers); per-reference request counters expose the ordering evidence. No arbitrary sleeps: ordering comes from the deferred-promise barriers, and durable-outcome assertions use bounded condition waits on the DATABASE (the 1s sweeper may legitimately win a lease race — the financial outcome is identical regardless of which worker claimed it). |
| Tests added | Scenarios A–G (§6.3–§6.9) — see §E below. |
| Actual test result | **PASS** (16/16 lockdown integration tests on real PostgreSQL + Redis) |
| Remaining limitations | The provider side is a mock (sandbox BLOCKED); the coordination code paths exercised are the production paths (guard claims, in-lock rechecks, lease recovery, state machine) with the production-forbidden mock adapter behind them. |

## C. Provider lookup evidence (actual unit-test results)

| Case | Paystack | Flutterwave |
| --- | --- | --- |
| Exact requested reference (list + detail identity) | FOUND ✓ | FOUND ✓ |
| Pagination validation | n/a (no pagination in the contract) | empty+`total=1` → AMBIGUOUS ✓; flat `total>0` → AMBIGUOUS ✓; consistent zero-total → NOT_FOUND ✓; zero-total + `total_pages=0` → NOT_FOUND ✓; plain empty array → NOT_FOUND ✓; `current_page=2` with empty result → AMBIGUOUS ✓; missing meta on paginated shape → AMBIGUOUS ✓; malformed total → AMBIGUOUS ✓; malformed meta container → AMBIGUOUS ✓; missing content → AMBIGUOUS ✓; null content → AMBIGUOUS ✓; unexpected shape → AMBIGUOUS ✓; error envelope → AMBIGUOUS ✓; truncated page with match → AMBIGUOUS ✓; verdict matrix (fit/zero-page/missing-count) ✓ |
| Missing reference on the record | AMBIGUOUS ✓ (`recordHasTransferCode` evidence) | AMBIGUOUS ✓ |
| Null / empty reference | AMBIGUOUS ✓ / AMBIGUOUS ✓ | AMBIGUOUS ✓ / AMBIGUOUS ✓ |
| Mismatched reference | AMBIGUOUS ✓ (case-different → AMBIGUOUS ✓) | AMBIGUOUS ✓ (case-different → AMBIGUOUS ✓) |
| Transfer id present, reference missing | AMBIGUOUS ✓ | AMBIGUOUS ✓ |
| List/detail reference disagreement | n/a (single-record contract) | AMBIGUOUS ✓ |
| List/detail id disagreement | n/a | AMBIGUOUS ✓ |
| Duplicate matching references | n/a | AMBIGUOUS ✓ (`matchCount` evidence) |
| List match + detail NOT_FOUND (contradiction) | n/a | AMBIGUOUS ✓ (never NOT_FOUND) |
| Authoritative not-found | 404 + documented body → NOT_FOUND ✓; 404 unknown payload → AMBIGUOUS ✓; malformed 404 → AMBIGUOUS ✓ | plain empty array → NOT_FOUND ✓; id-lookup 404 → AMBIGUOUS ✓ |
| Retry prevention | AMBIGUOUS/ERROR outcomes never re-arm a submission (pipeline unit tests `payout-initiation.service.spec.ts` — LOOKUP_BLOCKED on 429/401 classes, FOUND adoption, NOT_FOUND-only re-arm) ✓ | same ✓ |

## D. Reconciliation evidence (locked executor identity)

The final locked SQL query (`payout-reconciliation.service.ts`, inside the single reconciliation transaction):

```sql
SELECT "id", "withdrawalId", "initiatedById", "provider", "providerTransferRef",
       "idempotencyKey", "status", "amount", "currency", "beneficiaryId", "reversalState"
FROM "PayoutAttempt" WHERE "id" = $1 FOR UPDATE
```

- The selected `initiatedById` (`locked.initiatedById`) is the value passed to the approval-cycle validator: `executorId: locked.initiatedById ?? null, requireExecutor: true` — the ONLY executor identity used for the final authorization decision.
- Stale-data guards: a locked row whose `withdrawalId`, `idempotencyKey`, `provider`, `amount` or `currency` diverges from the caller's pre-transaction read throws before ANY write; every post-lock provider read uses `locked.provider`; the settlement audit event records `executorId: locked.initiatedById`.
- Missing executor → cycle invalid → settlement BLOCKED (`INTERNAL_STATE_MISMATCH`, audit `PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE` with `executorId: null`).
- Changed executor (colliding with requester/first/second) → four-person separation fails → BLOCKED.
- Tests: unit `payout-reconciliation-atomic.spec.ts` §5.6 matrix (missing / a1 collision / req-1+a1+a2 collisions / valid exec-1 with audit identity / divergence abort) and REAL-PostgreSQL `payout-lockdown.e2e-spec.ts` §5.6 (missing → blocked with `executorId: null` audit; colliding → blocked; authorized fourth person → PAID with the locked identity recorded) — **all executed and passing**.

## E. Concurrency evidence (REAL PostgreSQL 17 + Redis 7.2.5, deterministic barriers)

Two valid competing settlement paths were explicitly tested: scenario A races the ACTUAL two-step manual-intent authorization workflow (fresh MFA) against the ACTUAL provider initiation workflow (durable intent + outbox) on real PostgreSQL; scenarios B/C prove each path winning first, deterministically. Every scenario asserts the final withdrawal status, attempt status, lease/guard state, provider request count, provider reference existence, settlement records, ledger entry count, the amount in minor units and the audit trail.

| Scenario | Execution order | Provider requests | Final withdrawal | Final attempt | Reservation | Ledger entries | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A (§6.3) | concurrent manual intent + provider initiation (barriers: both MFA-authorized, raced via `Promise.all`) | 0 (loser rejected before any provider call) | APPROVED (manual won) or PROCESSING (provider won) — exactly one | INITIATED (winner's) | intact | 0 | PASS — exactly one winner, loser 409 |
| B (§6.4) | intent → submission HELD at boundary → manual settle attempt → release → reconcile | 1 | PAID | SUCCESSFUL | reserved → settled | 1 | PASS — manual settlement 409 during flight; provider payout is the only settlement |
| C (§6.5) | manual intent committed → provider initiation attempt → manual settlement | 0 | PAID (MANUAL_BANK_TRANSFER) | INITIATED (manual intent) → SUCCESSFUL | intact → settled | 1 | PASS — provider initiation 409, zero provider artifacts |
| D (§6.6) | submission held+registered → worker crash (leases expired) → recovery lookup → adopt → reconcile | 1 (no second transfer) | PAID | SUCCESSFUL | reserved → settled | 1 | PASS — recovery adopted the ORIGINAL exact-reference transfer |
| E (§6.7) | crash → 7 ambiguous/error lookup classes → restore → recover → reconcile | 1 | PAID | SUCCESSFUL | preserved throughout | 1 | PASS — reservation preserved, manual blocked, no resubmission |
| F (§6.8) | lease claimed → request in flight → lease expires → recovery reconciles → repeat submission impossible | 1 | PAID | SUCCESSFUL | reserved → settled | 1 | PASS — recovery never assumed failure; no second submission |
| G (§6.9) | worker 1 claims + reaches boundary → worker 2 concurrent → release → reconcile ×2 | 1 | PAID | SUCCESSFUL | reserved → settled | 1 | PASS — one authoritative claim (`LOOKUP_PENDING` for the loser), replay posts ONE entry |

## F. Test report (exact executed counts — this session)

| Suite | Executed | Result |
| --- | --- | --- |
| Backend unit tests (22 jest suites) | **438** | 438 passed, 0 failed |
| Backend integration — auth.e2e | 16 | 16 passed |
| Backend integration — storage.e2e | 3 | 3 passed |
| Backend integration — withdrawals.e2e | 12 | 12 passed |
| Backend integration — webhooks.e2e | 4 | 4 passed |
| Backend integration — money-path.e2e | 12 | 12 passed |
| Backend integration — payout-lockdown.e2e | 16 | 16 passed |
| **Backend integration total (REAL PostgreSQL 17 + Redis 7.2.5)** | **63** | 63 passed, 0 failed |
| Frontend regression tests (vitest) | 53 | 53 passed |
| TypeScript compilation (backend + frontend) | 2 runs | pass |
| ESLint (backend src + test) | 1 run | 0 errors (41 pre-existing warnings) |
| Production builds (nest build, vite build) | 2 runs | pass |
| Prisma migration validation (fresh deploy + schema diff) | 2 checks | pass; NO drift |
| Paystack sandbox | 0 | **BLOCKED** (`PAYSTACK_SECRET_KEY` not set) |
| Flutterwave sandbox | 0 | **BLOCKED** (`FLUTTERWAVE_SECRET_KEY` not set) |

Total automated tests executed: **554** (438 unit + 63 integration + 53 frontend), all passing; 0 failed; 0 skipped; nothing removed or disabled. The only corrected expectations are documented in `KINDORA_v1.0.10_TEST_REPORT.md` §E (the v1.0.9 empty-paginated-list expectation encoded the defect this release closes; four stale pre-allowlist frontend fixtures were updated to the contract the backend has enforced since v1.0.8; the reconciliation test shell's locked-row fixture mirrors the v1.0.10 locked column list).

## G. Backup and archive report

All figures below are derived from the ACTUAL final artifacts of THIS release (§16 — no historical figures copied).

| Artifact | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `backups/KINDORA_v1.0.9_PRE_V110_BACKUP.tar.gz` (original v1.0.9 source, created BEFORE any v1.0.10 modification; 403 files) | 1,499,720 | `1922fbddb3b6efeaa51778df2b0e36aae1f4dfe7f31bed848de0b09e53e4009a` |
| `backups/KINDORA_v1.0.9_FINAL_BACKUP.tar.gz` (v1.0.9 final tree; 409 files) | 4,100,043 | `a43143225a8f526e5c8d2d2b50e164a397ca2150595b93ecd2f20afb90cc4a1e` |
| `backups/KINDORA_v1.0.10_FINAL_BACKUP.tar.gz` (v1.0.10 final tree; 410 files) | 1,538,003 | `d58d7cfdbf7d617e7be3333d1c7acbb67b58672cb44d524f9d0b8e1724cc628a` |
| `KINDORA_v1.0.10_SECURITY_COMPLETE.zip` (the release archive) | 70,165,162 compressed / 72,977,281 uncompressed | **published in `KINDORA_v1.0.10_zip.sha256` next to the archive** (the report is itself an archive entry; the final archive's hash is computed after the report is committed and is carried by the external checksum file and the archive's internal `SHA256SUMS.txt`) |

Archive verification (independent, `verify_release_zip_v110.sh` — 29/29 PASS):
- ZIP integrity (`unzip -t`) ✓; archive entries **527** (including directories); internal checksum manifest **429 entries**, every entry verified ✓
- Independent extraction compared byte-for-byte with the release source (git archive of the tracked tree) ✓
- Nested backups independently extracted and manifest-verified: v1.0.9 pre-v110 (403 files) ✓, v1.0.9 final (409 files) ✓, v1.0.10 final (410 files) ✓; nested release zips (v1.0.4/7/8/9) + baseline tars (v1.0.6, pre-v108, pre-v109) integrity-checked ✓; release-root-relative manifests verified in context ✓
- Release structure complete (backend/frontend/workers/docs/brand/scripts/render.yaml/README/manifest) ✓
- Secret scan: no non-example `.env` files, no key material, no live/test secret patterns ✓

## H. Outstanding risks

| # | Risk | Severity | Release impact |
| --- | --- | --- | --- |
| 1 | Provider sandbox verification (Paystack + Flutterwave) is BLOCKED — real provider responses (auth, initiation, duplicate-reference behaviour, pagination, lookup, recovery) have not been exercised against the live sandboxes. | HIGH | Release remains STAGING READY; production classification requires completing §14 with sandbox credentials. |
| 2 | The Flutterwave pagination validator implements the documented v3 contract with defensive field aliases; unusual API revisions could produce shapes not anticipated here — the design fails closed (AMBIGUOUS), which keeps money safe but could hold reservations until operator review. | MEDIUM | Operational (manual review workload), not financial. |
| 3 | The v1.0.9-sourced approval-cycle/snapshot/MFA controls were preserved unchanged and re-tested, but a dedicated security review of v1.0.10 (beyond this release's scope) is still recommended before production. | LOW | Process recommendation. |
| 4 | The corrected empty-paginated-list contract changes v1.0.9 behaviour (missing-meta empty lists are now AMBIGUOUS): operators may see more `AMBIGUOUS` lookups requiring the standard verification loop until the provider's responses are confirmed in sandbox. | LOW | Documented in the incident runbook addendum. |

No critical or high-priority source-level payout vulnerability remains open in v1.0.10. The four v1.0.9 findings are closed with implementation, tests and executed evidence.
