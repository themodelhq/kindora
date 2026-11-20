# DUAL APPROVAL SECURITY — v1.0.4

**Scope:** separation of duties for payout approvals and execution.
**Source of truth:** `backend/src/withdrawals/withdrawals.service.ts` (`approve`, `secondApproval`, `confirmSettlement`), `backend/src/payouts/payout.service.ts`, `prisma` models `WithdrawalApproval` / `Withdrawal`.

---

## 1. The v1.0.3 loophole (removed)

In v1.0.3, `secondApproval()` contained an exception:

```ts
// v1.0.3 — VULNERABLE (removed in v1.0.4)
if (withdrawal.reviewedById && withdrawal.reviewedById === admin.id && withdrawal.status !== 'UNDER_REVIEW') {
  throw new ForbiddenException('The first approver cannot also be the second approver');
}
```

While the withdrawal was in `UNDER_REVIEW`, the SAME administrator could satisfy
the second-approval requirement. `approve()` then wrote `reviewedById`,
collapsing both approver identities into one person.

v1.0.4 removes the exception entirely: identity separation is checked BEFORE the
state gate, in every state. A regression test reproduces the exact v1.0.3
scenario (§13.3): admin A reviews (`UNDER_REVIEW`), A submits the second
approval → **rejected** with `The first approver cannot also be the second
approver` (`withdrawals-approval.spec.ts`).

## 2. Immutable approval history

Every approval event is a durable `WithdrawalApproval` row:

| Field | Meaning |
|---|---|
| `withdrawalId` / `cycle` / `role` | Target withdrawal, approval cycle, `FIRST_APPROVER` \| `SECOND_APPROVER` \| `EXECUTOR` |
| `approverId` | The administrator performing THIS approval (immutable once written) |
| `amountAtApproval` / `currencyAtApproval` | Exact amount + currency snapshot the approval authorizes |
| `status` | `ACTIVE` \| `INVALIDATED` (invalidation keeps the row — history is never overwritten) |
| `invalidatedAt` / `invalidatedById` | Who/when an approval was invalidated |
| `approvedAt`, `note`, `metadata` | Audit metadata |

Uniqueness: `@@unique([withdrawalId, cycle, role])` — one active record per
role per cycle; a new cycle starts when approvals are invalidated.

Legacy mutable fields (`reviewedById`, `secondApprovedById`) are retained for
compatibility and display, but the approval ROWS are the source of truth for
authorization decisions in `confirmSettlement`.

## 3. Separation rules (server-enforced)

For every payout (dual-approval mode `ALL` is the default policy):

1. **Requester cannot approve** — `approve()` rejects
   `requestedById === admin.id` (ForbiddenException). Unchanged from v1.0.3.
2. **Requester cannot be second approver** — enforced in `secondApproval()`.
3. **First approver ≠ second approver** — enforced twice: against
   `withdrawal.reviewedById` AND against the ACTIVE `FIRST_APPROVER` row of the
   current cycle (`firstActive.approverId === admin.id` → ForbiddenException).
4. **Second approver ≠ payout executor** — `confirmSettlement()` refuses when
   the caller holds the active `SECOND_APPROVER` row of the current cycle.
5. **Executor identity is recorded** — an immutable `EXECUTOR` approval row is
   written at settlement time.
6. **No administrator may satisfy two independent roles** — the settlement
   re-checks the full active approval set from the database (not from request
   data) inside the same critical section.

All rules are enforced in the SERVICE layer; controller guards (roles + fresh
MFA) are additive, never the only line of defense.

## 4. Approval binding to amount and currency (§13.3)

`secondApproval()` compares the ACTIVE first approval's
`amountAtApproval`/`currencyAtApproval` with the withdrawal's CURRENT
amount/currency. If either changed:

- every approval of the current cycle is marked `INVALIDATED`
  (with invalidator identity),
- `approvalCycle` increments,
- the request is rejected with a message requiring a NEW first approval.

`confirmSettlement()` repeats the same comparison against BOTH active rows and
refuses settlement on mismatch. A currency change between request and approval
therefore forces full re-approval; a withdrawal whose amount changed after
approval cannot be paid on the old approvals.

## 5. Threshold policy (§6.5 — unambiguous)

| Variable | Meaning |
|---|---|
| `WITHDRAWAL_DUAL_APPROVAL_MODE` | `ALL` (default) — EVERY payout requires two distinct approvers + executor separation. `THRESHOLD` — only payouts at/above the threshold. |
| `WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR` | Used only in `THRESHOLD` mode; MUST be a positive integer. |

- There is **no configuration that disables dual approval**. The v1.0.3
  convention "0 disables dual approval" is gone.
- Zero/negative threshold in `THRESHOLD` mode is a configuration error:
  production startup validation refuses to boot
  (`backend/src/common/config/configuration.ts`).
- The API and every worker/cron service receive the same policy environment
  (render.yaml wires identical vars) — no service may run a weaker threshold.

## 6. Concurrency

- Second approval uses a conditional
  `updateMany({ where: { id, secondApprovedById: null } })`: concurrent second
  approvals serialize; exactly one writer wins, the loser receives 409
  `Second approval already recorded` (unit-tested).
- Settlement re-reads approvals inside the same request and relies on the
  exactly-once ledger reference for final safety.

## 7. Regression coverage

`backend/src/withdrawals/withdrawals-approval.spec.ts` covers: requester
approval, A→A second approval (loophole reproduction), A→B success, B-executor
refusal, C-executor success, missing active first approval, duplicate/concurrent
second approval, amount-change invalidation, currency binding, disabled/role
revocation (server-side role checks), and legacy method removal.
Integration tests (`backend/test/withdrawals.e2e-spec.ts`) exercise the full
flow over HTTP with real PostgreSQL + Redis (fresh MFA included).
