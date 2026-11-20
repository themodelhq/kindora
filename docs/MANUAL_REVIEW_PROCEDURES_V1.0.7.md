# KINDORA Manual Review Procedures — v1.0.7

**Release:** KINDORA v1.0.7_SECURITY_COMPLETE
**Audience:** platform administrators handling escalated payout cases.
**Governing code:** `backend/src/payouts/manual-review.service.ts`,
`backend/src/withdrawals/withdrawals.controller.ts`, `backend/src/mfa/`.

THE HARD RULE, stated first: **a manual review resolution can never manufacture a
settlement.** No resolution type, no administrator, no evidence file and no reference typed
into a case marks a payout PAID. Money leaves (or is recorded as settled) only through
authoritative provider verification or the separate manual-settlement path — both of which
keep their own approval, evidence and fresh-MFA gates.

Related: [PAYOUT_ARCHITECTURE_V1.0.7.md](PAYOUT_ARCHITECTURE_V1.0.7.md) |
[PROVIDER_INTEGRATION_V1.0.7.md](PROVIDER_INTEGRATION_V1.0.7.md) |
[ADMIN_FRESH_MFA_POLICY.md](ADMIN_FRESH_MFA_POLICY.md) |
[MANUAL_PAYOUT_EVIDENCE_POLICY.md](MANUAL_PAYOUT_EVIDENCE_POLICY.md)

---

## 1. Prerequisites for acting on a case

1. ADMIN role (the review endpoints are `@Roles('ADMIN')` and the service re-checks).
2. MFA enrollment completed (`POST /api/v1/mfa/enroll`, then `POST /api/v1/mfa/confirm`).
3. Redis available for the API: challenge issuance and consumption FAIL CLOSED with 503 when
   Redis is unreachable. There is no bypass.

## 2. Fresh MFA challenge flow

Every state-changing review call needs a single-use challenge token bound to a purpose:

```bash
# 1. Exchange a CURRENT TOTP code for a challenge token (ADMIN session required)
POST /api/v1/mfa/challenge
{ "purpose": "PAYOUT_MANUAL_REVIEW", "scope": "<withdrawalId>", "code": "123456" }
# -> { "token": "<one-time token>", ... }   TTL 120 seconds, single use

# 2. Call the protected endpoint with the token header
POST /api/v1/withdrawals/review-cases/<caseId>/resolve
x-mfa-challenge: <token>
{ ... resolution body ... }
```

Properties enforced by the backend: the token is stored only in Redis with a 120-second TTL;
consumption is atomic (a second use fails); a challenge issued for one purpose cannot
authorize another; a challenge scoped to one withdrawal never authorizes another; the TOTP
code itself is single-use per time step (replay suppressed). Each endpoint documents its
purpose below.

## 3. Case lifecycle

- Cases are opened AUTOMATICALLY by the system — the atomic reconciliation service (every
  fail-closed outcome), the initiation pipeline (withheld intents, stale unknowns) and the
  recovery sweeps. One OPEN case per attempt (idempotent).
- Case rows are never deleted (database trigger `manual_review_case_no_delete`); resolution
  is recorded with resolution type, note, resolver, reviewer, `mfaPurposeUsed` and an audit
  event (`MANUAL_REVIEW_CASE_RESOLVED`).
- An already-resolved case cannot be resolved again (409).

## 4. Reading cases (no MFA required, read-only)

```bash
GET /api/v1/withdrawals/review-cases?status=OPEN     # list (skip/limit supported)
GET /api/v1/withdrawals/review-cases/<caseId>        # detail incl. attempt + withdrawal
```

The admin UI surfaces the same data via `useManualReviewCases` and marks blocked-settlement
reasons with `settlementBlockedExplanation`.

## 5. Case categories and triage

