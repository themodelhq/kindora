-- CreateEnum
CREATE TYPE "ApprovalRole" AS ENUM ('FIRST_APPROVER', 'SECOND_APPROVER', 'EXECUTOR');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('ACTIVE', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "PayoutAttemptStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCESSFUL', 'FAILED', 'UNKNOWN', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReconciliationResult" AS ENUM ('MATCHED', 'PROVIDER_SUCCESS_INTERNAL_PENDING', 'PROVIDER_FAILED_INTERNAL_PROCESSING', 'PROVIDER_PENDING', 'PROVIDER_UNKNOWN', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DESTINATION_MISMATCH', 'DUPLICATE_REFERENCE', 'REQUIRES_MANUAL_INVESTIGATION');

-- CreateEnum
CREATE TYPE "MfaCredentialStatus" AS ENUM ('ENROLLING', 'ACTIVE', 'DISABLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WithdrawalStatus" ADD VALUE 'REQUIRES_RECONCILIATION';
ALTER TYPE "WithdrawalStatus" ADD VALUE 'REVERSED';

-- AlterEnum
ALTER TYPE "StoredFileKind" ADD VALUE 'PAYOUT_EVIDENCE';

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "evidenceForWithdrawalId" TEXT;

-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "approvalCycle" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "MfaCredential" (
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "status" "MfaCredentialStatus" NOT NULL DEFAULT 'ENROLLING',
    "confirmedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "WithdrawalApproval" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "role" "ApprovalRole" NOT NULL,
    "approverId" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'ACTIVE',
    "amountAtApproval" BIGINT NOT NULL,
    "currencyAtApproval" TEXT NOT NULL,
    "note" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedById" TEXT,
    "metadata" JSONB,

    CONSTRAINT "WithdrawalApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutAttempt" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerTransferRef" TEXT,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "destinationRef" TEXT,
    "status" "PayoutAttemptStatus" NOT NULL DEFAULT 'INITIATED',
    "providerStatus" TEXT,
    "classification" TEXT,
    "failureReason" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "initiatedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutReconciliation" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "attemptId" TEXT,
    "result" "ReconciliationResult" NOT NULL,
    "providerStatus" TEXT,
    "internalStatus" TEXT,
    "amountMatched" BOOLEAN,
    "currencyMatched" BOOLEAN,
    "destinationMatched" BOOLEAN,
    "providerEvidence" JSONB,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WithdrawalApproval_withdrawalId_idx" ON "WithdrawalApproval"("withdrawalId");

-- CreateIndex
CREATE INDEX "WithdrawalApproval_approverId_idx" ON "WithdrawalApproval"("approverId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalApproval_withdrawalId_cycle_role_key" ON "WithdrawalApproval"("withdrawalId", "cycle", "role");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAttempt_idempotencyKey_key" ON "PayoutAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAttempt_providerTransferRef_key" ON "PayoutAttempt"("providerTransferRef");

-- CreateIndex
CREATE INDEX "PayoutAttempt_withdrawalId_idx" ON "PayoutAttempt"("withdrawalId");

-- CreateIndex
CREATE INDEX "PayoutAttempt_status_idx" ON "PayoutAttempt"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAttempt_withdrawalId_attemptNo_key" ON "PayoutAttempt"("withdrawalId", "attemptNo");

-- CreateIndex
CREATE INDEX "PayoutReconciliation_withdrawalId_idx" ON "PayoutReconciliation"("withdrawalId");

-- CreateIndex
CREATE INDEX "PayoutReconciliation_attemptId_idx" ON "PayoutReconciliation"("attemptId");

-- CreateIndex
CREATE INDEX "PayoutReconciliation_result_idx" ON "PayoutReconciliation"("result");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_evidenceForWithdrawalId_key" ON "StoredFile"("evidenceForWithdrawalId");

-- AddForeignKey
ALTER TABLE "MfaCredential" ADD CONSTRAINT "MfaCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalApproval" ADD CONSTRAINT "WithdrawalApproval_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalApproval" ADD CONSTRAINT "WithdrawalApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WithdrawalApproval" ADD CONSTRAINT "WithdrawalApproval_invalidatedById_fkey" FOREIGN KEY ("invalidatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAttempt" ADD CONSTRAINT "PayoutAttempt_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAttempt" ADD CONSTRAINT "PayoutAttempt_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutReconciliation" ADD CONSTRAINT "PayoutReconciliation_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutReconciliation" ADD CONSTRAINT "PayoutReconciliation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PayoutAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutReconciliation" ADD CONSTRAINT "PayoutReconciliation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_evidenceForWithdrawalId_fkey" FOREIGN KEY ("evidenceForWithdrawalId") REFERENCES "Withdrawal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

