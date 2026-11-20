# PROVIDER INTEGRATION — v1.0.11

**KINDORA v1.0.11 — Flutterwave Pagination Integrity & Transfer Identity Lockdown**
Scope: the Flutterwave PAYOUT adapter lookup path only. Paystack/Stripe payout
semantics, donation flows and the payout state machine are UNCHANGED.

---

## 1. Supported Flutterwave list response shapes (explicit, documented)

The reference-filtered lookup `GET /v3/transfers?reference=<ref>` recognises
EXACTLY the following shapes. Anything else is **AMBIGUOUS** — never
interpreted as complete, never interpreted as non-paginated.

| Shape | Structure | Pagination metadata | Completeness rule |
|---|---|---|---|
| **S1 — Official paginated array** (current v3 contract) | `data: [...]` + envelope-level `meta.page_info` | MANDATORY: valid, complete, internally consistent | Empty + consistent ⇒ authoritative NOT_FOUND; otherwise identity rules |
| **S2 — Content revision** | `data: { content: [...], meta... }` | MANDATORY (at `data.meta.pagination` or flat `data.meta`) | Same as S1 |
| **S3 — Legacy complete array** | `data: [...]` with NO pagination container of any recognised kind supplied anywhere | none supplied | The bare array is the complete result set (v1.0.9/v1.0.10 verified fixtures) |
| **S4 — anything else** | unknown structures, unrecognized metadata containers, `data.meta` without `content` | — | **AMBIGUOUS** |

### Provider-contract verification (v1.0.11 §13)

Verified 2026-11 against the official v3 OpenAPI description published at
`developer.flutterwave.com/api/v3/openapi.json`:

* `GET /v3/transfers` — `data` is a **plain transfer array**; pagination
  metadata lives at the **envelope top level**: `meta.page_info.{total,
  current_page, total_pages}` (example value: `total: 688, current_page: 1,
  total_pages: 69`).
* `page_size` is a documented `page_info` field on other v3 list endpoints
  (refunds, settlements, chargebacks) — it is therefore a **contract-backed
  alias** of the page-size property. No other aliases were added.
* `GET /v3/transfers/:id` — `data` carries `id` (numeric) and `reference`
  (string echo). **No 404 not-found body is documented** → a bare HTTP 404
  on the id lookup stays AMBIGUOUS (v1.0.9 §2.2 rule preserved).
* Query parameters of the list endpoint: `reference`, `status`, `page`,
  `from`, `to`.

**Documented discrepancy (recorded per §13, treated as unresolved until
sandbox-verified):** the official contract always carries `meta.page_info`
on list responses, while the integration additionally supports a legacy
revision that returns a bare `data` array with no metadata. A bare array
with no metadata anywhere is classified S3 (complete) because it is
byte-indistinguishable from the legacy revision; ANY envelope `meta` object
on an array response makes the response paginated (S1) and the metadata
MANDATORY. `page_info` supplied as `null` or a non-object is malformed
(AMBIGUOUS); an envelope `meta` object without a `page_info` key is an
unrecognised structure (AMBIGUOUS).

---

## 2. Pagination metadata requirements (v1.0.11 §3/§5)

### 2.1 Alias groups

Every supplied alias in every recognised container is validated
independently; aliases and containers representing the same property must
**agree exactly**, otherwise the response is contradictory.

| Property | Aliases | Minimum |
|---|---|---|
| total results | `total` \| `total_count` \| `totalCount` \| `count` | 0 |
| current page | `current_page` \| `page` \| `currentPage` | 0 |
| total pages | `total_pages` \| `pageCount` \| `pages` | 0 |
| page size | `per_page` \| `pageSize` \| `page_size` | 1 |

Recognised containers: `meta.page_info` (S1, official), `data.meta.pagination`
and `data.meta` (S2). Values in different containers representing the same
property must agree (mixed-revision defense).

### 2.2 Strict integer constraints

A supplied value is valid **only** if it is a JSON finite number that is a
safe integer within the field's minimum. REJECTED (malformed/contradictory):
fractional values, negative values, `NaN`, `Infinity` (including via
`1e999` in raw JSON), numeric strings (`"10"`, `"10invalid"` — no
`parseInt`-style leniency exists anywhere in the path), empty strings,
booleans, objects/arrays, and `null`.

