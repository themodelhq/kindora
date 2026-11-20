# PAYOUT STATE MACHINE — v1.0.4

**Release:** KINDORA v1.0.4 (payout lockdown)
**Scope:** every withdrawal/payout status transition in the application.
**Source of truth:** `backend/src/payouts/payout-state-machine.ts`, `backend/src/payouts/payout.service.ts`.

---

## 1. Ownership

As of v1.0.4 there is exactly ONE owner of payout state: `PayoutService`.
There is no other code path that may change a withdrawal's status:

- The legacy admin endpoints `POST /withdrawals/:id/mark-paid`,
  `POST /withdrawals/:id/mark-failed` and `POST /withdrawals/:id/mark-processing`
  **no longer exist** (404). Their service methods were deleted; a unit test
  (`withdrawals-approval.spec.ts › legacy manipulation methods are gone`)
  asserts the methods cannot be invoked, and the integration suite asserts
  the routes return 404.
- Workers never write withdrawal status. The `payments.reconcile` queue job is
  read-only + digest email; reconciliation state changes happen only through
  `PayoutService`.
- Every transition is enforced twice: `assertTransition(from, to)` validates
  the edge against the canonical graph, and the write itself is a conditional
  `updateMany({ where: { id, status: from } })` inside a transaction —
  concurrent writers cannot interleave.

## 2. State graph

```
REQUESTED(PENDING) ─→ UNDER_REVIEW ─→ APPROVED ─→ PROCESSING ─→ PAID
     │  │  │                │             │             │        │
     │  │  └→ REJECTED      └→ REJECTED   └→ REJECTED   │        └→ REVERSED
     │  └→ REQUIRES_INFORMATION ─→ APPROVED / UNDER_REVIEW / REJECTED
     └→ CANCELLED

PROCESSING ─→ REQUIRES_RECONCILIATION      (timeout / unknown provider answer)
REQUIRES_RECONCILIATION ─→ PAID            (verified successful transfer)
REQUIRES_RECONCILIATION ─→ FAILED          (verified terminal failure)
FAILED ─→ PROCESSING                        (authorized retry, new attempt)
PAID ─→ REVERSED                            (verified provider reversal)
REJECTED / CANCELLED / REVERSED             (terminal)
```

## 3. Permitted transitions table

| Current state | Requested state | Permitted condition | Who can trigger |
|---|---|---|---|
| PENDING | UNDER_REVIEW | Authorized review (fresh MFA) | Admin |
| PENDING | APPROVED | First approval (fresh MFA, requester excluded) | Admin ≠ requester |
| PENDING | REQUIRES_INFORMATION | Missing evidence flagged (fresh MFA) | Admin |
| PENDING | REJECTED | Authorized rejection (fresh MFA) | Admin |
| PENDING | CANCELLED | Requester cancels before approval | Requester |
| UNDER_REVIEW | APPROVED / REQUIRES_INFORMATION / REJECTED | as above | Admin |
| REQUIRES_INFORMATION | UNDER_REVIEW / APPROVED / REJECTED / CANCELLED | as above | Admin / requester |
| APPROVED | PROCESSING | Payout attempt registered (PayoutService) | System via settle/verify |
| APPROVED | PAID | Manual settlement with evidence file + dual approval + fresh MFA | Executor admin (3rd distinct) |
| APPROVED | REJECTED | before transfer | Admin |
| PROCESSING | PAID | **Authoritative** provider verification SUCCESSFUL or manual settlement of a MANUAL_* attempt | PayoutService |
| PROCESSING | FAILED | **ONLY** authoritative provider verification FAILED | PayoutService.verifyAttempt |
| PROCESSING | REQUIRES_RECONCILIATION | Ambiguous outcome (timeout/HTTP error/unknown/pending) | PayoutService |
| PROCESSING | REVERSED | Verified provider reversal | PayoutService |
| REQUIRES_RECONCILIATION | PAID / FAILED / REJECTED | Verified outcome / escalation | PayoutService / Admin |
| FAILED | PROCESSING | Authorized retry (fresh MFA, no unresolved attempt) | Admin ≠ requester |
| PAID | REVERSED | Verified provider reversal | PayoutService |
| REJECTED / CANCELLED / REVERSED | (none) | Terminal | — |

## 4. Critical restrictions and how they are enforced

| Restriction | Enforcement |
|---|---|
| An administrator cannot force-fail a processing transfer | No route reaches that transition; only `applyProviderVerification` with a classified `FAILED` result. Integration test asserts `mark-failed` is 404. |
| A timeout/HTTP error does not mean failure | `verifyAttempt` catches transport errors → classification `UNKNOWN` → withdrawal moves to `REQUIRES_RECONCILIATION`, reservation intact. |
| An unknown provider response does not release the reservation | `UNKNOWN`/`PENDING` never map to `FAILED` (`classifyTransferStatus`); `REQUIRES_RECONCILIATION` is in the reserving status list (`LedgerService.campaignAvailableBalance`). |
| A pending/ambiguous/unresolved transfer cannot be retried | `PayoutService.retry` refuses unless status is `FAILED` AND no attempt is `INITIATED/PENDING/UNKNOWN` AND the previous attempt carries an authoritative failure reason. |
| A successful transfer is never marked failed to pay again | `PAID → FAILED` is not a legal edge; `PAID → REVERSED` only via verified reversal. |
| A paid withdrawal cannot be paid twice | Settlement path is exactly-once: unique ledger reference `withdrawal:<id>` (P2002 → 409) + `PAID` is non-payable in the state machine. |

## 5. Migration policy for historical records

`0003_payout_lockdown` is additive. Historical withdrawals keep their legacy
fields (`reviewedById`, `secondApprovedById`, `evidenceUrl`). No historical
second approval is fabricated: outstanding (non-terminal) payouts proceed only
under the new `WithdrawalApproval` records created going forward, bound to the
current `approvalCycle` (default 1 for legacy rows).
