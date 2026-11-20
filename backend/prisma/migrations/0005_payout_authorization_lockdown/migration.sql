-- KINDORA v1.0.8 §11 — payout authorization & recovery lockdown.
-- Forward-only migration from v1.0.7 (0004_payout_execution_integrity).
-- No historical migration is modified; no historical financial record is
-- rewritten. Existing rows keep their meaning: new nullable columns are
-- NULL for history, new enum values are additive.

-- CreateEnum
CREATE TYPE "ManualSettlementChannel" AS ENUM ('MANUAL_BANK_TRANSFER', 'CASH', 'APPROVED_OFFLINE_CHANNEL');

-- CreateEnum
CREATE TYPE "PayoutReversalState" AS ENUM ('NOT_APPLICABLE', 'REQUESTED', 'INITIATED', 'PROCESSING', 'PENDING', 'COMPLETED', 'REJECTED', 'UNKNOWN');

-- AlterEnum
-- v1.0.8 §8.2 — in-progress reversals are classified separately from the
-- terminal REVERSED outcome.
ALTER TYPE "ReconciliationResult" ADD VALUE 'PROVIDER_REVERSAL_IN_PROGRESS';

-- AlterEnum
-- v1.0.8 §3.4 — manual settlements carry a DISTINCT reconciliation
-- classification: no authoritative provider verification occurred.
ALTER TYPE "ReconciliationResult" ADD VALUE 'MANUAL_EVIDENCE_RECORDED';

-- AlterEnum
-- v1.0.8 §8.3 — a completed reversal posts a SEPARATE financial event with
-- its own exactly-once ledger reference (withdrawal-reversal:<id>).
ALTER TYPE "LedgerTxnType" ADD VALUE 'WITHDRAWAL_REVERSAL';

-- AlterTable — v1.0.8 §3.2: the allowlisted manual settlement channel is
-- recorded on manual settlement attempts (NULL for provider attempts/history).
ALTER TABLE "PayoutAttempt" ADD COLUMN "manualChannel" "ManualSettlementChannel";

-- AlterTable — v1.0.8 §8.2: reversal lifecycle state. The attempt status
-- REVERSED is applied only when reversalState = COMPLETED with authoritative
-- provider evidence; in-progress reversals keep the attempt unresolved.
ALTER TABLE "PayoutAttempt" ADD COLUMN "reversalState" "PayoutReversalState";
ALTER TABLE "PayoutAttempt" ADD COLUMN "reversalObservedAt" TIMESTAMP(3);

-- AlterTable — v1.0.8 §5.2: lease-based outbox ownership. claimedBy/claimedAt
-- (v1.0.7) are joined by an explicit lease expiry so a crashed worker's
-- IN_FLIGHT event can be SAFELY reclaimed (never blind-reset to PENDING).
ALTER TABLE "PayoutOutbox" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "PayoutOutbox" ADD COLUMN "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PayoutOutbox" ADD COLUMN "lastRecoveryAt" TIMESTAMP(3);

-- CreateIndex — recovery sweep: expired IN_FLIGHT leases are found by index.
CREATE INDEX "PayoutOutbox_status_leaseExpiresAt_idx" ON "PayoutOutbox"("status", "leaseExpiresAt");

-- Constraint notes (v1.0.8 §11):
--  - Manual settlement channels: enforced by an explicit server-side
--    allowlist at the DTO, controller and service layers (application-level,
--    with the enum closing the DB surface too — only allowlisted values can
--    ever be written).
--  - Reversal lifecycle: transition legality is enforced by the payout state
--    machine (application-level); the column preserves the lifecycle for
--    audit and prevents premature terminal REVERSED classification.
--  - Lease recovery: the claim is a conditional UPDATE on
--    (status, leaseExpiresAt) — atomic under concurrent workers; the
--    recovery path checks the provider for an existing transfer BEFORE any
--    resubmission (no duplicate-transfer risk from a stale lease).
