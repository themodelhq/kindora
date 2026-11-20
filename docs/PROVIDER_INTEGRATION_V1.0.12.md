# PROVIDER INTEGRATION — v1.0.12

**KINDORA v1.0.12 — Flutterwave Pagination Contract Completeness & Joint Container Validation**
Scope: the Flutterwave PAYOUT adapter lookup path only. Paystack/Stripe payout
semantics, donation flows and the payout state machine are UNCHANGED.

---

## 1. Supported Flutterwave list response shapes (v1.0.12 §5 — S3 REMOVED)

The reference-filtered lookup `GET /v3/transfers?reference=<ref>` recognises
EXACTLY the following shapes. Anything else is **AMBIGUOUS** — never
interpreted as complete, never interpreted as non-paginated.

| Shape | Structure | Pagination metadata | Completeness rule |
|---|---|---|---|
| **S1 — Official paginated array** (current v3 contract) | `data: [...]` + envelope-level `meta.page_info` | MANDATORY: the full field set of §2.1 must be present, valid and internally consistent | Empty + consistent ⇒ authoritative NOT_FOUND; otherwise identity rules |
| **S2 — Content revision** | `data: { content: [...], meta... }` | MANDATORY (at `data.meta`, `data.meta.pagination` or both) | Same as S1 |
| **S4 — anything else** | unknown structures, unrecognized metadata containers, `data.meta` without `content`, **and every metadata-free `data: [...]` array** | — | **AMBIGUOUS** |

### 1.1 Why the S3 "legacy complete array" rule was removed (v1.0.12 §5)

v1.0.9–v1.0.11 classified a bare `data: [...]` array with no pagination
container anywhere as a COMPLETE legacy result set. v1.0.12 removes that
classification. Rationale:

1. On the CURRENT paginated endpoint a bare array is byte-indistinguishable
   from an incomplete/truncated paginated response. The two situations differ
   only in information the integration cannot observe.
2. The integration has NO independently verifiable signal for identifying a
   genuinely legacy revision: no separately configured API revision flag, no
   version-specific envelope, no documented legacy marker. "It looks like the
   legacy revision" is an assumption, and an assumption must never decide
   money.
3. The failure modes are asymmetric and safe-side: a metadata-free array that
   is actually complete now yields AMBIGUOUS (manual review — a human closes
   the case), while the old S3 rule could yield an authoritative NOT_FOUND
   from an actually-truncated page (automatic resubmission — a double-payout
   risk class). AMBIGUOUS is always the acceptable direction.

Consequence: a metadata-free array can produce **neither NOT_FOUND nor
FOUND**. This applies to the empty array, the non-empty array without the
requested reference, and the array carrying the exact requested reference
alike. The v1.0.11 documented discrepancy (§13) is thereby RESOLVED in the
conservative direction: no bare-array response is treated as complete.

### Provider-contract verification (v1.0.11 §13, carried forward)

Verified 2026-11 against the official v3 OpenAPI description published at
`developer.flutterwave.com/api/v3/openapi.json`:

* `GET /v3/transfers` — `data` is a **plain transfer array**; pagination
  metadata lives at the **envelope top level**: `meta.page_info.{total,
  current_page, total_pages}` (example value: `total: 688, current_page: 1,
  total_pages: 69`).
* `page_size` is a documented `page_info` field on other v3 list endpoints
  (refunds, settlements, chargebacks) — it remains a **contract-backed
  alias** of the page-size property (v1.0.12 §3.6: OPTIONAL, never mandatory
  without provider-contract justification, validated strictly when
  supplied).
* `GET /v3/transfers/:id` — `data` carries `id` (numeric) and `reference`
  (string echo). **No 404 not-found body is documented** → a bare HTTP 404
  on the id lookup stays AMBIGUOUS (v1.0.9 §2.2 rule preserved).
* The official `page_info` example reports `current_page: 1` and the
  documented empty-result convention is `current_page: 1` — `current_page`
  is **one-based** (v1.0.12 §3.4). A supplied `current_page < 1` is
  malformed.

---

## 2. Pagination metadata requirements (v1.0.12 §3)

### 2.1 Per-shape REQUIRED field sets (v1.0.12 §3.2/§3.5)

