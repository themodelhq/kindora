# KINDORA v1.0.12 — RELEASE NOTES

**Flutterwave Pagination Contract Completeness & Joint Container Validation**
Base: v1.0.11 (release commit `f888332`). Classification: **STAGING READY**
(see `docs/FINAL_ENGINEERING_REPORT_V1.0.12.md` §H — provider sandbox
verification remains BLOCKED for lack of sandbox credentials).

---

## What changed

A focused, strictly more conservative hardening release. The Flutterwave
payout lookup's pagination contract is completed and its container handling
is made joint. Adapter-only correction: no database migration, no frontend
change, no architectural change. The four-valued lookup outcome contract
(`FOUND` / `NOT_FOUND` / `AMBIGUOUS` / `ERROR`) is unchanged, as is every
AMBIGUOUS-recovery behaviour (reservation preserved, no second transfer,
durable settlement guard, manual-review escalation).

### 1. Per-shape MANDATORY pagination field sets (v1.0.12 §3)

* The required pagination fields are now defined explicitly per response
  shape as first-class adapter constants (`FLW_REQUIRED_S1`,
  `FLW_REQUIRED_S2`) — never inferred, never inherited from another shape:
  `{total, current_page, total_pages}` for BOTH supported shapes (S1
  official paginated array with envelope `meta.page_info`; S2 content
  revision). `page_size` remains optional (contract-backed alias, §3.6 —
  it is never mandatory without provider-contract justification).
* A missing mandated field leaves the response **INCOMPLETE** → AMBIGUOUS,
  in BOTH classification directions (never FOUND, never NOT_FOUND).
* **§3.1 finding closed**: a bare result count (`total: 0` with no
  `current_page` and no `total_pages`) no longer classifies as CONSISTENT
  and can never again produce an authoritative NOT_FOUND. A bare count
  alone does not establish the pagination context and does not prove the
  response is complete.
* `current_page` is **one-based** per the documented provider contract
  (the official `page_info` example reports `current_page: 1`): values
  below 1 (`0`, `-1`) and fractional values (`1.5`) are malformed
  (CONTRADICTORY). The alias-group minimums are now total `0`,
  current_page `1`, total_pages `0`, page_size `1`.

### 2. Explicit classification precedence (v1.0.12 §3.2)

The deterministic diagnosis evaluates, in order: (1) value-level validation
of EVERY supplied alias in EVERY supplied container (malformed value or
alias/container disagreement ⇒ CONTRADICTORY) — this runs first so a
contradiction can never be concealed by an incomplete field set;
(2) the required-field gate (missing mandated field ⇒ INCOMPLETE) — this
runs before relationship validation; (3) relationship validation between
present and valid groups. The precedence affects only the diagnosis string;
every non-CONSISTENT verdict keeps the outcome AMBIGUOUS.

### 3. JOINT container validation (v1.0.12 §4)

* v1.0.11 selected the nested `data.meta.pagination` object and DROPPED the
  outer `data.meta` fields when both were supplied. The two containers may
  contradict each other — the **§4.1 finding** (outer `total: 1` + nested
  `total: 0`) could silently resolve to the nested value. v1.0.12 extracts
  and validates ALL supplied containers as one set: outer `data.meta`,
  nested `data.meta.pagination`, and the envelope `meta.page_info` when
  supplied alongside the content revision.
* Shared fields must **agree exactly across every container**; any
  disagreement is CONTRADICTORY (AMBIGUOUS). The full cross-container
  consistency matrix is regression-tested (per-field disagreements,
  alias-level disagreements, primitive containers, three-container
  combinations).
* A `null` / non-object / array container is MALFORMED evidence — never
  silently ignored, and a malformed nested container can **NEVER authorize
  fallback to the outer container** (§4.5): malformed evidence must not be
  rewarded with a fallback path. An empty `{}` container contributes no
  evidence and never satisfies the required fields by itself.
* The additive half: required fields may be satisfied collectively ACROSS
  containers (outer carries `total`, nested carries `current_page` +
  `total_pages`) — accepted when nothing disagrees. Strict about
  contradictions, permissive about complements.

### 4. The S3 "legacy complete array" classification is REMOVED (v1.0.12 §5)

* v1.0.9–v1.0.11 classified a bare `data: [...]` array with no pagination
  container as a COMPLETE legacy result set (authoritative NOT_FOUND when
  empty / without the reference; identity path when carrying the
  reference). v1.0.12 removes that classification: every metadata-free
  array is now **AMBIGUOUS in both directions** — including the empty
  array.
