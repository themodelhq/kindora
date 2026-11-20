# PROVIDER INTEGRATION — v1.0.13

**KINDORA v1.0.13 — Strict Flutterwave Envelope Validation**
Scope: the Flutterwave PAYOUT adapter lookup path only. Everything else
(Paystack/Stripe payout semantics, donation flows, the payout state
machine, the v1.0.12 pagination contract) is UNCHANGED and
regression-covered.

---

## 1. Envelope metadata classification (v1.0.13 §4 — the corrected table)

`extractFlwEnvelopeMeta()` classifies the TOP-LEVEL Flutterwave envelope
`meta` field of the list response. `undefined` and `null` are materially
DIFFERENT conditions — the v1.0.12 defect collapsed them into one case:

| Input | Classification | Effect on the lookup |
|---|---|---|
| `meta === undefined` | **ABSENT** | no envelope container supplied; the S1 array then falls under the §5 bare-array rule; the S2 content shape proceeds on its own containers |
| `meta === null` | **MALFORMED** | explicitly supplied malformed evidence — the response is UNSUPPORTED ⇒ AMBIGUOUS, even when another container carries valid fields |
| `meta` is a string / number / boolean | **MALFORMED** | same |
| `meta` is an array | **MALFORMED** | same |
| `meta` is an object WITHOUT `page_info` | **UNRECOGNIZED** | an unrecognized pagination structure ⇒ AMBIGUOUS (existing contract) |
| `meta.page_info === undefined` | **UNRECOGNIZED** | same |
| `meta.page_info === null` | **MALFORMED** | supplied-and-malformed ⇒ AMBIGUOUS |
| `meta.page_info` primitive / array | **MALFORMED** | same |
| `meta.page_info` valid object | **PRESENT** | subject to the FULL v1.0.12 pagination validation (nothing weakened) |

### 1.1 The defect and the exploit shape it closed

v1.0.12's implementation returned ABSENT for both `undefined` and `null`.
Because the joint container validation adds the envelope container ONLY
when PRESENT and rejects the shape only on MALFORMED/UNRECOGNIZED, a null
envelope was silently ignored while the nested `data.meta` container alone
carried the classification. The documented exploit fixture

```json
{
  "status": "success",
  "meta": null,
  "data": {
    "content": [],
    "meta": { "total": 0, "current_page": 1, "total_pages": 1 }
  }
}
```

