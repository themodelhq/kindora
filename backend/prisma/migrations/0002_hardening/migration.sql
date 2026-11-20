-- CreateEnum
CREATE TYPE "FileVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "StoredFileKind" AS ENUM ('CAMPAIGN_IMAGE', 'CAMPAIGN_MEDIA', 'AVATAR', 'DOCUMENT', 'IDENTITY', 'EXPENSE_EVIDENCE');

-- CreateEnum
CREATE TYPE "StoredFileStatus" AS ENUM ('UPLOADED', 'QUARANTINED', 'SCANNING', 'APPROVED', 'REJECTED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ScanVerdict" AS ENUM ('PENDING', 'CLEAN', 'INFESTED', 'SKIPPED', 'UNAVAILABLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WithdrawalStatus" ADD VALUE 'UNDER_REVIEW';
ALTER TYPE "WithdrawalStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "WithdrawalStatus" ADD VALUE 'REQUIRES_INFORMATION';

-- AlterTable
ALTER TABLE "Donation" ADD COLUMN     "providerAuthRef" TEXT,
ADD COLUMN     "providerFeeMinor" BIGINT;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "handledAction" TEXT;

-- AlterTable
ALTER TABLE "RecurringDonation" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureReason" TEXT;

-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "evidenceUrl" TEXT,
ADD COLUMN     "paidById" TEXT,
ADD COLUMN     "payoutProvider" TEXT,
ADD COLUMN     "payoutProviderTxnId" TEXT,
ADD COLUMN     "reconciledAt" TIMESTAMP(3),
ADD COLUMN     "reconciledById" TEXT,
ADD COLUMN     "secondApprovedAt" TIMESTAMP(3),
ADD COLUMN     "secondApprovedById" TEXT;

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "StoredFileKind" NOT NULL,
    "visibility" "FileVisibility" NOT NULL,
    "status" "StoredFileStatus" NOT NULL DEFAULT 'UPLOADED',
    "scanVerdict" "ScanVerdict" NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "campaignId" TEXT,
    "organizationId" TEXT,
    "withdrawalId" TEXT,
    "kycRecordId" TEXT,
    "scanNote" TEXT,
    "scannedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_key_key" ON "StoredFile"("key");

-- CreateIndex
CREATE INDEX "StoredFile_uploaderId_idx" ON "StoredFile"("uploaderId");

-- CreateIndex
CREATE INDEX "StoredFile_status_idx" ON "StoredFile"("status");

-- CreateIndex
CREATE INDEX "StoredFile_campaignId_idx" ON "StoredFile"("campaignId");

-- CreateIndex
CREATE INDEX "StoredFile_organizationId_idx" ON "StoredFile"("organizationId");

-- CreateIndex
CREATE INDEX "StoredFile_kycRecordId_idx" ON "StoredFile"("kycRecordId");

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoredFile" ADD CONSTRAINT "StoredFile_kycRecordId_fkey" FOREIGN KEY ("kycRecordId") REFERENCES "KycRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_secondApprovedById_fkey" FOREIGN KEY ("secondApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

