import { BadRequestException } from '@nestjs/common';
import { PayoutAttemptStatus, WithdrawalStatus } from '@prisma/client';
import { ManualReviewService } from './manual-review.service';
import { PayoutVerificationService } from './payout-verification.service';
import { PayoutProviderRegistry } from './payout-provider.registry';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';
import { lookupFound } from './payout-provider.adapter';

/**
 * v1.0.7 §9 + §5.3 — controlled manual review and fail-closed verification.
 */

describe('manual review workflow (v1.0.7 §9)', () => {
  function makeService() {
    const db = {
      manualReviewCase: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'case-1' }),
        update: jest.fn().mockResolvedValue({ id: 'case-1', status: 'RESOLVED' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      withdrawal: { findUnique: jest.fn().mockResolvedValue({ id: 'wd-1', status: WithdrawalStatus.REQUIRES_RECONCILIATION }) },
      withdrawalApproval: { findUnique: jest.fn() },
      payoutAttempt: {
        findUnique: jest.fn().mockResolvedValue({ id: 'a1', status: PayoutAttemptStatus.MANUAL_REVIEW }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'admin-reviewer', role: 'ADMIN' }) },
      $transaction: null as unknown as jest.Mock,
    };
    db.$transaction = jest.fn(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
    const service = new ManualReviewService(db as never);
    return { db, service };
  }

  const ADMIN = { id: 'admin-1', role: 'ADMIN' };

  it('confirming provider success requires a registered evidence file', async () => {
    const { db, service } = makeService();
    db.manualReviewCase.findUnique.mockResolvedValue({
      id: 'case-1',
      withdrawalId: 'wd-1',
      attemptId: 'a1',
      status: 'OPEN',
      category: 'PROVIDER_DATA_INCOMPLETE',
      attempt: { id: 'a1', status: PayoutAttemptStatus.MANUAL_REVIEW },
    });
    await expect(
      service.resolveCase('case-1', ADMIN, { resolution: 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE', note: 'bank confirmed' }, 'PAYOUT_MANUAL_REVIEW'),
    ).rejects.toThrow(new BadRequestException('Confirming provider success requires a registered private evidence file').message);
  });

  it('confirming provider success requires an INDEPENDENT reviewer (two distinct administrators)', async () => {
    const { db, service } = makeService();
    db.manualReviewCase.findUnique.mockResolvedValue({
      id: 'case-1',
      withdrawalId: 'wd-1',
      attemptId: 'a1',
      status: 'OPEN',
      category: 'PROVIDER_DATA_INCOMPLETE',
      attempt: { id: 'a1', status: PayoutAttemptStatus.MANUAL_REVIEW },
    });
    await expect(
      service.resolveCase('case-1', ADMIN, { resolution: 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE', note: 'x', evidenceFileId: 'file-1', reviewerId: ADMIN.id }, 'PAYOUT_MANUAL_REVIEW'),
    ).rejects.toThrow(/independent reviewer/);
  });

  it('resolution NEVER settles directly: the withdrawal stays non-PAID and no settlement call exists', async () => {
    const { db, service } = makeService();
    db.manualReviewCase.findUnique.mockResolvedValue({
      id: 'case-1',
      withdrawalId: 'wd-1',
      attemptId: 'a1',
      status: 'OPEN',
      category: 'PROVIDER_DATA_INCOMPLETE',
      attempt: { id: 'a1', status: PayoutAttemptStatus.MANUAL_REVIEW },
    });
    await service.resolveCase('case-1', ADMIN, { resolution: 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE', note: 'reviewed with evidence', evidenceFileId: 'file-1', reviewerId: 'admin-reviewer' }, 'PAYOUT_MANUAL_REVIEW');
    // The attempt is held in MANUAL_REVIEW with the evidence class — NOT SUCCESSFUL.
    expect(db.payoutAttempt.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.SUCCESSFUL }) }),
    );
    // The withdrawal is never moved to PAID by the review workflow.
    const withdrawalUpdates = (db.withdrawal as { updateMany?: jest.Mock }).updateMany;
    expect(withdrawalUpdates).toBeUndefined();
    // The audit trail records the resolution with the MFA purpose.
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'MANUAL_REVIEW_CASE_RESOLVED', metadata: expect.objectContaining({ mfaPurposeUsed: 'PAYOUT_MANUAL_REVIEW' }) }) }));
  });

  it('an already-resolved case cannot be resolved again (idempotency guard)', async () => {
    const { db, service } = makeService();
    db.manualReviewCase.findUnique.mockResolvedValue({ id: 'case-1', withdrawalId: 'wd-1', status: 'RESOLVED' });
    await expect(service.resolveCase('case-1', ADMIN, { resolution: 'NO_INTERNAL_CHANGE', note: 'dup' }, 'PAYOUT_MANUAL_REVIEW')).rejects.toThrow(/already resolved/);
  });

  it('stale UNKNOWN attempts escalate to OPEN cases with the MANUAL_REVIEW attempt state', async () => {
    const { db, service } = makeService();
    db.payoutAttempt.findMany.mockResolvedValue([
      { id: 'a-stale', withdrawalId: 'wd-1', status: PayoutAttemptStatus.UNKNOWN, updatedAt: new Date(Date.now() - 10 * 60_000) },
    ]);
    await service.escalateStaleUnknowns();
    expect(db.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.MANUAL_REVIEW }) }));
    expect(db.manualReviewCase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ category: 'PROVIDER_UNKNOWN', attemptId: 'a-stale' }) }));
  });
});