therefore classified as an authoritative NOT_FOUND in v1.0.12 — an
automatic resubmission trigger for a transfer that may actually exist.
Under v1.0.13 the same response is **AMBIGUOUS** with the reason
"envelope meta is null — explicitly supplied envelope metadata is
malformed evidence and is never silently ignored (v1.0.13 §4)". The
fixture is executed VERBATIM in
`backend/src/payouts/adapters/flutterwave-envelope-null-v113.spec.ts` (#8).

### 1.2 No-upgrade invariant

A response with ANY malformed envelope evidence (`null`, primitives,
arrays, malformed `page_info`) can produce **neither NOT_FOUND nor FOUND**
— regardless of what the other containers carry. Both directions are
matrix-tested (9 malformed variants on an otherwise-authoritative empty
page; 5 malformed variants on a page carrying the exact requested
transfer). The classification is also independent of the ARRANGEMENT of
the supplied containers: wherever the valid evidence sits (flat
`data.meta`, nested `data.meta.pagination`), the null envelope forces the
same AMBIGUOUS outcome, and ONLY a genuinely valid envelope restores the
authoritative classification.

---

## 2. Pagination contract (v1.0.12 rules — PRESERVED UNCHANGED, §5 of the release prompt)

Retained exactly as documented in `PROVIDER_INTEGRATION_V1.0.12.md` and
regression-locked by the retained test matrices:

* **Per-shape mandatory field sets** (`FLW_REQUIRED_S1`,
  `FLW_REQUIRED_S2`): `{total, current_page, total_pages}` REQUIRED for
  both S1 (official `data: [...]` + envelope `meta.page_info`) and S2
  (`data.content` + `data.meta`); `page_size` OPTIONAL, validated strictly
  when supplied. Missing mandated fields ⇒ INCOMPLETE ⇒ AMBIGUOUS.
* **Strict value validation** on every supplied alias: null/booleans/
  numeric strings/fractional/negative/NaN/±Infinity/unsafe integers are
  rejected; absent values are never invented as zero; `current_page` is
  one-based (minimum 1).
* **Joint container validation**: outer `data.meta`, nested
  `data.meta.pagination` and the envelope `meta.page_info` are validated
  TOGETHER; shared fields must agree exactly; malformed containers never
  authorize outer-fallback; empty `{}` containers contribute nothing;
  required fields may be satisfied collectively across containers when
  nothing disagrees.
* **S3 stays removed**: every metadata-free `data: [...]` array is
  AMBIGUOUS in both directions. The S1/S2 shape distinction is preserved —
  the shapes are NOT merged into a permissive parser.
* **Classification precedence** (v1.0.12 §3.2): value-level malformation →
  required-field gate → relationship validation; every non-CONSISTENT
  verdict keeps the outcome AMBIGUOUS.

## 3. Transfer identity and lookup outcomes (unchanged)

* **FOUND** requires: valid response, recognized shape, complete and
  consistent pagination evidence, exact requested-reference match, valid
  transfer identity on the list record AND the independently retrieved
  detail (id equality, reference equality), single match, and — per the
  provider contract — amount, currency, beneficiary and status checks on
  the settlement path. A partial match is never FOUND.
* **NOT_FOUND** is reachable ONLY through an authoritative, recognized
  response whose complete pagination state proves the relevant result set
  was fully searched, with no contradictory or malformed metadata and no
  unresolved transport ambiguity. NEVER authoritative: HTTP 401/403/429/
  5xx, network timeout, connection reset, malformed JSON, empty body,
  unexpected shape, missing pagination fields, explicit null metadata,
  conflicting aliases, contradictory containers, truncated results,
  metadata-free arrays, incomplete detail lookup.
* **AMBIGUOUS** preserves the reservation, the attempt, the provider
  reference and the idempotency key; creates no replacement transfer;
  never retries the external submission automatically; never marks the
  payout failed; never releases funds; blocks manual settlement via the
  durable guard; records the reason and diagnostic evidence; allows safe
  reconciliation after the provider becomes available. No fallback may
  convert AMBIGUOUS into NOT_FOUND without new authoritative evidence.

## 4. Deterministic lookup sequence (unchanged shape, tightened input)

The 12-step sequence in `findTransferByReference` is unchanged from
v1.0.11 §6/v1.0.12 §5; step 3 (shape classification) now consumes the
v1.0.13 envelope classification table, so a malformed envelope exits at
step 3 with a diagnostic reason instead of proceeding on partial
evidence.

## 5. v1.0.13 test matrix

`backend/src/payouts/adapters/flutterwave-envelope-null-v113.spec.ts`
(new, 27 tests): the §4.2 classification table end-to-end at lookup level
(§1 above), the verbatim §4.3 fixture, the no-upgrade invariant in both
directions, and container-arrangement independence. The retained matrices
(v112: 55, identity: 75, v110: 58, adapters: 16, lookup-classification:
37) re-executed green — the v1.0.12 pagination contract has no observed
behavioural drift.

## 6. External provider sandbox verification status

**BLOCKED** — `FLUTTERWAVE_SECRET_KEY` and `PAYSTACK_SECRET_KEY` sandbox
credentials are not available in this build environment. No sandbox
authentication, transfer initiation, list-lookup, pagination,
null-envelope or detail-verification test was executed against the live
providers. Nothing in this release claims provider-side verification. The
correction is strictly more conservative: the delta vs v1.0.12 is
exclusively responses carrying malformed envelope evidence moving INTO
AMBIGUOUS; no response classifies MORE permissively than before. The
operational risk is bounded to additional manual reviews. When sandbox
credentials become available, run the §4.2 classification shapes (null
envelope with valid nested metadata first) against the sandbox list
endpoint before production rollout.