| Category | What it means | Triage |
| --- | --- | --- |
| `AMOUNT_MISMATCH` | Provider-reported amount != approved amount (integer minor units compared). | Never settles automatically. Confirm in the provider dashboard whether the provider debited the approved amount; if the provider truly sent a different amount, record the decision (`RECORD_REVERSAL_DECISION` or `NO_INTERNAL_CHANGE`) and open a provider-side investigation. If it was an evidence artifact, `RETURN_TO_VERIFICATION` re-verifies. |
| `CURRENCY_MISMATCH` | Provider-reported currency != approved currency (case-insensitive exact; no conversion is assumed). | Treat like amount mismatch: establish what the provider actually sent before any decision. |
| `BENEFICIARY_MISMATCH` | Provider beneficiary evidence does not match the approved `PayoutBeneficiary.externalRef`. | HIGH priority: funds may be pointed at the wrong account. Check the provider dashboard for the actual recipient; contact the provider about recall if money left to the wrong account; document via `RECORD_REVERSAL_DECISION` or `NO_INTERNAL_CHANGE`. |
| `REFERENCE_MISMATCH` | The provider-returned reference does not belong to this attempt. | Verify in the provider dashboard which transfer the reference belongs to; if this is a data artifact, `RETURN_TO_VERIFICATION`; otherwise keep the case open path (`NO_INTERNAL_CHANGE`) pending provider clarification. |
| `DUPLICATE_REFERENCE` | The provider reference is bound to another attempt. | Determine which attempt is the real one; the duplicate can never settle. Document and resolve with `NO_INTERNAL_CHANGE` after the provider confirms only one transfer exists. |
| `PROVIDER_REVERSAL` | The provider reports the transfer reversed (e.g. recipient bank returned funds). | If the withdrawal is PAID it has moved to REVERSED. Decide recovery: re-initiate to a corrected beneficiary (destination change first, §5.4), or refund the campaign flow. Record with `RECORD_REVERSAL_DECISION`. |
| `INTERNAL_STATE_MISMATCH` | A committed intent no longer matches the withdrawal/approval state — submission was WITHHELD (nothing was sent to the provider). | Confirm no transfer exists in the provider dashboard. If the approval cycle must be redone, close with `NO_INTERNAL_CHANGE` and restart approvals (outbox is FAILED_PERMANENT; a new initiation is then possible). |
| `PROVIDER_DATA_INCOMPLETE` | Provider did not report amount, currency or beneficiary identity for an otherwise-successful transfer — fail closed. | Obtain the missing evidence from the provider dashboard/export, attach it as a registered evidence file, then `RETURN_TO_VERIFICATION` (API verification is authoritative; if the API still omits fields, escalate to the provider). |
| `PROVIDER_UNKNOWN` | Verification could not classify the transfer, or a submission stayed ambiguous beyond `PAYOUT_UNKNOWN_ESCALATION_MINUTES` (default 120). | Check the provider dashboard for the submission reference (`kdo-...`). If a transfer exists and succeeded, `RETURN_TO_VERIFICATION` triggers authoritative verification. If none exists, the intent can be closed (`NO_INTERNAL_CHANGE`) once the outbox state allows a clean re-initiation. |
| `PROVIDER_PENDING` | Transfer verified as in progress. | Informational: wait; the recovery sweeps re-verify. No resolution needed while the transfer progresses. |
| `PROVIDER_UNAVAILABLE` | The provider API could not be reached during verification (transport failure classified UNKNOWN). | Reservation intact. Retry after the provider recovers (`RETURN_TO_VERIFICATION` or wait for the sweep). |
| `PROVIDER_SUCCESS_INSUFFICIENT_BENEFICIARY_EVIDENCE` | Legacy-compatible spelling of incomplete beneficiary evidence on a success. | Same triage as `PROVIDER_DATA_INCOMPLETE`. |
| `STUCK_OUTBOX_EVENT` | A committed outbox intent appears stuck (retry/claim anomalies). | Inspect `PayoutOutbox` status + `lastError`; use `RETURN_TO_VERIFICATION` after confirming provider state, or keep open for engineering review. |

## 6. Resolving a case

```bash
POST /api/v1/withdrawals/review-cases/<caseId>/resolve        # purpose: PAYOUT_MANUAL_REVIEW
x-mfa-challenge: <token>
{
  "resolution": "RETURN_TO_VERIFICATION"
              | "CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE"
              | "RECORD_REVERSAL_DECISION"
              | "NO_INTERNAL_CHANGE",
  "note": "<required, max 1000 chars>",
  "evidenceFileId": "<required for CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE>",
  "reviewerId": "<required for CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE: a SECOND, DISTINCT admin>"
}
```

