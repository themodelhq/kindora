# KINDORA v1.0.8 — Reversal Handling

Supplements PAYOUT_STATE_MACHINE_V1.0.4.md §7.4. v1.0.8 separates the reversal LIFECYCLE from the terminal outcome.

---

## 1. Provider status normalization (v1.0.8 §8.2)

| Provider raw status | v1.0.7 classification | v1.0.8 classification | reversalState |
| --- | --- | --- | --- |
| Flutterwave `reversed` | REVERSED (terminal) | REVERSED (terminal) | `COMPLETED` |
| Flutterwave `reverse_initiated` | REVERSED (terminal) — WRONG | `REVERSAL_IN_PROGRESS` | `INITIATED` |
| Flutterwave `reversing` | REVERSED (terminal) — WRONG | `REVERSAL_IN_PROGRESS` | `PROCESSING` |
| Paystack `reversed` / `reverse` | REVERSED (terminal) | REVERSED (terminal) | `COMPLETED` |
| Any unrecognized reversal-like status | UNKNOWN | UNKNOWN (fail closed) | unchanged |

An in-progress reversal is NEVER terminal: it does not release funds, does not settle, does not flip the withdrawal, and never produces a `REVERSED` attempt status.

## 2. Reversal lifecycle (forward-only)

`PayoutAttempt.reversalState` (enum `PayoutReversalState`): `NOT_APPLICABLE → REQUESTED → INITIATED / PENDING → PROCESSING → COMPLETED`, with `REJECTED` and `UNKNOWN` as side states.

- Any in-progress stage may advance; `COMPLETED` and `REJECTED` are terminal.
- Regression is rejected (`assertReversalTransition`), so a reversal cannot "un-complete" — duplicate reversal posting is impossible at the state-machine level AND at the ledger level (unique reference).

## 3. Completed reversal (authoritative evidence only)

When verification classifies a transfer `REVERSED` from the provider's own API:

1. The attempt moves to `REVERSED` with `reversalState = COMPLETED` — the ORIGINAL successful transfer history is preserved untouched.
2. If the withdrawal was PAID it moves to `REVERSED` (the only legal edge out of PAID).
3. The accounting correction posts as a SEPARATE financial event — `LedgerTxnType.WITHDRAWAL_REVERSAL`, reference `withdrawal-reversal:<withdrawalId>`, exact mirror of the original payout entries (campaign payable credit, clearing debit, revenue debit for fees). Exactly once via the unique reference.
4. A manual review case (`PROVIDER_REVERSAL`) is opened for the controlled recovery decision — a replacement payout is forbidden until the case is resolved.

## 4. In-progress reversal

Recorded: `reversalState` advances, `classification = REVERSAL_IN_PROGRESS`, attempt stays UNRESOLVED, reservation intact, withdrawal untouched. A manual review case is opened immediately — an in-progress reversal must never sit unattended while funds are in flight. Re-running verification later advances (or completes) the lifecycle from authoritative provider data.

## 5. What reconciliation classifies

- `PROVIDER_REVERSAL_IN_PROGRESS` — lifecycle record + escalation (no state flips).
- `PROVIDER_REVERSED` — terminal: attempt REVERSED (+ withdrawal REVERSED if PAID) + exactly-once accounting correction + escalation for the recovery decision.
