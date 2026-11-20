import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PayoutBeneficiaryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { sha256Hex } from '../common/utils/crypto.util';
import type { PayoutProviderAdapter, PayoutBeneficiaryInput, ResolvedBeneficiary } from './payout-provider.adapter';

export interface EnsureBeneficiaryInput {
  withdrawalId: string;
  provider: string;
  currency: string;
  method: 'BANK' | 'MOBILE_MONEY';
  destination: Record<string, string>;
  destinationVersion: number;
  createdById?: string;
}

/**
 * v1.0.7 §5.2 — stable beneficiary verification model.
 *
 * Every payout attempt is bound to a PayoutBeneficiary row that carries:
 *  - the provider-specific externalRef (Paystack recipient_code / FLW identity
 *    token) — the ONLY identifier compared against provider verification data;
 *  - a fingerprint over the provider-visible identity;
 *  - the destinationVersion it was validated for.
 *
 * The legacy `destinationRef` hash of the raw destination JSON is kept on the
 * attempt for audit history but is NEVER compared against provider responses.
 *
 * A destination change bumps the withdrawal's destinationVersion (§5.4), so
 * this service can never return a stale recipient for a changed beneficiary.
 */
@Injectable()
export class PayoutBeneficiaryService {
  private readonly logger = new Logger(PayoutBeneficiaryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Hash of the exact destination JSON (audit/history only). */
  destinationHash(destination: unknown): string {
    return `sha256:${sha256Hex(JSON.stringify(destination ?? {}))}`;
  }

  /**
   * Resolve (or reuse) the ACTIVE validated beneficiary for
   * (withdrawal, provider, destinationVersion). Provider resolution failures
   * propagate: initiation aborts BEFORE any intent row is created.
   */
  async ensureBeneficiary(adapter: PayoutProviderAdapter, input: EnsureBeneficiaryInput): Promise<{ id: string; externalRef: string; identity: Record<string, string | null> }> {
    const destinationHash = this.destinationHash(input.destination);

    const existing = await this.prisma.payoutBeneficiary.findUnique({
      where: { withdrawalId_provider_destinationVersion: { withdrawalId: input.withdrawalId, provider: input.provider, destinationVersion: input.destinationVersion } },
    });
    if (existing) {
      if (existing.status === PayoutBeneficiaryStatus.ACTIVE) {
        if (existing.destinationHash !== destinationHash) {
          // Defensive: same version but different JSON — the destination was
          // mutated without a version bump. Fail closed.
          throw new ConflictException('Destination content changed without a destinationVersion bump — refusing to reuse the registered beneficiary (fail closed)');
        }
        return { id: existing.id, externalRef: existing.externalRef, identity: (existing.maskedDetails as Record<string, string | null>) ?? {} };
      }
      throw new ConflictException(`Registered beneficiary for destination version ${input.destinationVersion} is ${existing.status} — revalidation required`);
    }

    const adapterInput: PayoutBeneficiaryInput = { destination: input.destination, currency: input.currency, method: input.method };
    const resolved: ResolvedBeneficiary = await adapter.resolveBeneficiary(adapterInput);

    try {
      const created = await this.prisma.payoutBeneficiary.create({
        data: {
          withdrawalId: input.withdrawalId,
          provider: input.provider,
          destinationVersion: input.destinationVersion,
          currency: input.currency.toUpperCase(),
          externalRef: resolved.externalRef,
          fingerprint: resolved.fingerprint,
          destinationHash,
          status: PayoutBeneficiaryStatus.ACTIVE,
          maskedDetails: resolved.maskedDetails as Prisma.InputJsonValue,
          validatedAt: new Date(),
          createdById: input.createdById,
        },
      });
      this.logger.log(`Beneficiary registered for withdrawal ${input.withdrawalId} (${input.provider} v${input.destinationVersion})`);
      return { id: created.id, externalRef: created.externalRef, identity: resolved.identity };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Concurrent resolution for the same version — reuse the winner's row.
        const winner = await this.prisma.payoutBeneficiary.findUnique({
          where: { withdrawalId_provider_destinationVersion: { withdrawalId: input.withdrawalId, provider: input.provider, destinationVersion: input.destinationVersion } },
        });
        if (winner?.status === PayoutBeneficiaryStatus.ACTIVE) {
          return { id: winner.id, externalRef: winner.externalRef, identity: (winner.maskedDetails as Record<string, string | null>) ?? {} };
        }
        throw new ConflictException('Beneficiary registration raced with an invalidation — revalidate');
      }
      throw err;
    }
  }

  /**
   * §5.4 — destination change handling. Bumps the version and retires ALL
   * active beneficiaries + invalidates the approval cycle in ONE transaction.
   * Executed by WithdrawalsService when a destination is modified.
   */
  async invalidateOnDestinationChange(withdrawalId: string, invalidatedById?: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId }, select: { id: true, destinationVersion: true, approvalCycle: true, status: true } });
      if (!w) throw new BadRequestException('Withdrawal not found');
      if (!['PENDING', 'UNDER_REVIEW', 'REQUIRES_INFORMATION', 'APPROVED'].includes(w.status)) {
        throw new ConflictException('Destination cannot be changed once a transfer has been initiated');
      }
      const newVersion = w.destinationVersion + 1;
      await tx.withdrawal.update({ where: { id: withdrawalId }, data: { destinationVersion: newVersion, approvalCycle: w.approvalCycle + 1 } });
      await tx.payoutBeneficiary.updateMany({
        where: { withdrawalId, status: PayoutBeneficiaryStatus.ACTIVE },
        data: { status: PayoutBeneficiaryStatus.INVALIDATED },
      });
      await tx.withdrawalApproval.updateMany({
        where: { withdrawalId, cycle: w.approvalCycle, status: 'ACTIVE' },
        data: { status: 'INVALIDATED', invalidatedAt: new Date(), invalidatedById: invalidatedById ?? null },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: invalidatedById ?? null,
          action: 'WITHDRAWAL_DESTINATION_CHANGED',
          entityType: 'WITHDRAWAL',
          entityId: withdrawalId,
          metadata: { newDestinationVersion: newVersion, invalidatedCycle: w.approvalCycle, reason: 'destination change invalidates approvals and beneficiaries (v1.0.7 §5.4)' },
        },
      });
      return newVersion;
    });
  }
}