The required pagination fields are defined EXPLICITLY per response shape,
as first-class constants in the adapter (`FLW_REQUIRED_S1`, `FLW_REQUIRED_S2`)
— never inferred, never inherited from another shape's rule:

| Shape | total | current_page | total_pages | page_size |
|---|---|---|---|---|
| S1 (official `meta.page_info`) | **REQUIRED** | **REQUIRED** | **REQUIRED** | optional |
| S2 (content revision) | **REQUIRED** | **REQUIRED** | **REQUIRED** | optional |

A missing REQUIRED field leaves the response **INCOMPLETE** — unverifiable,
AMBIGUOUS, in both classification directions. In particular the v1.0.12
**§3.1 finding is closed**: a bare result count (`total: 0` with no
`current_page` and no `total_pages`) no longer classifies as CONSISTENT, so
it can never again produce an authoritative NOT_FOUND. A bare count alone
does not establish the pagination context and does not prove the response is
complete.

### 2.2 Alias groups (v1.0.11 §3, unchanged)

| Property | Aliases | Minimum (v1.0.12) |
|---|---|---|
| total results | `total` \| `total_count` \| `totalCount` \| `count` | 0 |
| current page | `current_page` \| `page` \| `currentPage` | **1** (one-based, §3.4) |
| total pages | `total_pages` \| `pageCount` \| `pages` | 0 |
| page size | `per_page` \| `pageSize` \| `page_size` | 1 |

Recognised containers: `meta.page_info` (S1), `data.meta.pagination` and
`data.meta` (S2) — see §3 for the joint-validation rules.

### 2.3 Strict integer constraints (v1.0.11 §3.3, unchanged)

A supplied value is valid **only** if it is a JSON finite number that is a
safe integer within the field's minimum. REJECTED (malformed/contradictory):
fractional values, negative values, values below the minimum (including
`current_page: 0` and `current_page: -1`), `NaN`, `Infinity` (including via
`1e999` in raw JSON), numeric strings (`"10"`, `"10invalid"`), empty
strings, booleans, objects/arrays, and `null`. A `null` is a **supplied**
value — its presence makes the response ambiguous; it is never silently
ignored. An **absent** alias contributes nothing and is never invented as
zero.

### 2.4 Classification precedence (v1.0.12 §3.2)

The deterministic diagnosis evaluates, in order:

1. **Value-level validation of EVERY supplied alias in EVERY supplied
   container** — a malformed value or an alias/container disagreement is
   CONTRADICTORY. This runs first so a contradiction can never be concealed
   by an incomplete field set (the v1.0.11 first-value trap stays closed).
2. **The required-field gate** — a missing REQUIRED field (total /
   current_page / total_pages) is INCOMPLETE. This runs before relationship
   validation: a response that is missing a mandated field reports
   INCOMPLETE even when the supplied fields happen to contradict each other.
   Both verdicts keep the outcome AMBIGUOUS — the precedence affects only
   the diagnosis string, never the money-safety of the outcome.
3. **Relationship validation** between PRESENT + VALID groups (v1.0.11 §3.4,
   unchanged): `total < returned`, `returned > per_page`, `total = 0` with
   `current_page > 1` or `total_pages > 1`, `total > 0` with
   `total_pages = 0`, `current_page > total_pages`, `total > per_page ×
   total_pages`, and the truncation rule `total > returned` ⇒ INCOMPLETE.

The documented provider exception (tested) is unchanged: an empty result may
report `total = 0, current_page = 1, total_pages = 0` — the authoritative
empty-result convention stays CONSISTENT.

---

## 3. Joint container validation (v1.0.12 §4)

### 3.1 Every supplied container is preserved and validated TOGETHER

The v1.0.11 extraction selected the nested `data.meta.pagination` object and
DROPPED the outer `data.meta` fields when both were supplied. The two
containers may carry CONTRADICTORY information — the v1.0.12 **§4.1 finding**
(outer `total: 1` + nested `total: 0`) could silently resolve to the nested
value. v1.0.12 closes this: ALL containers supplied on a response are
extracted and validated as one set —

* outer `data.meta` fields,
* nested `data.meta.pagination` fields,
* envelope `meta.page_info` (when supplied alongside the content revision).

Shared fields must **agree exactly across every container**; any
disagreement is CONTRADICTORY (AMBIGUOUS outcome).

