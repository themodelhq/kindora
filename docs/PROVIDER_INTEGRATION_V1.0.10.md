# KINDORA Provider Integration — v1.0.10

Paystack and Flutterwave PAYOUT (transfer) integration reference for the v1.0.10
security-hardening release. Supersedes the lookup sections of
`PROVIDER_INTEGRATION_V1.0.9.md`; initiation/beneficiary semantics are unchanged
and documented there.

## 1. Paystack payout adapter

### Transfer initiation (unchanged)
`POST https://api.paystack.co/transfer` — `{ source: "balance", recipient:
<recipient_code>, reference: <kdo-payout-…>, amount: <minor units as a raw JSON
integer token>, reason, currency }`. Definite 4xx rejections (parsed provider
error, no transfer created) throw `PayoutProviderRejectedError`; ambiguous
failures (5xx, transport) throw `PayoutTransportError`; duplicate-reference
errors are treated as AMBIGUOUS (the transfer may already exist).

### Reference-based recovery lookup — v1.0.10 identity gate
`findTransferByReference(reference)` → `GET /transfer/<reference>`:

- The outcome contract is unchanged: NOT_FOUND only through the documented
  predicate (HTTP 404 + `{ status: false, message: "Transfer not found" }`, no
  data); 401/403 → ERROR; 429/5xx → AMBIGUOUS; timeout/reset/malformed/empty →
  AMBIGUOUS.
- **NEW — exact reference identity:** a FOUND record is adopted only when the
  authoritative record's own `data.reference` field is present and EXACTLY equal
  to the requested reference. A record carrying only a `transfer_code` or
  numeric id is AMBIGUOUS (`recordHasTransferCode` / `recordHasTransferId`
  evidence). A different reference is AMBIGUOUS (identity mismatch). The
  comparison is deterministic and case-sensitive (Paystack resolves merchant
  references verbatim — no normalization is applied, per the provider contract).
- AMBIGUOUS lookups never trigger a second transfer; the stable idempotency key
  and provider reference are preserved.

### Test matrix (v1.0.10 §9 — unit-proven)
Exact reference → FOUND; different reference → AMBIGUOUS; missing/null/empty
reference → AMBIGUOUS; case-different reference → AMBIGUOUS; documented
not-found body → NOT_FOUND; 404 unknown payload → AMBIGUOUS; malformed 404 body →
AMBIGUOUS; 401/403 → ERROR; 429/500 → AMBIGUOUS; timeout/connection reset →
AMBIGUOUS; success envelope missing transfer fields → AMBIGUOUS.

## 2. Flutterwave payout adapter

### Transfer initiation (unchanged)
`POST https://api.flutterwave.com/v3/transfers` — inline beneficiary fields,
MAJOR-unit amount embedded as an EXACT decimal token (BigInt arithmetic; no
float). Mobile-money payouts remain DISABLED by default
(`PAYOUT_FLW_MOBILE_MONEY_ENABLED`) until sandbox-verified.

### Reference-based recovery lookup — v1.0.10 pagination + identity gates
`findTransferByReference(reference)` → `GET /v3/transfers?reference=<ref>`:

- **Pagination validation (the v1.0.10 finding).** An empty list alone is never
  proof of absence. The paginated shape (`data: { content, meta }`) requires
  PRESENT and INTERNALLY CONSISTENT pagination metadata for an authoritative
  NOT_FOUND: a required provider result count (`meta.pagination.total` —
  `total`/`total_count`/`totalCount`/`count` aliases checked defensively);
  malformed types, contradictory counts (`total < returned`, alias disagreement,
  `total > per_page × total_pages`, `current_page > total_pages`), zero totals
  with pages beyond page 1, truncated pages (`total > returned`) and
  missing/malformed meta are all AMBIGUOUS. The plain-array shape (`data: []`)
  remains authoritative absence (a complete non-paginated result).
- **Exact reference identity.** List entries must match the requested reference
  EXACTLY (case-sensitive, verbatim echo). Multiple entries with the same
  reference are AMBIGUOUS. The matched entry is verified through the detailed
  lookup (`GET /v3/transfers/:id`) and adopted only when the detailed record
  carries the exact requested reference AND belongs to the listed transfer
  (`evidence.id === list id`). A NOT_FOUND detail behind an existing list match
  is a contradiction → AMBIGUOUS (never NOT_FOUND — that would arm a duplicate
  submission while the transfer provably exists).
- The pagination consistency gate runs BEFORE adoption as well: malformed,
  truncated or contradictory pagination refuses adoption even when a matching
  entry is present (§9: contradictory pagination → AMBIGUOUS).

### Test matrix (v1.0.10 §3.3/§9 — unit-proven)
Valid matching transfer (list + detail identity) → FOUND; empty content with
`meta.total = 1` → AMBIGUOUS (the finding); empty content, flat `total > 0` →
AMBIGUOUS; empty content with consistent zero-total pagination → NOT_FOUND;
plain empty array → NOT_FOUND; contradictory page metadata (current_page 2 with
empty result) → AMBIGUOUS; missing pagination metadata on the paginated shape →
AMBIGUOUS; malformed total (`"1"`) → AMBIGUOUS; missing content field →
AMBIGUOUS; null content → AMBIGUOUS; unexpected shape → AMBIGUOUS; error
envelope → AMBIGUOUS; truncated page with the match present → AMBIGUOUS;
list/detail reference mismatch, id mismatch, duplicate references, id-only
detail record, case-different reference, numeric reference → AMBIGUOUS;
401/403 → ERROR; 429/500 → AMBIGUOUS; timeout/reset/malformed/empty →
AMBIGUOUS; unexpected status → ERROR; id-lookup 404 → AMBIGUOUS (Flutterwave
documents no authoritative not-found body for `GET /v3/transfers/:id`).

## 3. Sandbox verification status

The external provider sandbox suite (§14) is **BLOCKED** for v1.0.10: no sandbox
credentials are present in the build environment. The missing environment
variables (recorded by name only, values never stored in the repository):

- `PAYSTACK_SECRET_KEY` (sandbox secret key)
- `FLUTTERWAVE_SECRET_KEY` (sandbox secret key)

What this blocks: live authentication, transfer initiation, duplicate-reference
behaviour, paginated/lookup responses and recovery behaviour against the real
provider sandboxes for both providers.

What was executed instead: the full local verification matrix — 438 backend unit
tests (including the §9 provider response matrices above against realistic
fixtures), 63 real-PostgreSQL/Redis integration tests (including the seven
deterministic concurrency scenarios), TypeScript compilation, lint, production
builds and migration validation.

Because the sandbox suite is BLOCKED, the release is classified **STAGING
READY** — not PRODUCTION CANDIDATE. To complete sandbox verification, provide
the two sandbox credentials in the deployment environment (never in the
repository), enable `PROVIDER_MODE=live` in a STAGING deployment only, and run
the staging verification checklist in `docs/DEPLOYMENT_GUIDE.md`.
