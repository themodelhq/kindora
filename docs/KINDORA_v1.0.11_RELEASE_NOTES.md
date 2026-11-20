# KINDORA v1.0.11 — RELEASE NOTES

**Flutterwave Pagination Integrity & Transfer Identity Lockdown**
Base: v1.0.10 (release commit `e17e96e`). Classification: **STAGING READY**
(see `docs/FINAL_ENGINEERING_REPORT_V1.0.11.md` §H — provider sandbox
verification remains BLOCKED for lack of sandbox credentials).

---

## What changed

A focused security-hardening release. Three findings from the v1.0.10
security review of the Flutterwave transfer lookup are closed. No database
migration is required (adapter-only correction). No frontend change. No
architectural change.

### 1. Strict pagination alias consistency (v1.0.10 §3 → v1.0.11 §3)

* The v1.0.10 `flwPaginationVerdict()` validated `current_page`, `page`,
  `currentPage`, `total_pages`, `pageCount`, `pages`, `per_page`, `pageSize`
  independently and resolved cross-field relationships through a
  first-value selection (`firstNumber`). Conflicting aliases such as
  `{current_page: 1, page: 2}` could therefore slip through.
* v1.0.11 validates EVERY supplied alias independently as a strict, in-range
  integer and requires all aliases — and all recognised containers — to
  AGREE exactly. The first-value selection is removed.
* Strict integer validation: fractional, negative, NaN/Infinity (including
  `1e999` in raw JSON), numeric strings, empty strings, booleans, objects
  and `null` are malformed. A `null` alias is a SUPPLIED value — never
  silently ignored. An absent alias is never invented as zero. The result
  count (`total`) is required for any classification.
* New relationship checks: returned-records-exceed-page-size and
  zero-results-spanning-multiple-pages are contradictory (in addition to
  the v1.0.10 relationships).
* NEW — the official v3 envelope container `meta.page_info` is now
  validated (provider-contract verification against the official OpenAPI
  description found that v1.0.10 ignored it entirely: an empty array under
  `page_info.total > 0` could previously classify as authoritative
  NOT_FOUND). `page_size` is added as a contract-backed page-size alias.

### 2. Exact list-to-detail transfer identity (v1.0.10 §4 → v1.0.11 §4)

* v1.0.10 rejected a detail-id mismatch only when an id was present
  (`detailId != null && ...`): a detailed response with a matching
  reference but NO transfer id could pass and be adopted.
* v1.0.11 makes the detail transfer id MANDATORY: missing / `null` / empty /
  malformed detail ids are AMBIGUOUS, and the detail id must equal the
  list-identified transfer id. The matched list record must also carry a
  valid transfer id before the detail lookup.
* List-record identity validation is added: malformed ids/references and
  duplicate provider ids with conflicting references make the page unusable
  (AMBIGUOUS).

### 3. Metadata-mandatory adoption for paginated responses (v1.0.10 §9 gap → v1.0.11 §5)

* v1.0.10 applied the pagination gate only when metadata was PRESENT; a
  paginated `data.content` response carrying the requested reference with
  metadata MISSING could proceed to adoption.
* v1.0.11: for the paginated shapes (S1 official paginated array with
  `meta.page_info`, S2 content revision), valid, complete and internally
  consistent metadata is MANDATORY before ANY classification — FOUND and
  NOT_FOUND alike. Metadata missing/malformed/contradictory/incomplete ⇒
  AMBIGUOUS even when the page contains the requested reference.
* The supported non-paginated legacy array keeps its own documented rules;
  unknown response structures are AMBIGUOUS. The shape distinction is
  explicit (S1/S2/S3/S4) — an array is never treated as complete merely
  because it is an array.

### 4. Centralised validation (v1.0.11 §6)

The lookup now runs one deterministic 12-step sequence built from a small
set of internal validators (`classifyFlwListShape`, `diagnoseFlwPagination`,
`validateFlwAliasGroup`, `scanFlwListRecords`, `isFlwTransferId`); the
duplicated v1.0.10 not-found predicate was folded into the shape
classification. The four-valued lookup outcome contract
(FOUND / NOT_FOUND / AMBIGUOUS / ERROR) is preserved unchanged.

## What did NOT change

* Payout state machine, initiation/outbox/reconciliation pipeline, settlement
  guard, approval cycles, four-person separation, MFA, executor identity
  locking, exactly-once ledger posting, reservation management (§8
  protections preserved and regression-covered).
* Paystack payout adapter (regression suite green), Stripe donation flow,
  donation providers.
* Database schema and migrations (0001–0006 unchanged; live-database vs
  Prisma schema diff is empty).
* Frontend, workers, deployment configuration (Netlify/Render).

## Verification evidence

* Backend unit tests: **513/513 green** (23 suites; 75 new v1.0.11 tests).
* Backend integration tests (real PostgreSQL 17 + Redis 7.2.5): **63 tests**
  executed — 47 green across auth/webhooks/storage/withdrawals/money-path,
  payout-lockdown 15/16 green chunked with ONE environment-timing flake
  (`§3.1/§3.2` LOOKUP_PENDING vs ALREADY_SUBMITTED) that was reproduced
  IDENTICALLY on the pristine v1.0.10 tree under the same infrastructure
  (A/B comparison, `scripts/v111_e2e_chunk.sh`) — not a v1.0.11 regression.
* Frontend: 53/53 green; TypeScript clean; production build green.
* Flutterwave/Paystack provider sandbox tests: **BLOCKED** (no credentials).
* Details: `docs/KINDORA_v1.0.11_TEST_REPORT.md`.

## Environment variables

No new environment variables. No configuration changes.