### 3.2 Container-level malformed evidence (v1.0.12 §4.5)

| Observation | Classification |
|---|---|
| `data.meta` absent | ABSENT — contributes nothing (S2 then fails the required gate) |
| `data.meta` `null` / non-object / array | **MALFORMED** — a supplied container that is not usable is never silently ignored |
| `data.meta.pagination` absent | nested container not supplied; outer container still validated |
| `data.meta.pagination` `null` / non-object / array | **MALFORMED** — and it can **NEVER authorize fallback to the outer container** |
| `data.meta.pagination` `{}` | a supplied EMPTY container — contributes no evidence, cannot contradict anything, and never satisfies the required fields by itself |
| `meta.page_info` `null` / non-object | MALFORMED / UNRECOGNIZED (v1.0.11 rules preserved) |

The §4.5 rule is deliberate: a null/malformed nested container is *evidence
the response is not trustworthy*. Letting it fall back to the outer container
would reward exactly the malformed responses a defensive integration must
reject.

### 3.3 Positive effects of the joint design

Required fields may be satisfied collectively across containers (e.g. outer
carries `total`, nested carries `current_page` + `total_pages`) — accepted
when nothing disagrees. This is the additive half of the contract: the joint
validation is strict about contradictions and permissive about complements.

---

## 4. Transfer identity requirements (v1.0.11 §4 — unchanged)

The exact-identity establishment for FOUND is unchanged:

```text
Requested merchant reference = List merchant reference = Detail merchant reference
List transfer ID = Detail transfer ID
```

A missing/`null`/empty/malformed detail id ⇒ AMBIGUOUS; a detail id ≠ list id
⇒ AMBIGUOUS; a detail reference ≠ requested reference ⇒ AMBIGUOUS; multiple
list matches ⇒ AMBIGUOUS; a non-empty validated page without the requested
reference ⇒ AMBIGUOUS (filter not honored). Under v1.0.12 the additional
prerequisite is structural: **the page itself must be a validated S1/S2
shape with a CONSISTENT joint pagination verdict before ANY identity rule is
evaluated** — including the metadata-free-array rule of §1.1.

Lookup outcomes remain the four-valued contract (`FOUND`, `NOT_FOUND`,
`AMBIGUOUS`, `ERROR` — v1.0.9 §2.1). ERROR is never silently converted to
NOT_FOUND; AMBIGUOUS never authorises a second transfer.

---

## 5. Deterministic lookup sequence (v1.0.11 §6, tightened v1.0.12)

Implemented in `backend/src/payouts/adapters/flutterwave-payout.adapter.ts`
(`findTransferByReference`):

1. Validate HTTP result (transport/HTTP failures classify first).
2. Validate provider response status (`success` envelope only).
3. Validate + classify the response shape (S1/S2 — the v1.0.11 S3 class is
   REMOVED; a metadata-free array is S4/UNSUPPORTED).
4. Validate pagination metadata where the shape requires it — MANDATORY for
   S1/S2, with the per-shape required field set (§2.1) enforced across EVERY
   supplied container jointly (§3).
5. Empty VALIDATED page ⇒ authoritative NOT_FOUND. Nothing else is.
6. Validate list record identity.
7. Resolve the exact requested-reference match (multiple matches ⇒
   AMBIGUOUS).
8. Match must carry a valid transfer id.
9. Retrieve the detailed transfer for the list-identified id.
10. Detail must carry the exact requested reference.
11. Detail must carry a valid transfer id equal to the list id.
12. FOUND only after every mandatory check passed.

---

## 6. Ambiguous lookups and recovery (v1.0.11 §8 — unchanged)

When the adapter returns AMBIGUOUS, the payout pipeline (unchanged in this
release, regression-covered) preserves the withdrawal reservation, preserves
the payout attempt, provider reference, idempotency key; creates no new
attempt; submits no second transfer; does not mark the withdrawal failed;
releases nothing; blocks competing manual settlement via the durable
settlement guard; records an auditable reconciliation event and escalates to
manual review / controlled lookup retry. Only a genuine authoritative
NOT_FOUND may re-arm the SAME durable attempt (same reference, same
idempotency key) after full revalidation. See
`docs/INCIDENT_RUNBOOK_AMBIGUOUS_PAYOUT.md` for the investigation procedure.

