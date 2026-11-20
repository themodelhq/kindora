-- CreateEnum
CREATE TYPE "PayoutOutboxStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUBMITTED', 'FAILED_PERMANENT', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "PayoutBeneficiaryStatus" AS ENUM ('VALIDATING', 'ACTIVE', 'RETIRED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "VerificationSource" AS ENUM ('API_VERIFY', 'WEBHOOK', 'MANUAL_REVIEW', 'RECONCILIATION_SWEEP');

-- CreateEnum
CREATE TYPE "ManualReviewStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ManualReviewCategory" AS ENUM ('PROVIDER_SUCCESS_INSUFFICIENT_BENEFICIARY_EVIDENCE', 'PROVIDER_PENDING', 'PROVIDER_UNKNOWN', 'PROVIDER_UNAVAILABLE', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'BENEFICIARY_MISMATCH', 'REFERENCE_MISMATCH', 'DUPLICATE_REFERENCE', 'PROVIDER_REVERSAL', 'INTERNAL_STATE_MISMATCH', 'PROVIDER_DATA_INCOMPLETE', 'STUCK_OUTBOX_EVENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayoutAttemptStatus" ADD VALUE 'SUBMISSION_PENDING';
ALTER TYPE "PayoutAttemptStatus" ADD VALUE 'PROVIDER_ACCEPTED';
ALTER TYPE "PayoutAttemptStatus" ADD VALUE 'MANUAL_REVIEW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReconciliationResult" ADD VALUE 'PROVIDER_REVERSED';
ALTER TYPE "ReconciliationResult" ADD VALUE 'REFERENCE_MISMATCH';
ALTER TYPE "ReconciliationResult" ADD VALUE 'INTERNAL_STATE_MISMATCH';
ALTER TYPE "ReconciliationResult" ADD VALUE 'PROVIDER_DATA_INCOMPLETE';
ALTER TYPE "ReconciliationResult" ADD VALUE 'MANUAL_REVIEW_REQUIRED';

-- AlterTable
ALTER TABLE "WithdrawalApproval" ADD COLUMN     "destinationVersionAtApproval" INTEGER,
ADD COLUMN     "snapshotHash" TEXT;

-- AlterTable
ALTER TABLE "PayoutAttempt" ADD COLUMN     "beneficiaryId" TEXT,
ADD COLUMN     "providerTransferId" TEXT,
ADD COLUMN     "requestFingerprint" TEXT;

-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "destinationVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "PayoutBeneficiary" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "destinationVersion" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "status" "PayoutBeneficiaryStatus" NOT NULL DEFAULT 'ACTIVE',
    "maskedDetails" JSONB,
    "validatedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutBeneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutOutbox" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT 'INITIATE_TRANSFER',
    "status" "PayoutOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestFingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "lastError" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutVerificationEvidence" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "source" "VerificationSource" NOT NULL,
    "provider" TEXT NOT NULL,
    "rawStatus" TEXT,
    "classification" TEXT,
    "providerTransferRef" TEXT,
    "providerTransferId" TEXT,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "beneficiaryRef" TEXT,
    "destinationRef" TEXT,
    "evidenceHash" TEXT NOT NULL,
    "payload" JSONB,
    "correlationId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutVerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualReviewCase" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "attemptId" TEXT,
    "category" "ManualReviewCategory" NOT NULL,
    "status" "ManualReviewStatus" NOT NULL DEFAULT 'OPEN',
    "openedReason" TEXT NOT NULL,
    "evidence" JSONB,
    "resolution" TEXT,
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "reviewerId" TEXT,
    "mfaPurposeUsed" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualReviewCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutBeneficiary_withdrawalId_idx" ON "PayoutBeneficiary"("withdrawalId");

-- CreateIndex
CREATE INDEX "PayoutBeneficiary_status_idx" ON "PayoutBeneficiary"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutBeneficiary_withdrawalId_provider_destinationVersion_key" ON "PayoutBeneficiary"("withdrawalId", "provider", "destinationVersion");

-- CreateIndex
CREATE INDEX "PayoutBeneficiary_provider_externalRef_idx" ON "PayoutBeneficiary"("provider", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutOutbox_attemptId_key" ON "PayoutOutbox"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutOutbox_idempotencyKey_key" ON "PayoutOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PayoutOutbox_status_nextRunAt_idx" ON "PayoutOutbox"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "PayoutOutbox_withdrawalId_idx" ON "PayoutOutbox"("withdrawalId");

-- CreateIndex
CREATE INDEX "PayoutVerificationEvidence_attemptId_idx" ON "PayoutVerificationEvidence"("attemptId");

-- CreateIndex
CREATE INDEX "PayoutVerificationEvidence_withdrawalId_idx" ON "PayoutVerificationEvidence"("withdrawalId");

-- CreateIndex
CREATE INDEX "ManualReviewCase_status_idx" ON "ManualReviewCase"("status");

-- CreateIndex
CREATE INDEX "ManualReviewCase_withdrawalId_idx" ON "ManualReviewCase"("withdrawalId");

-- CreateIndex
CREATE INDEX "ManualReviewCase_attemptId_idx" ON "ManualReviewCase"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAttempt_requestFingerprint_key" ON "PayoutAttempt"("requestFingerprint");

-- CreateIndex
CREATE INDEX "PayoutAttempt_providerTransferId_idx" ON "PayoutAttempt"("providerTransferId");

-- AddForeignKey
ALTER TABLE "PayoutAttempt" ADD CONSTRAINT "PayoutAttempt_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "PayoutBeneficiary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutBeneficiary" ADD CONSTRAINT "PayoutBeneficiary_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutBeneficiary" ADD CONSTRAINT "PayoutBeneficiary_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutOutbox" ADD CONSTRAINT "PayoutOutbox_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PayoutAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutVerificationEvidence" ADD CONSTRAINT "PayoutVerificationEvidence_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PayoutAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualReviewCase" ADD CONSTRAINT "ManualReviewCase_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualReviewCase" ADD CONSTRAINT "ManualReviewCase_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PayoutAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualReviewCase" ADD CONSTRAINT "ManualReviewCase_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualReviewCase" ADD CONSTRAINT "ManualReviewCase_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- v1.0.7 §11 — database-level financial integrity constraints.
--
-- Immutability: financial audit/evidence history can never be altered or
-- removed through any code path. The application never UPDATEs or DELETEs
-- these rows; these triggers make that invariant hold at the database level
-- even against direct SQL access or a compromised application role.
-- DELETE on the payout attempt registry, approval ledger, outbox, review
-- cases and the withdrawal itself is likewise forbidden — reservation and
-- payout history is never cascade-deleted.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "kindora_block_financial_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'KINDORA financial record protection: % on % is forbidden (immutability policy v1.0.7)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payout_reconciliation_immutable"
  BEFORE UPDATE OR DELETE ON "PayoutReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

CREATE TRIGGER "payout_verification_evidence_immutable"
  BEFORE UPDATE OR DELETE ON "PayoutVerificationEvidence"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

CREATE TRIGGER "payout_attempt_no_delete"
  BEFORE DELETE ON "PayoutAttempt"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

CREATE TRIGGER "withdrawal_approval_no_delete"
  BEFORE DELETE ON "WithdrawalApproval"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

CREATE TRIGGER "payout_outbox_no_delete"
  BEFORE DELETE ON "PayoutOutbox"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

CREATE TRIGGER "manual_review_case_no_delete"
  BEFORE DELETE ON "ManualReviewCase"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

CREATE TRIGGER "payout_beneficiary_no_delete"
  BEFORE DELETE ON "PayoutBeneficiary"
  FOR EACH ROW EXECUTE FUNCTION "kindora_block_financial_mutation"();

-- Uniqueness notes (v1.0.7 §11):
--  - Settlement identity: the unique ledger reference `withdrawal:<id>` posted
--    in the settlement transaction (LedgerService) makes double settlement a
--    DB-level conflict. PayoutOutbox_attemptId_key + PayoutOutbox_idempotencyKey_key
--    + PayoutAttempt_requestFingerprint_key make a duplicate external submission
--    a DB-level conflict.
--  - Provider beneficiary identifier: recipient codes are legitimately reused
--    across withdrawals to the same destination, so (provider, externalRef) is
--    a lookup index, NOT unique. Beneficiary identity is uniquely bound per
--    (withdrawalId, provider, destinationVersion) — a changed destination bumps
--    the version and forces fresh validation (§5.4).