A `null` is a **supplied** value — its presence makes the response ambiguous;
it is never silently ignored. An **absent** alias (key not present)
contributes nothing and is never invented as zero. The result count
(`total`) is REQUIRED: if no alias of the group is supplied anywhere, the
response is unverifiable (AMBIGUOUS) — absence cannot be established without
it.

### 2.3 Relationship validation

Checked only between groups that are PRESENT and VALID:

* `total < returned record count` ⇒ contradictory;
* `returned record count > per-page size` ⇒ contradictory;
* `total = 0` with `current_page > 1` ⇒ contradictory;
* `total = 0` with `total_pages > 1` ⇒ contradictory;
* `total > 0` with `total_pages = 0` ⇒ contradictory;
* `current_page > total_pages` (when `total > 0`) ⇒ contradictory;
* `total > per_page × total_pages` (when both supplied) ⇒ contradictory;
* `total > returned record count` (all relationships otherwise fine) ⇒
  the page set is **truncated** — unverifiable.

Documented provider exception (tested): an empty result may report
`total = 0, current_page = 1, total_pages = 0` — this is the authoritative
empty-result convention and stays CONSISTENT.

### 2.4 Verdict classes

* **CONSISTENT** — every supplied field valid, all relationships hold.
* **INCOMPLETE** — required metadata missing, or the page set is truncated.
* **CONTRADICTORY** — malformed values, alias/container disagreements,
  impossible relationships.

Any non-CONSISTENT verdict keeps the lookup outcome **AMBIGUOUS**, in BOTH
directions: contradictory metadata can never classify as NOT_FOUND, and a
matching reference inside an unverifiable page can never be adopted (FOUND).

---

## 3. Transfer identity requirements (v1.0.11 §4)

For the lookup to return FOUND, ALL of the following must be established by
the provider's own evidence:

```text
Requested merchant reference = List merchant reference = Detail merchant reference
List transfer ID = Detail transfer ID
```

* **List record validation** — every record must be a transfer object; a
  present id must be a positive safe integer; a present reference must be a
  non-empty string; two records sharing one provider id must not carry
  conflicting references. The MATCHED record MUST carry a valid transfer id.
* **Detail record validation** — the detailed transfer MUST carry a valid
  transfer id (missing / `null` / empty / malformed ⇒ AMBIGUOUS) and it MUST
  equal the list transfer id; the detail reference MUST be present and MUST
  equal the requested reference exactly (case-sensitive, no normalisation;
  a transfer id or code never substitutes the reference).
* **Why a missing detail id produces AMBIGUOUS** — the id is the ONLY
  provider-native link between the reference-filtered list result and the
  detailed record. Without it, the detail record's identity cannot be
  proven to belong to the listed transfer, and adopting it would trust a
  reference match alone. A missing detail id therefore fails closed.
* **Why missing pagination metadata prevents positive adoption** — a
  reference inside an incomplete/unverifiable page does not establish that
  the page set is complete or that the record belongs to a trustworthy
  result. The eight-point establishment order (§5.4) must all pass before
  FOUND.

Lookup outcomes remain the four-valued contract (`FOUND`, `NOT_FOUND`,
`AMBIGUOUS`, `ERROR` — v1.0.9 §2.1). ERROR is never silently converted to
NOT_FOUND; AMBIGUOUS never authorises a second transfer.

---

## 4. Deterministic lookup sequence (v1.0.11 §6)

Implemented in `backend/src/payouts/adapters/flutterwave-payout.adapter.ts`
(`findTransferByReference`):

1. Validate HTTP result (transport/HTTP failures classify first).
2. Validate provider response status (`success` envelope only).
3. Validate + classify the response shape (S1/S2/S3/S4).
4. Validate pagination metadata where the shape requires it (MANDATORY for
   S1/S2).
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

## 5. Ambiguous lookups and recovery (v1.0.11 §8 — unchanged from v1.0.10)

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

## 6. External provider sandbox verification status

**BLOCKED** — `FLUTTERWAVE_SECRET_KEY` and `PAYSTACK_SECRET_KEY` sandbox
credentials are not available in this build environment. No sandbox
authentication, transfer initiation, list-lookup, pagination or
detail-verification test was executed against the live provider. Nothing in
this release claims provider-side verification. The v1.0.10 Paystack
regression suite (unit + integration, mocked provider boundary) was executed
and green: the Flutterwave-specific changes do not touch Paystack code paths.
