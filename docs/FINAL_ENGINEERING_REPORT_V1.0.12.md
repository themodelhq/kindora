# KINDORA v1.0.12 — FINAL ENGINEERING REPORT

**Flutterwave Pagination Contract Completeness & Joint Container Validation**
Base: v1.0.11 (release commit `f888332`). All figures are actual measured
results from this build environment. External provider sandbox verification
remains **BLOCKED** (no credentials) — see §H.

---

## A. Release summary

v1.0.12 closes the three structural weaknesses the v1.0.11 review left open
in the Flutterwave payout lookup, in the strictly conservative direction:

1. **§3 — per-shape mandatory pagination field sets.** The required
   pagination fields are now first-class constants per shape
   (`FLW_REQUIRED_S1`, `FLW_REQUIRED_S2`): `{total, current_page,
   total_pages}` for both supported shapes (S1 official paginated array,
   S2 content revision). A missing mandated field ⇒ INCOMPLETE ⇒ AMBIGUOUS
   in both classification directions. The §3.1 finding is closed: a bare
   result count (`total: 0` without `current_page`/`total_pages`) no
   longer classifies and can never produce an authoritative NOT_FOUND.
   `current_page` is one-based per the documented provider contract
   (minimum 1; `0`, `-1`, `1.5` are malformed). `page_size` stays
   optional (§3.6).
2. **§3.2 — explicit classification precedence.** Value-level validation
   of every supplied alias in every supplied container (CONTRADICTORY)
   runs first; the required-field gate (INCOMPLETE) runs before
   relationship validation. Precedence affects only the diagnosis string;
   every non-CONSISTENT verdict keeps the outcome AMBIGUOUS.
3. **§4 — joint container validation.** ALL containers supplied on a
   response (outer `data.meta`, nested `data.meta.pagination`, envelope
   `meta.page_info`) are extracted and validated as one set; shared
   fields must agree exactly (the §4.1 outer/nested contradiction can
   never silently resolve to one container). Malformed containers are
   MALFORMED evidence and never authorize outer-fallback (§4.5); an empty
   `{}` container contributes nothing; required fields may be satisfied
   collectively across containers when nothing disagrees (the additive
   half).
4. **§5 — S3 removed.** The "legacy complete array" classification is
   deleted: every metadata-free `data: [...]` array is AMBIGUOUS in both
   directions (never NOT_FOUND, never FOUND). Rationale: byte-level
   indistinguishability from a truncated paginated response, no
   independently verifiable legacy signal, and asymmetric safe-side
   failure modes (AMBIGUOUS → manual review vs authoritative NOT_FOUND
   from a truncated page → automatic resubmission, the double-payout risk
   class).

Adapter-only release: no migration, no frontend change, no pipeline
change, no new environment variables. The four-valued lookup contract
(`FOUND`/`NOT_FOUND`/`AMBIGUOUS`/`ERROR`) and every AMBIGUOUS-recovery
behaviour are unchanged.

## B. Finding-closure matrix

### Finding 1 — bare result count classified as complete (v1.0.11 §13) → v1.0.12 §3

* v1.0.11 required `total` for classification, but a response supplying
  ONLY `total` (e.g. `total: 0`) with no page context could still reach
  CONSISTENT and produce an authoritative NOT_FOUND.
* v1.0.12 mandates `{total, current_page, total_pages}` per shape. Bare
  counts are INCOMPLETE ⇒ AMBIGUOUS. Tests: §3 suite (13), §8.1
  combination matrix (6), §9 scenarios A/E.

### Finding 2 — nested container overrode outer container evidence (v1.0.11 gap) → v1.0.12 §4

* v1.0.11 selected the nested `data.meta.pagination` object and dropped
  outer `data.meta` fields when both existed; outer `total: 1` + nested
  `total: 0` silently resolved to `0` (the §4.1 finding).
* v1.0.12 validates all supplied containers jointly; disagreements are
  CONTRADICTORY ⇒ AMBIGUOUS; malformed containers never authorize
  fallback; agreeing/split evidence is accepted. Tests: §4 suite (13),
  §4.7 matrix (8), §9 scenarios B/D.

### Finding 3 — the S3 legacy-complete-array assumption (v1.0.9–v1.0.11) → v1.0.12 §5

* The S3 rule treated any metadata-free array as a complete legacy result
  set — an assumption with no independently verifiable provider signal,
  byte-indistinguishable from a truncated paginated response, whose
  failure mode could be an authoritative NOT_FOUND (→ automatic
  resubmission) from an actually-truncated page.