* Rationale (documented in `docs/PROVIDER_INTEGRATION_V1.0.12.md` §1.1):
  (a) on the CURRENT paginated endpoint a bare array is byte-indistinguishable
  from a truncated paginated response; (b) the integration has NO
  independently verifiable signal for a genuinely legacy revision (no
  revision flag, no version-specific envelope, no documented legacy
  marker) — an assumption must never decide money; (c) the failure modes
  are asymmetric: AMBIGUOUS → manual review (safe), whereas the old S3 rule
  could yield an authoritative NOT_FOUND from an actually-truncated page →
  automatic resubmission (the double-payout risk class). AMBIGUOUS is
  always the acceptable direction.
* Consequence: a metadata-free array can produce neither NOT_FOUND nor
  FOUND. The v1.0.11 documented discrepancy (§13) is thereby RESOLVED in
  the conservative direction.

### 5. Centralised validation (carried forward)

The lookup remains one deterministic 12-step sequence (`findTransferByReference`)
built from the small validator set (`classifyFlwListShape`,
`diagnoseFlwPagination`, `validateFlwAliasGroup`, `scanFlwListRecords`,
`isFlwTransferId`), tightened by §3/§4/§5 above. Under v1.0.12 the page
itself must be a validated S1/S2 shape with a CONSISTENT joint pagination
verdict before ANY identity rule is evaluated — FOUND continues to require
the full exact-identity establishment (list reference = detail reference =
requested reference; list transfer id = detail transfer id; both valid).

## What did NOT change

* Payout state machine, initiation/outbox/reconciliation pipeline, settlement
  guard, approval cycles, four-person separation, MFA, executor identity
  locking, exactly-once ledger posting, reservation management (§8
  protections preserved and regression-covered — REAL-PostgreSQL
  concurrency scenarios A–G all green).
* Paystack payout adapter (regression suite green), Stripe donation flow,
  donation providers.
* Database schema and migrations (0001–0006 unchanged; no migration in this
  release).
* Frontend, workers, deployment configuration (Netlify/Render).
* Environment variables: no new variables, no configuration changes.

## Verification evidence

* Backend unit tests: **568/568 green** (24 suites). The payout adapter
  subset is 241/241 across 5 suites, including the new
  `flutterwave-pagination-integrity-v112.spec.ts` (**55 tests, 8 suites**)
  covering §3 per-shape mandatory sets, the one-based contract, §4 joint
  containers (agree / split / contradict / malformed / three-container),
  the §4.7 cross-container matrix, the §8.1 combination matrix, §9
  recovery scenarios A–E, and the §5 S3-removal matrix. Legacy matrices
  were corrected to the v1.0.12 semantics with outcomes staying
  fail-closed.
* Backend integration tests (real PostgreSQL 17.9 + Redis 7.2.5): **63/63
  green** — auth 16, webhooks 4, storage 3, money-path 12, withdrawals 12,
  payout-lockdown 16. All seven REAL-PostgreSQL concurrency scenarios
  (§6.3–§6.9, A–G) passed. **Zero flakes** — unlike v1.0.11 (whose single
  §3.1/§3.2 timing flake required an A/B baseline comparison), no A/B
  comparison was needed this release.
* Frontend: 53/53 green; TypeScript clean (tsc 5.9.3). No frontend change.
* Flutterwave/Paystack provider sandbox tests: **BLOCKED** (no credentials).
  The tightened contract is strictly more conservative than v1.0.11: every
  response v1.0.12 classifies NOT_FOUND was already NOT_FOUND under
  v1.0.11; the delta is exclusively responses moving into AMBIGUOUS.
* Details: `docs/KINDORA_v1.0.12_TEST_REPORT.md`.

## Recovery / source preservation

* Pristine pre-v112 backup: `backups/KINDORA_v1.0.11_PRE_V112_BACKUP.tar.gz`
  (417 files, manifest-verified, adapter blob pinned byte-exact to the
  `f888332` release tree, archive SHA-256
  `224cbd60f35ff612f20b6904c207819702194e55c58251e7d0b46da85b407035`),
  rebuilt from the committed release tree after a sandbox recycle destroyed
  the original Phase-0 tarball (`scripts/v112_phase0_backup_rebuild.sh`).
* The final v1.0.12 source backup ships nested in the release archive
  alongside it; both are independently restorable and manifest-verified.