describe('fail-closed verification (v1.0.7 §5.3)', () => {
  function makeService(adapterOverrides: Record<string, unknown>) {
    const db = {
      payoutAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'a1',
          withdrawalId: 'wd-1',
          provider: 'PAYSTACK',
          status: PayoutAttemptStatus.PROVIDER_ACCEPTED,
          providerTransferRef: 'kdo-payout-wd-1-1',
          providerTransferId: '860703114',
          amount: 1_000_000n,
          currency: 'NGN',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const registry = { require: jest.fn().mockReturnValue({ name: 'PAYSTACK', supportsPayouts: () => true, ...adapterOverrides }) as unknown as never };
    const reconciliation = { apply: jest.fn().mockResolvedValue({ outcome: 'PROVIDER_PENDING', evaluation: {}, applied: false }) };
    const metrics = new PayoutSecurityMetricsService();
    const service = new PayoutVerificationService(db as never, registry as never, reconciliation as never, metrics);
    return { db, registry, reconciliation, service, metrics };
  }

  it('passes provider-reported amount/currency/beneficiary into reconciliation unchanged (exact comparison happens there)', async () => {
    const { reconciliation, service } = makeService({
      validatePayoutConfig: () => ({ ok: true }),
      getTransfer: jest.fn().mockResolvedValue(
        lookupFound({
          exists: true,
          providerStatus: 'success',
          providerTransferRef: 'kdo-payout-wd-1-1',
          providerTransferId: '860703114',
          amountMinor: 1_000_000n,
          currency: 'NGN',
          beneficiaryRef: 'RCP_approved',
          evidence: { status: 'success' },
        }),
      ),
      findTransferByReference: jest.fn(),
    });
    const result = await service.verifyAttempt('a1', { source: 'API_VERIFY' });
    expect(result.outcome).toBe('PROVIDER_PENDING');
    expect(reconciliation.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: 'a1',
        source: 'API_VERIFY',
        verification: expect.objectContaining({ classification: 'SUCCESSFUL', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' }),
      }),
    );
  });

  it('an AMBIGUOUS lookup during verification classifies UNKNOWN — never FAILED', async () => {
    const { reconciliation, service, metrics } = makeService({
      validatePayoutConfig: () => ({ ok: true }),
      // v1.0.9 §2 — lookups NEVER throw: an unsuccessful lookup is an explicit
      // AMBIGUOUS outcome (timeout / 5xx / rate-limit / malformed body).
      getTransfer: jest.fn().mockResolvedValue({ outcome: 'AMBIGUOUS', reason: 'lookup transport failure: network timeout', httpStatus: null, evidence: {} }),
      findTransferByReference: jest.fn(),
    });
    const result = await service.verifyAttempt('a1', { source: 'API_VERIFY' });
    expect(reconciliation.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        verification: expect.objectContaining({ classification: 'UNKNOWN', providerStatus: 'PROVIDER_UNAVAILABLE' }),
      }),
    );
    expect(result.verification?.classification).toBe('UNKNOWN');
    expect(metrics.snapshot().ambiguousLookupOutcomes).toBe(1);
  });

  it('an ERROR lookup (HTTP 401/403) classifies UNKNOWN with LOOKUP_ERROR — never FAILED', async () => {
    const { reconciliation, service } = makeService({
      validatePayoutConfig: () => ({ ok: true }),
      getTransfer: jest.fn().mockResolvedValue({ outcome: 'ERROR', reason: 'lookup rejected with HTTP 401', httpStatus: 401, evidence: {} }),
      findTransferByReference: jest.fn(),
    });
    await service.verifyAttempt('a1', { source: 'API_VERIFY' });
    expect(reconciliation.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        verification: expect.objectContaining({ classification: 'UNKNOWN', providerStatus: 'LOOKUP_ERROR' }),
      }),
    );
  });

  it('an authoritative NOT_FOUND for an ACCEPTED reference classifies UNKNOWN (resubmission decisions belong to the recovery path only)', async () => {
    const { reconciliation, service } = makeService({
      validatePayoutConfig: () => ({ ok: true }),
      getTransfer: jest.fn().mockResolvedValue({ outcome: 'NOT_FOUND', reason: 'LOOKUP_AUTHORITATIVE_NOT_FOUND', httpStatus: 404, evidence: {} }),
      findTransferByReference: jest.fn(),
    });
    await service.verifyAttempt('a1', { source: 'API_VERIFY' });
    expect(reconciliation.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        verification: expect.objectContaining({ classification: 'UNKNOWN', providerStatus: 'LOOKUP_NOT_FOUND' }),
      }),
    );
  });

  it('an attempt without any provider identity cannot be verified (submission incomplete)', async () => {
    const { db, service } = makeService({
      validatePayoutConfig: () => ({ ok: true }),
      getTransfer: jest.fn(),
      findTransferByReference: jest.fn(),
    });
    db.payoutAttempt.findUnique.mockResolvedValue({
      id: 'a1',
      withdrawalId: 'wd-1',
      provider: 'PAYSTACK',
      status: PayoutAttemptStatus.INITIATED,
      providerTransferRef: null,
      providerTransferId: null,
    });
    await expect(service.verifyAttempt('a1', { source: 'API_VERIFY' })).rejects.toThrow(/no provider transfer identity/);
  });
});