* v1.0.12 removes S3 entirely: metadata-free arrays are AMBIGUOUS in both
  directions. The v1.0.11 documented discrepancy is resolved in the
  conservative direction. Tests: §5 suite (7) + corrected legacy
  matrices (§9.4 identity 4 tests, v110 spec, lookup-classification spec).

## C. Pagination verification evidence (actual executed results)

Unit-level (jest, deterministic; fetch-mocked adapter):

* 55 new tests in `flutterwave-pagination-integrity-v112.spec.ts` (8
  suites) — all green. Representative pins: S1/S2 each-missing-field ⇒
  AMBIGUOUS (6 tests); bare `total: 0` / `total: 3` ⇒ AMBIGUOUS (2);
  complete sets ⇒ authoritative NOT_FOUND (4, incl. the S1 positive
  control with evidence `shape: 'PAGINATED_ARRAY'`); §3.2 precedence
  pinned at the verdict helper (2); one-based `current_page` (`0`, `-1`,
  `1.5`) malformed (3); §4.1 contradiction ⇒ AMBIGUOUS with the
  disagreement in `reason` (1); agreeing containers ⇒ NOT_FOUND (1);
  split-field containers ⇒ NOT_FOUND (1); empty `{}` container both
  directions (2); malformed `data.meta` / `data.meta.pagination` never
  outer-fallback (5); three-container agree/disagree (2); FOUND requires
  full joint validation (1); §4.7 matrix (8); §8.1 matrix (6); §9
  scenarios A–E (5); §5 S3-removal matrix (7).
* Legacy matrices corrected to v1.0.12 semantics: identity §9.4 (4
  tests → AMBIGUOUS), `payout-adapters-v110.spec.ts` (3 corrections incl.
  the precedence pin `total: 0, current_page: 3`), 
  `payout-lookup-classification.spec.ts` (1 correction).
* Adapter subset 241/241 green; full backend unit 568/568 green.

Integration-level (real PostgreSQL 17.9 + Redis 7.2.5, fresh database per
chunk, migrations 0001–0006, guard index verified, seeded):

* 63/63 green across six suites; payout-lockdown 16/16 (four chunked
  runs); REAL-PG concurrency scenarios §6.3–§6.9 (A–G) all green — the
  unchanged recovery pipeline correctly handles every AMBIGUOUS
  classification this release can produce (reservation preserved, no
  second transfer, settlement guard holds, original transfer reconciled
  once lookups recover).
* Zero flakes; no A/B baseline comparison needed (the v1.0.11 harness
  existed solely to attribute that release's single timing flake).

## D. Transfer identity evidence (sanitised test data)

Unchanged from v1.0.11 (§4 of the provider reference). FOUND still
requires: requested merchant reference = list merchant reference = detail
merchant reference, list transfer id = detail transfer id, both ids valid,
single list match, and — new prerequisite in v1.0.12 — the page itself
must be a validated S1/S2 shape with a CONSISTENT joint pagination
verdict before any identity rule runs. Detail-id missing/mismatched ⇒
AMBIGUOUS; filter-not-honoured (non-empty validated page without the
reference) ⇒ AMBIGUOUS. The v112 spec's FOUND-path tests (§9 scenario D,
§5 regression guards) exercise the full chain end-to-end at adapter level;
`payout-lockdown.e2e-spec.ts` §6.6–§6.7 exercises adoption/reconciliation
on real PostgreSQL.

## E. Financial recovery evidence

Unchanged pipeline, regression-proven against the tightened classifications
(REAL PostgreSQL 17.9, payout-lockdown 16/16):

