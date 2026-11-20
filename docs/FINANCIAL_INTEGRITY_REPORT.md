# KINDORA v1.0.1 — Financial Integrity Report

This report documents the financial-integrity guarantees of KINDORA v1.0.1: how money is recorded, verified, reserved, reversed and reconciled, and which proofs exist. All tests cited were executed against a real PostgreSQL 18.6 instance (see TEST_REPORT.md for the full command matrix).

---

## 1. Ledger architecture (preserved, strengthened)

The double-entry ledger is the single source of financial truth. v1.0.0's engine was **preserved, not replaced**:

- All amounts are **BigInt minor units** (kobo/cents). Floating point never touches balances.
- Every `LedgerTransaction` enforces **Σ debits = Σ credits per currency** before any write, and its `reference` is unique (`@unique`), making every posting **exactly-once**:
  - `donation:<donationId>` — donation success
  - `fee:donation:<donationId>` — provider processing fee (NEW)
  - `match:<poolId>:<donationId>` — sponsor matching
  - `matchrev:<poolId>:<donationId>` — match reversal on refund (NEW)
  - `withdrawal:<withdrawalId>` — payout settlement
  - `refund:<refundId>` — refund reversal
- Ledger entries are **immutable**: no update/delete code path exists (re-verified by repo-wide grep in the audit).
- Chart of accounts (per-currency suffixes keep balances unambiguous): `1100:CLEARING:<CUR>` (ASSET), `2000:CAMPAIGN:<id>:<CUR>` (LIABILITY), `2400:MATCH_POOL:<id>` (LIABILITY), `4000:PLATFORM_REVENUE:<CUR>` (REVENUE), `5000:PROVIDER_FEES:<CUR>` (EXPENSE — now actually posted).
- **v1.0.1 additions:** `postProviderFee` (fee expense recognised, clearing reduced by the fee so clearing converges to the actual settlement amount) and `postMatchReversal` (sponsor funds restored to the pool when a donation is refunded). `ensureAccount` now tolerates the P2002 account-creation race instead of rolling back a money movement.

## 2. Payment verification — a donation exists only when money provably arrived

v1.0.0 trusted webhook payloads; v1.0.1 does not:

1. Webhook signature verified over the raw body per provider (HMAC-SHA512 for Paystack, `verif-hash` for Flutterwave, Stripe SDK `constructEvent`, PayPal verification API). Signature alone is **necessary but not sufficient**.
2. Event routing uses **explicit per-provider allowlists (default-deny)**. Unknown events can never complete a donation (e2e-proven: `payout.settled` acknowledged, zero financial writes).
3. Successful events trigger **authoritative provider verification**: the provider API must report `succeeded`, the amount must equal the donation's `amount + tipAmount` exactly, and the currency must match. Mismatches are rejected (`AMOUNT_MISMATCH` / `CURRENCY_MISMATCH` / `AMOUNT_UNAVAILABLE`), recorded on the WebhookEvent row, and never move money.
4. **Provider equality** (webhook provider == donation.provider) is enforced in the controller and again inside the state machine — a validly-signed Paystack event cannot complete a Flutterwave donation.
5. Only after all checks does the atomic state machine run: conditional `UPDATE … WHERE status = 'PENDING'` (exactly one winner) → ledger posting **inside the same transaction** → matching pool application (capped by remaining pool) → campaign counters → post-commit notifications.
6. Failure events from the terminal-failure allowlist flip PENDING → FAILED only for the matching provider; non-terminal provider retries are recorded without state changes.

**Proofs:** money-path e2e (duplicate verify + webhook replay keep balance at exactly 2,500,000; ledger transaction count for `donation:<id>` stays 1), webhook e2e (exactly-once application, invalid signature rejected with no `signatureValid=true` row).

## 3. Webhook idempotency