---

## 7. v1.0.12 test matrix

`backend/src/payouts/adapters/flutterwave-pagination-integrity-v112.spec.ts`
(new, 55 tests in 8 suites):

* **§3** — per-shape mandatory field sets: each of the three mandated fields
  omitted individually on S1 and S2 ⇒ AMBIGUOUS; bare `total: 0` and
  `total: 3` (the §3.1 finding) ⇒ AMBIGUOUS; complete sets (with and without
  `page_size`) ⇒ authoritative NOT_FOUND; positive S1 control with evidence
  `shape: PAGINATED_ARRAY`; the §3.2 precedence pinned at verdict level.
* **§3.3/§3.4** — one-based `current_page`: `0`, `-1`, `1.5` ⇒ malformed.
* **§4** — joint containers: the §4.1 outer/nested contradiction
  (`total: 1` outer + `total: 0` nested) ⇒ AMBIGUOUS with the disagreement in
  the reason; agreeing containers ⇒ NOT_FOUND; fields SPLIT across containers
  ⇒ NOT_FOUND; empty nested container contributes nothing (both directions);
  `data.meta` null/"string", `data.meta.pagination` null/"string"/array ⇒
  MALFORMED, never outer-fallback; three-container agree ⇒ NOT_FOUND; three-
  container disagreement ⇒ AMBIGUOUS; FOUND requires the full joint
  validation.
* **§4.7** — the full cross-container consistency matrix: contradictions in
  either direction (`outer total 0` + `nested total 1`), per-field
  disagreements (`current_page`, `total_pages`), alias-level disagreement
  (`total` vs `total_count` carrying different values), a primitive (number)
  pagination container, the required outer container missing entirely, the
  nested container NOT required (flat `data.meta` satisfying the mandate
  stays authoritative), and the three-container agreement regression.
* **§8.1** — the mandatory-field combination matrix (spec table): paired
  field absences, positive total with a missing context field, fractional
  `total_pages`, `current_page > total_pages`, and the documented zero-page
  empty convention (`total 0, current_page 1, total_pages 0`) staying
  CONSISTENT.
* **§9** — payout recovery scenarios A–E at adapter level (A: bare total 0,
  B: outer/nested contradiction, C: metadata-free array ⇒ AMBIGUOUS, no
  resubmission trigger; D: valid identity ⇒ FOUND reconciles the original
  transfer; E: authoritative absence ⇒ NOT_FOUND as the only resubmission
  precondition; F remains the retained real-PostgreSQL concurrency suite).
* **§5** — S3 removal: empty metadata-free array ⇒ AMBIGUOUS (reason carries
  the §5 wording); match-carrying metadata-free array ⇒ AMBIGUOUS in both
  directions; non-empty array without the reference ⇒ AMBIGUOUS; unrecognized
  envelope meta never rescues the shape; paginated regression guards (S2
  NOT_FOUND + FOUND still authoritative).

Updated legacy matrices (expectations corrected to the v1.0.12 semantics,
outcomes stay fail-closed):

* `flutterwave-pagination-identity.spec.ts` §9.4 — the four legacy-array
  tests now assert AMBIGUOUS per §5.
* `payout-adapters-v110.spec.ts` — bare-array NOT_FOUND test corrected to
  AMBIGUOUS; bare-total verdict corrected to INCOMPLETE; the precedence rule
  for `total: 0, current_page: 3` pinned (INCOMPLETE without `total_pages`,
  CONTRADICTORY with it).
* `payout-lookup-classification.spec.ts` — bare-array NOT_FOUND corrected to
  AMBIGUOUS.

---

## 8. External provider sandbox verification status

**BLOCKED** — `FLUTTERWAVE_SECRET_KEY` and `PAYSTACK_SECRET_KEY` sandbox
credentials are not available in this build environment. No sandbox
authentication, transfer initiation, list-lookup, pagination or
detail-verification test was executed against the live provider. Nothing in
this release claims provider-side verification. The tightened contract is
strictly more conservative than v1.0.11: every response that v1.0.12
classifies NOT_FOUND was already classified NOT_FOUND by v1.0.11; the delta
is exclusively responses moving from NOT_FOUND/FOUND into AMBIGUOUS. The
operational risk of the change is bounded to additional manual reviews.