| Resolution | System effect |
| --- | --- |
| `RETURN_TO_VERIFICATION` | Attempt `MANUAL_REVIEW -> UNKNOWN`; re-enters the verification queue (sweeper/worker/API verify). Nothing settles by itself. |
| `CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE` | Records the independent review + evidence hash on the case; attempt becomes `MANUAL_REVIEW` with classification `MANUAL_CONFIRMED_WITH_EVIDENCE`; a PROCESSING withdrawal moves to `REQUIRES_RECONCILIATION`. The withdrawal does NOT become PAID. Settlement still requires authoritative provider verification (`POST /withdrawals/attempts/:attemptId/verify`) or the manual-settlement path (`POST /withdrawals/:id/settle`). |
| `RECORD_REVERSAL_DECISION` | Audit event `PAYOUT_REVERSAL_DECISION_RECORDED` with your note; attempt and withdrawal untouched. |
| `NO_INTERNAL_CHANGE` | Only the case is closed; attempt + withdrawal untouched. |

## 7. Evidence rules

- `CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE` requires `evidenceFileId`: a registered PRIVATE
  evidence file (StoredFile kind `PAYOUT_EVIDENCE`), uploaded through the storage pipeline,
  bound to this workflow — arbitrary URLs are rejected by design
  ([MANUAL_PAYOUT_EVIDENCE_POLICY.md](MANUAL_PAYOUT_EVIDENCE_POLICY.md)).
- The case stores `evidenceFileId` plus a SHA-256 evidence hash binding
  `(caseId, evidenceFileId, note)`; access goes through the audited
  `GET /withdrawals/:id/evidence-url` short-lived URL flow.
- Evidence must come from the provider side (dashboard export, provider confirmation).
  Screenshots of internal admin screens are not provider evidence.
- Provider responses quoted in notes must not contain secrets or full account numbers; the
  platform persists masked details only.

## 8. Independent-reviewer requirement

- Success confirmations require `reviewerId`: a second, DIFFERENT administrator with ADMIN
  role. `reviewerId === resolver` is rejected with 400. The reviewer's identity is stored on
  the case and in the audit event.
- This is in addition to (not a replacement for) the dual-approval + executor-separation
  rules that gated the original payout: requester != first approver != second approver !=
  executor, and now != the review resolver/reviewer pairing on confirmations.

## 9. Related operator actions (outside review cases)

| Action | Endpoint | Fresh MFA purpose |
| --- | --- | --- |
| Execute a payout | `POST /withdrawals/:id/execute` | `PAYOUT_EXECUTION` |
| First / second approval | `POST /withdrawals/:id/approve`, `POST /withdrawals/:id/second-approval` | `PAYOUT_FIRST_APPROVAL` / `PAYOUT_SECOND_APPROVAL` |
| Change payout destination (bumps destinationVersion; invalidates approvals + beneficiaries) | `POST /withdrawals/:id/destination` | none (requester-or-admin authorization; refused once a transfer was initiated) |
| Authoritative verification of an attempt | `POST /withdrawals/attempts/:attemptId/verify` | `PAYOUT_RECONCILIATION` |
| Reconcile with evidence + note | `POST /withdrawals/:id/reconcile` | `PAYOUT_RECONCILIATION` |
| Manual settlement (evidence file + provider reference + separation) | `POST /withdrawals/:id/settle` | `PAYOUT_SETTLEMENT` |
| Authorized retry of a FAILED payout | `POST /withdrawals/:id/retry` | `PAYOUT_RETRY` |

## 10. What you must never do

- Never treat a webhook message, dashboard screenshot or verbal provider confirmation as a
  settlement trigger. Verification always re-fetches the transfer from the provider API.
- Never re-submit a transfer for an attempt in `SUBMISSION_PENDING` — use the provider
  lookup path (`RETURN_TO_VERIFICATION` / the recovery sweep), never a manual duplicate.
- Never edit financial rows directly in the database: `PayoutReconciliation`,
  `PayoutVerificationEvidence` are UPDATE/DELETE-blocked and `PayoutAttempt`,
  `WithdrawalApproval`, `PayoutOutbox`, `ManualReviewCase`, `PayoutBeneficiary` are
  DELETE-blocked by triggers; direct SQL mutation attempts fail.
- Never resolve a case you opened for yourself as the reviewer; the independent-reviewer
  check and the audit trail exist for a reason.

## 11. Verification status (honest)

The workflow described here is implemented and covered by unit tests with mocked Prisma
(`manual-review-and-verification.spec.ts`: evidence requirement, independent-reviewer
requirement, never-settles guarantee, idempotency guard, stale-unknown escalation,
fail-closed verification classification). Endpoint-by-endpoint behavior against a live
database, real MFA (Redis) and real providers was **NOT RUN** in the release sandbox (no
PostgreSQL, no Redis, no provider credentials). All procedures above are code-derived, not
sandbox-observed.