* Ambiguous lookups preserve the withdrawal reservation, the payout
  attempt, provider reference and idempotency key; create no new attempt;
  submit no second transfer; do not mark the withdrawal failed; release
  nothing; block competing manual settlement via the durable guard;
  record an auditable reconciliation event and escalate to manual review
  (§6.7 (E) green — this release's core scenario).
* Recovery after worker crash adopts the ORIGINAL provider transfer, never
  submits twice (§6.6 (D) green).
* Lease-expiry and duplicate-worker paths reconcile the existing transfer
  or claim once (§6.8 (F), §6.9 (G) green).
* Only a genuine authoritative NOT_FOUND re-arms the SAME durable attempt
  (§9 scenario E at adapter level; the NOT_FOUND precondition is now
  reachable ONLY through fully validated, jointly consistent metadata —
  bare counts and metadata-free arrays can no longer trigger it).

## F. Test results (actual executed counts — this release build)

| Layer | Suites | Passed | Failed |
|---|---|---|---|
| Backend unit (jest) | 24 | 568 | 0 |
| — payout adapter subset | 5 | 241 | 0 |
| Backend integration (PG 17.9 + Redis 7.2.5) | 6 | 63 | 0 |
| Frontend (vitest, no change) | — | 53 | 0 |
| TypeScript backend `tsc --noEmit` | — | clean | — |
| TypeScript frontend `tsc --noEmit` (5.9.3) | — | clean | — |
| Provider sandbox | — | **BLOCKED** | — |

Notes: the new v112 spec has 55 tests in 8 describe suites (§3: 13,
§3.3/3.4: 3, §4: 13, §4.7: 8, §8.1: 6, §9: 5, §5: 7). The integration
harness (`/tmp/pgtest`, `/tmp/redis-7.2.5`) was rebuilt after a sandbox
recycle destroyed it — identical builds (embedded-postgres PG 17.9; Redis
7.2.5 compiled from the official source tarball with `MALLOC=libc`) — and
all runs executed on the rebuilt harness.

## G. Backup and archive verification

* **Pristine pre-v112 backup** (`backups/KINDORA_v1.0.11_PRE_V112_BACKUP.tar.gz`):
  417 source files from the TRUE pristine release tree (`git rev f888332`),
  manifest-verified (416 manifest entries over the archive, independent
  extraction, 0 verification failures), adapter blob pinned byte-exact to
  the f888332 tree blob, contamination check green (no v1.0.12 markers),
  structural probe green (backend/frontend/workers/docs/scripts,
  migrations 0001–0006). Archive SHA-256:
  `224cbd60f35ff612f20b6904c207819702194e55c58251e7d0b46da85b407035`.
  Provenance note: the ORIGINAL Phase-0 tarball (2026-11-15 17:19Z) was
  built from `git archive HEAD` AFTER the v1.0.12 adapter commit had
  landed and was therefore not pristine; it was rebuilt in place from the
  pinned release tree (`scripts/v112_phase0_backup_rebuild.sh`) and the
  rebuilt archive is the authoritative pre-v112 backup. A later sandbox
  recycle destroyed the backup directory; the nested recovery tarballs
  were restored from the committed v1.0.11 zip and the pristine backup
  was regenerated identically from the pinned commit (same content, same
  manifest).
* **Final v1.0.12 backup** (`backups/KINDORA_v1.0.12_FINAL_BACKUP.tar.gz`):
  post-release source snapshot with SHA-256 manifest, independently
  extracted and verified (see the packaging log and
  `scripts/v112_final_backup.sh`).
* Both backups ship NESTED in the release archive with their sidecars; the
  release zip itself is committed to git as the recycle-resilient recovery
  source (`git cat-file blob HEAD:download/KINDORA_v1.0.12_SECURITY_COMPLETE.zip`).
* Older-generation recovery artifacts (v1.0.10 pre-v111 backup, v1.0.11
  final backup) remain inside the committed v1.0.11 zip; the backups/
  working copies were restored from there after the recycle.

## H. Outstanding risks

1. **Provider sandbox verification remains BLOCKED** — no
   `FLUTTERWAVE_SECRET_KEY` / `PAYSTACK_SECRET_KEY` in this environment.
   No live-provider claim is made anywhere in this release. Mitigation:
   the delta is exclusively responses moving INTO AMBIGUOUS (never out of
   it); NOT_FOUND/FOUND outcomes are a strict subset of v1.0.11's.
   Operational exposure is bounded to additional manual reviews. When
   sandbox credentials become available, run the §8.1/§4.1 matrix shapes
   against the sandbox list endpoint before production rollout.
2. **AMBIGUOUS rate may increase in production.** Bare-metadata and
   metadata-free responses that previously auto-classified now escalate
   to manual review. This is the intended fail-closed direction, but
   operations should expect (and monitor) a higher manual-review rate on
   the Flutterwave payout path until the live response shapes are
   confirmed to always carry the mandated metadata.
3. **If Flutterwave ships a THIRD paginated shape** (neither S1 nor S2),
   it lands in S4/AMBIGUOUS by construction — safe but operationally
   noisy. Extending `classifyFlwListShape` requires a new provider-contract
   verification pass (the OpenAPI description is the reference).
4. **Sandbox-recycle fragility of the build environment** (processes,
   `/tmp`, file modes are not persistent). Mitigated by: the committed
   release zip as recovery source, manifest-verified nested backups, and
   the rebuild scripts (`v112_phase0_backup_rebuild.sh`,
   `v112_final_backup.sh`) being reproducible from git alone.
