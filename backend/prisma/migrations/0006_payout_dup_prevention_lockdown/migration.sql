-- KINDORA v1.0.9 — 0006_payout_dup_prevention_lockdown
-- Forward-only, additive migration (spec §6: no historical migration modified).
--
-- 1. PayoutSettlementGuard (§3.2) — THE durable coordination lock between
--    manual settlement and provider submission. One row per withdrawal
--    (unique). Claims are atomic conditional updates inside the transaction
--    that already holds the withdrawal row lock.
-- 2. PayoutAttempt / PayoutOutbox lookup-outcome columns (§2.3/§7) — the last
--    provider lookup outcome (FOUND/NOT_FOUND/AMBIGUOUS/ERROR) persisted for
--    safe recovery and observability.
-- 3. Partial UNIQUE index (§2.4) — at most ONE unresolved logical payout
--    attempt per withdrawal, enforced by the DATABASE regardless of
--    application-level checks. This is the structural duplicate-transfer
--    barrier: a second concurrent logical attempt cannot even exist.
--
-- Backfill: every withdrawal that already has payout activity gets a guard
-- row. Rows whose withdrawal is already PAID are SETTLED (terminal); all
-- others start IDLE. Existing unresolved attempts are untouched (their
-- pipelines continue to operate under the new claims).

CREATE TYPE "PayoutSettlementGuardMode" AS ENUM ('IDLE', 'PROVIDER_SUBMISSION_ACTIVE', 'MANUAL_SETTLEMENT_ACTIVE', 'SETTLED');

-- ---------------------------------------------------------------------------
-- 1. PayoutSettlementGuard
-- ---------------------------------------------------------------------------
CREATE TABLE "PayoutSettlementGuard" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "mode" "PayoutSettlementGuardMode" NOT NULL DEFAULT 'IDLE',
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedUntil" TIMESTAMP(3),
    "manualBlocks" INTEGER NOT NULL DEFAULT 0,
    "submissionBlocks" INTEGER NOT NULL DEFAULT 0,
    "expiredReclaims" INTEGER NOT NULL DEFAULT 0,
    "lastBlockedReason" TEXT,
    "lastBlockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutSettlementGuard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayoutSettlementGuard_withdrawalId_key" ON "PayoutSettlementGuard"("withdrawalId");
CREATE INDEX "PayoutSettlementGuard_mode_claimedUntil_idx" ON "PayoutSettlementGuard"("mode", "claimedUntil");

ALTER TABLE "PayoutSettlementGuard" ADD CONSTRAINT "PayoutSettlementGuard_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill one guard row per withdrawal with payout history.
INSERT INTO "PayoutSettlementGuard" ("id", "withdrawalId", "mode", "updatedAt")
SELECT gen_random_uuid(),
       w."id",
       CASE WHEN w."status" = 'PAID' THEN 'SETTLED'::"PayoutSettlementGuardMode" ELSE 'IDLE'::"PayoutSettlementGuardMode" END,
       now()
FROM "Withdrawal" w
WHERE EXISTS (SELECT 1 FROM "PayoutAttempt" a WHERE a."withdrawalId" = w."id")
ON CONFLICT ("withdrawalId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Lookup-outcome persistence (§2.3/§7)
-- ---------------------------------------------------------------------------
ALTER TABLE "PayoutAttempt" ADD COLUMN "lastLookupOutcome" TEXT;
ALTER TABLE "PayoutAttempt" ADD COLUMN "lastLookupAt" TIMESTAMP(3);
ALTER TABLE "PayoutOutbox" ADD COLUMN "lastLookupOutcome" TEXT;
ALTER TABLE "PayoutOutbox" ADD COLUMN "lastLookupAt" TIMESTAMP(3);

CREATE INDEX "PayoutAttempt_withdrawalId_status_idx" ON "PayoutAttempt"("withdrawalId", "status");
CREATE INDEX "PayoutOutbox_withdrawalId_status_idx" ON "PayoutOutbox"("withdrawalId", "status");

-- ---------------------------------------------------------------------------
-- 3. Database-level duplicate-submission prevention (§2.4)
--    Partial unique index: only one UNRESOLVED logical payout attempt may
--    exist per withdrawal. Resolved attempts (SUCCESSFUL/FAILED/REVERSED)
--    are excluded, so authorized retries keep working. A violation aborts
--    the offending transaction (fail closed).
--
--    NOTE: partial indexes are not expressible in the Prisma schema DSL.
--    `prisma migrate diff` therefore reports exactly this one statement as a
--    difference between the migrations and the Prisma schema — this is the
--    EXPECTED, reviewed exception (documented in the v1.0.9 report).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "payout_attempt_one_unresolved_per_withdrawal"
ON "PayoutAttempt"("withdrawalId")
WHERE "status" IN ('INITIATED', 'SUBMISSION_PENDING', 'PROVIDER_ACCEPTED', 'PENDING', 'UNKNOWN', 'MANUAL_REVIEW');
