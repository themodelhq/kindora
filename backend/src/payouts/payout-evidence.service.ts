import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

/**
 * KINDORA v1.0.8 §3.5 — canonical manual-settlement EVIDENCE validation.
 *
 * Manual settlement evidence must be represented by an AUTHORIZED StoredFile
 * record. This service is the single validation implementation; it is invoked
 * by the withdrawals service (controller path) AND re-invoked by
 * PayoutService.settleManual INSIDE the settlement transaction (§3.3: the
 * service-layer check is mandatory; no caller can skip it).
 *
 * Every check fails closed:
 *  - file exists, is not EXPIRED/FAILED/QUARANTINED/REJECTED (availability);
 *  - scan completed with verdict CLEAN (approval/scanning status);
 *  - StoredFile.status APPROVED (explicit approval status, v1.0.8);
 *  - PRIVATE visibility (private access controls);
 *  - kind PAYOUT_EVIDENCE (file purpose);
 *  - uploaded by the submitting administrator (authorized uploader);
 *  - bound to exactly THIS withdrawal, and not already consumed as evidence
 *    for a different settlement (withdrawal association + reuse prevention).
 *
 * Arbitrary external evidence URLs are structurally impossible: only a
 * StoredFile id is accepted anywhere in the pipeline.
 */
@Injectable()
export class PayoutEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate an evidence file for manual settlement. Pass a transaction
   * client to validate against the same locked snapshot that will be mutated
   * (v1.0.8 §3.6 step 9).
   */
  async validateEvidenceFile(
    client: Prisma.TransactionClient | PrismaService,
    fileId: string,
    admin: { id: string; role: string },
    withdrawalId: string,
  ) {
    const file = await client.storedFile.findUnique({ where: { id: fileId } });
    if (!file) throw new BadRequestException('Evidence file not found');
    if (file.status === 'EXPIRED' || file.status === 'FAILED') {
      throw new BadRequestException(`Evidence file is ${file.status} and no longer available`);
    }
    if (file.status === 'QUARANTINED' || file.status === 'REJECTED') {
      throw new BadRequestException(`Evidence file is ${file.status} and cannot be used`);
    }
    if (file.status === 'SCANNING' || file.scanVerdict === 'PENDING') {
      throw new BadRequestException('Evidence file security scan has not completed — upload earlier and retry after approval');
    }
    if (file.scanVerdict !== 'CLEAN') {
      throw new BadRequestException('Evidence file did not pass the security scan');
    }
    if (file.status !== 'APPROVED') {
      throw new BadRequestException(`Evidence file is not APPROVED (current: ${file.status}) — only approved evidence may support a settlement`);
    }
    if (file.visibility !== 'PRIVATE') {
      throw new BadRequestException('Payout evidence must be stored privately');
    }
    if (file.kind !== 'PAYOUT_EVIDENCE') {
      throw new BadRequestException(`Wrong evidence purpose (${file.kind}) — upload as PAYOUT_EVIDENCE`);
    }
    if (file.uploaderId !== admin.id) {
      throw new ForbiddenException('Evidence must be uploaded by the submitting administrator');
    }
    if (file.evidenceForWithdrawalId && file.evidenceForWithdrawalId !== withdrawalId) {
      throw new ForbiddenException('Evidence is bound to a different withdrawal — reuse across withdrawals is not permitted');
    }
    if (file.withdrawalId && file.withdrawalId !== withdrawalId) {
      throw new ForbiddenException('Evidence is attached to a different withdrawal');
    }
    return file;
  }

  /** Bind the evidence file to the withdrawal (unique -> reuse prevention at the DB level). */
  async bindEvidence(client: Prisma.TransactionClient | PrismaService, fileId: string, withdrawalId: string) {
    try {
      await client.storedFile.update({
        where: { id: fileId },
        data: { evidenceForWithdrawalId: withdrawalId, withdrawalId, approvedAt: new Date() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Evidence file is already bound to a withdrawal (reuse prevented)');
      }
      throw err;
    }
  }
}