- `WebhookEvent` has a DB-unique `(provider, eventId)`; concurrent duplicate deliveries are absorbed (the P2002 loser is treated as duplicate, not a 500).
- Paystack supplies no event id — the adapter derives a deterministic `sha256(rawBody)` eventId, so exact replays dedupe at the webhook layer as well (unit-tested: same body → same id).
- Every delivery reaches a terminal state (`PROCESSED`/`FAILED` + `processedAt` + `handledAction`), giving reconciliation real observability (v1.0.0's `lastRunAt` was permanently null).
- Unknown references are acknowledged (200) — providers do not retry junk refs.

## 4. Refunds, chargebacks, disputes — compensating entries, never edits

- **One shared processor** (`RefundProcessorService`) serves admin refunds AND provider refund events, so every reversal: is guarded by a conditional update, posts compensating ledger entries in the same transaction, decrements campaign counters under guard, and writes an immutable audit record.
- **Partial refunds** split the charged amount proportionally between campaign share and tip; **full refunds** additionally reverse the sponsor matching (match reversal entries + pool `matchedAmount` decrement + `raisedAmount` correction).
- Refunds exceeding the refundable remainder are rejected; double refunds conflict at the ledger reference (409).
- **Admin refunds now execute at the provider** (Paystack/Flutterwave/Stripe/PayPal `refund()` implemented) — a refund is no longer marked PROCESSED without moving money. When the provider rejects, nothing is recorded (fail-safe).
- **Disputes/chargebacks** never count as donations: they create a HIGH-severity FraudSignal, an audit record, and notify the organizer; the eventual reversal arrives as a provider REFUND event or an admin refund.
- **Proof:** webhook e2e — `refund.processed` → donation REFUNDED, compensating REFUND ledger entries exist, `raisedAmount` decreases.

## 5. Withdrawal reservations — concurrency-safe

- Availability = campaign ledger balance − Σ(gross amount of ALL reservation-holding withdrawals: PENDING, UNDER_REVIEW, APPROVED, PROCESSING, REQUIRES_INFORMATION).
- Request creation locks the campaign row (`SELECT … FOR UPDATE` inside the transaction) and re-checks availability before inserting — simultaneous requests serialise; the loser sees the winner's reservation.
- Rejected/cancelled/failed withdrawals release reservations automatically (aggregate-based reservation model).
- Settlement posts `withdrawal:<id>` exactly once (P2002 → 409 proven by e2e) with the campaign liability debited gross, clearing credited net, platform fee to revenue.
- **Proof:** concurrent-overdraw e2e (two 800k requests vs 1,000,000 → exactly one succeeds; sum of reservations ≤ available).

## 6. Payout reconciliation and the Financial Control Centre (new)

Admin-only (`api/v1/admin/financial/*`, every action audited):

- **Financial summary** with per-currency buckets (never a combined-currency total): initiated/succeeded/pending/failed/refunded donations, fees, tips, campaign liability, reserved funds, paid withdrawals, outstanding payout liabilities, recurring schedules and failures, platform revenue, provider fees, clearing — filterable by date/provider/campaign/organization.
- **Payment reconciliation:** webhook events vs donations with anomaly classification (`PROVIDER_MISMATCH | AMOUNT_UNVERIFIED | REFERENCE_NOT_FOUND | UNKNOWN_EVENT | DUPLICATE | OK`) and counts.
- **Withdrawal reconciliation:** PAID payouts awaiting reconciliation (`needsReconciliation`), missing-evidence flags, outstanding reservations per currency.
- **Ledger integrity checks (read-only, never auto-fixing):** per-transaction debit=credit scan, campaign `raisedAmount` vs ledger-identity derivation (documented formula: healthy ⇔ `ledgerBalance == raisedAmount − Σ PAID withdrawal gross`), `totalCharged == amount + tip` checks.
- **CSV reports** (audited `REPORT_EXPORTED`): daily closing, campaign balances, withdrawals, refunds, platform fees — every row carries its currency; amounts in minor units with a `# minor units` header.

## 7. Recurring donations — real charges only

- The cron performs **real provider-side charges** (Paystack `charge_authorization` off-session) — v1.0.0's pending-only, schedule-advancing placeholder is gone.
- Schedule advances (`nextChargeAt`, `chargeCount`) **only after a confirmed successful charge**; failed charges create FAILED donation rows, increment `failureCount`, notify donor + organizer, and PAUSE the schedule after 3 failures. Transient errors write nothing and retry on the next run (durable idempotency key per cycle).
- `providerAuthRef` is now actually captured: the donation verify/webhook success path persists the provider's saved-authorization token (Paystack `authorization.authorization_token`), so schedules created from completed donations become chargeable. Schedules without a captured authorization are skipped with a donor notification (never fake-charged).
- Non-Paystack providers (no off-session model wired in this codebase) are explicitly skipped with a "needs attention" donor notice — success is never simulated.
- Repeated worker runs cannot double-charge: donation publicRef = per-cycle provider reference + durable idempotency key + ledger reference uniqueness.

## 8. Cached totals vs ledger truth

`Campaign.raisedAmount` and `donorCount` are denormalised counters kept consistent **inside the same transaction** as ledger postings (donation success, match, refund, match reversal, withdrawal). The Financial Centre's ledger-integrity check continuously reconciles counters against ledger balances; mismatches are reported, never auto-corrected.

## 9. Outstanding financial risks (disclosed)

1. **Live provider verification/refund/charge paths need credentials** — implemented, unit/integration-tested via the deterministic mock, but not exercised against real provider APIs in this environment.
2. **Settlement confirmation for manual payouts** relies on the administrator-supplied transfer reference + evidence (provider-verified transfer APIs are not wired for payout *originations*; the API records the channel, reference and evidence and surfaces unreconciled payouts). Dual approval above a configurable threshold mitigates.
3. **Exchange-rate conversions are not performed anywhere** — financial totals are strictly per-currency by design.
4. Matching-pool reversal on *partial* refunds intentionally keeps the match attached (documented); the integrity check will surface any drift.
