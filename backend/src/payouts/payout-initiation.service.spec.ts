import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PayoutAttemptStatus, PayoutOutboxStatus, WithdrawalStatus } from '@prisma/client';
import { PayoutInitiationService } from './payout-initiation.service';
import { PayoutProviderRejectedError, PayoutTransportError, lookupAmbiguous, lookupError, lookupFound, type PayoutTransferDetails } from './payout-provider.adapter';
import { PayoutSecurityMetricsService } from './payout-metrics.service';

/**
 * v1.0.7 §8/§4 initiation pipeline unit tests (jest shells for prisma/queue;
 * the SEPARATION + SNAPSHOT + INTENT logic under test is real).
 */

const EXECUTOR = { id: 'admin-executor', role: 'ADMIN' };
const REQUESTER = { id: 'organizer-1', role: 'USER' };
const FIRST = { id: 'admin-first', role: 'ADMIN' };
const SECOND = { id: 'admin-second', role: 'ADMIN' };

function withdrawalRow(status: WithdrawalStatus = WithdrawalStatus.APPROVED) {
  return {
    id: 'wd-1',
    publicRef: 'WDR-TEST1',
    campaignId: 'camp-1',
    requestedById: REQUESTER.id,
    amount: 1_000_000n,
    feeAmount: 0n,
    netAmount: 1_000_000n,
    currency: 'NGN',
    method: 'BANK',
    destination: { accountNumber: '0123456789', bankCode: '058', accountName: 'Test Beneficiary' },
    status,
    approvalCycle: 1,
    destinationVersion: 1,
  };
}

function approvalRow(role: string, approverId: string) {
  return {
    id: `appr-${role}`,
    role,
    approverId,
    amountAtApproval: 1_000_000n,
    currencyAtApproval: 'NGN',
    destinationVersionAtApproval: 1,
    snapshotHash: null,
    status: 'ACTIVE',
  };
}

function makeDeps() {
  const db = {
    withdrawal: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payoutAttempt: {
      findFirst: jest.fn().mockResolvedValue(null),
      findFirstRaw: null as unknown,
      create: jest.fn().mockResolvedValue({ id: 'attempt-1', withdrawalId: 'wd-1', attemptNo: 1, provider: 'PAYSTACK', idempotencyKey: 'payout:wd-1:1', amount: 1_000_000n, currency: 'NGN', status: PayoutAttemptStatus.INITIATED, beneficiaryId: 'bene-1' }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    payoutOutbox: {
      create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'outbox-1', ...args.data })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    withdrawalApproval: { findMany: jest.fn().mockResolvedValue([approvalRow('FIRST_APPROVER', FIRST.id), approvalRow('SECOND_APPROVER', SECOND.id)]), update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    payoutBeneficiary: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'wd-1' }]),
    // v1.0.9 — guard claims/releases run as raw conditional updates.
    $executeRaw: jest.fn().mockResolvedValue(2),
    $transaction: null as unknown as jest.Mock,
  };
  db.withdrawal.findUniqueOrThrow.mockImplementation((args: { where: { id: string } }) => db.withdrawal.findUnique(args).then((r: unknown) => (r === null ? Promise.reject(new Error('not found')) : r)));
  db.$transaction = jest.fn(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));

  const attemptRow = {
    id: 'attempt-1',
    withdrawalId: 'wd-1',
    attemptNo: 1,
    provider: 'PAYSTACK',
    idempotencyKey: 'payout:wd-1:1',
    requestFingerprint: 'fp',
    amount: 1_000_000n,
    currency: 'NGN',
    status: PayoutAttemptStatus.INITIATED,
    beneficiaryId: 'bene-1',
    // v1.0.9 §4.1 — the PERSISTED executor identity passed to the validator.
    initiatedById: EXECUTOR.id,
    updatedAt: new Date(),
  };

  const registry = {
    require: jest.fn().mockReturnValue({
      name: 'PAYSTACK',
      supportsPayouts: () => true,
      validatePayoutConfig: () => ({ ok: true }),
      resolveBeneficiary: jest.fn().mockResolvedValue({ externalRef: 'RCP_test', fingerprint: 'fp-1', maskedDetails: {}, identity: { recipientCode: 'RCP_test' } }),
      initiateTransfer: jest.fn(),
      getTransfer: jest.fn(),
      findTransferByReference: jest.fn(),
    }),
    activeProviders: jest.fn().mockReturnValue(['PAYSTACK', 'FLUTTERWAVE']),
  };

  const beneficiaries = {
    ensureBeneficiary: jest.fn().mockResolvedValue({ id: 'bene-1', externalRef: 'RCP_test', identity: {} }),
    destinationHash: jest.fn().mockReturnValue('sha256:dest'),
    invalidateOnDestinationChange: jest.fn(),
  };

  const manualReview = {
    openCase: jest.fn().mockResolvedValue({ id: 'case-1' }),
    escalateStaleUnknowns: jest.fn().mockResolvedValue(0),
  };

  const queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn((key: string) => (key === 'payouts.unknownEscalationMinutes' ? 120 : undefined)) };

  const prismaShell = db as never;
  const approvalCycles = {
    validate: jest.fn().mockResolvedValue({ valid: true, invalidReason: null, approvalCycleId: 'wd-1#cycle1' }),
  } as never;
  const metrics = new PayoutSecurityMetricsService();
  const service = new PayoutInitiationService(
    prismaShell,
    registry as never,
    beneficiaries as never,
    manualReview as never,
    queue as never,
    config as never,
    approvalCycles,
    metrics,
  );
  return { db, registry, beneficiaries, manualReview, queue, config, attemptRow, service, metrics };
}

describe('payout initiation — executor separation BEFORE any provider call (v1.0.7 §8.2)', () => {
  it('the withdrawal requester cannot execute the payout', async () => {
    const { db, registry, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    await expect(service.initiate('wd-1', { id: REQUESTER.id, role: 'USER' }, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(
      new ForbiddenException('Executor separation: the withdrawal requester cannot execute the payout').message,
    );
    expect(registry.require).toHaveBeenCalled();
    // No provider beneficiary resolution may have happened.
    expect(db.payoutBeneficiary.findUnique).not.toHaveBeenCalled();
  });

  it('the first approver cannot execute the payout', async () => {
    const { db, beneficiaries, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    await expect(service.initiate('wd-1', { id: FIRST.id, role: 'ADMIN' }, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(
      /executor cannot be the first approver/,
    );
    expect(beneficiaries.ensureBeneficiary).not.toHaveBeenCalled();
  });

  it('the second approver cannot execute the payout', async () => {
    const { db, beneficiaries, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    await expect(service.initiate('wd-1', { id: SECOND.id, role: 'ADMIN' }, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(
      /executor cannot be the second approver/,
    );
    expect(beneficiaries.ensureBeneficiary).not.toHaveBeenCalled();
  });

  it('first and second approver being the same administrator is rejected', async () => {
    const { db, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    db.withdrawalApproval.findMany.mockResolvedValue([approvalRow('FIRST_APPROVER', FIRST.id), approvalRow('SECOND_APPROVER', FIRST.id)]);
    await expect(service.initiate('wd-1', EXECUTOR, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(/first and second approver must differ/);
  });

  it('a non-APPROVED withdrawal cannot be initiated (no retry flag)', async () => {
    const { db, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow(WithdrawalStatus.PROCESSING));
    await expect(service.initiate('wd-1', EXECUTOR, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(/APPROVED/);
  });
});

describe('payout initiation — provider gating (v1.0.7 §6)', () => {
  it('STRIPE payouts are rejected with the honest disable reason (never routed to another provider)', async () => {
    const { db, registry, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    registry.require.mockImplementation(() => {
      throw new ConflictException(
        '[STRIPE] payouts are not supported: Stripe payouts are disabled in v1.0.7: Stripe Connect transfers are not implemented. Stripe donations remain supported. Payouts are available via Paystack, Flutterwave or manual settlement.',
      );
    });
    await expect(service.initiate('wd-1', EXECUTOR, { payoutProvider: 'STRIPE' })).rejects.toThrow(/Stripe payouts are disabled/);
    expect(db.payoutOutbox.create).not.toHaveBeenCalled();
  });

  it('a misconfigured provider aborts before any intent is committed', async () => {
    const { db, registry, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    registry.require.mockReturnValue({
      name: 'PAYSTACK',
      supportsPayouts: () => true,
      validatePayoutConfig: () => ({ ok: false, reason: 'PAYSTACK_SECRET_KEY is not configured' }),
    } as never);
    await expect(service.initiate('wd-1', EXECUTOR, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(/misconfigured/);
    expect(db.payoutOutbox.create).not.toHaveBeenCalled();
  });
});

describe('payout initiation — durable intent + outbox (v1.0.7 §4.2)', () => {
  it('commits attempt + outbox atomically and dispatches the submission job', async () => {
    const { db, queue, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    const attempt = await service.initiate('wd-1', EXECUTOR, { payoutProvider: 'PAYSTACK' });
    expect(attempt.status).toBe(PayoutAttemptStatus.INITIATED);
    expect(db.payoutAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          withdrawalId: 'wd-1',
          provider: 'PAYSTACK',
          beneficiaryId: 'bene-1',
          requestFingerprint: expect.any(String),
          idempotencyKey: 'payout:wd-1:1',
        }),
      }),
    );
    expect(db.payoutOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptId: expect.any(String),
          idempotencyKey: 'payout:wd-1:1',
          requestFingerprint: expect.any(String),
          payload: expect.objectContaining({ providerReference: expect.stringMatching(/^kdo-payout-wd-1-1$/) }),
        }),
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith('payouts', 'payouts.submit-outbox', { outboxAttemptId: 'attempt-1' }, { jobId: 'outbox-attempt-1' });
    // Snapshot hash bound to BOTH approvals.
    expect(db.withdrawalApproval.update).toHaveBeenCalledTimes(2);
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PAYOUT_INTENT_COMMITTED' }) }));
  });

  it('an unresolved attempt blocks a new intent (duplicate transfer prevention)', async () => {
    const { db, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    db.payoutAttempt.findFirst.mockResolvedValue({ id: 'old-attempt', attemptNo: 1, status: PayoutAttemptStatus.SUBMISSION_PENDING });
    await expect(service.initiate('wd-1', EXECUTOR, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(/cannot be initiated until the original attempt is authoritatively resolved/);
    expect(db.payoutOutbox.create).not.toHaveBeenCalled();
  });

  it('a state change between read and commit aborts initiation without submitting', async () => {
    const { db, queue, service } = makeDeps();
    db.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    db.$transaction = jest.fn(async (fn: (tx: typeof db) => Promise<unknown>) => {
      // The locked re-read sees a DIFFERENT amount — the abort must happen
      // before any attempt/outbox row is created.
      (db as { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValueOnce([{ id: 'wd-1' }]);
      return fn({
        ...db,
        withdrawal: {
          ...db.withdrawal,
          findUnique: jest.fn().mockResolvedValue({ ...withdrawalRow(), amount: 2_000_000n, status: WithdrawalStatus.PROCESSING }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...withdrawalRow(), amount: 2_000_000n, status: WithdrawalStatus.PROCESSING }),
        },
      } as never);
    });
    await expect(service.initiate('wd-1', EXECUTOR, { payoutProvider: 'PAYSTACK' })).rejects.toThrow(/changed concurrently/);
    expect(db.payoutAttempt.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('outbox submission — ambiguity is never a retry (v1.0.7 §4.3)', () => {
  function setupOutbox(deps: ReturnType<typeof makeDeps>, opts: { attemptStatus?: PayoutAttemptStatus; providerTransferRef?: string | null } = {}) {
    const { db, registry, queue, manualReview, config, service, attemptRow } = deps;
    const attempt = {
      ...attemptRow,
      status: opts.attemptStatus ?? PayoutAttemptStatus.INITIATED,
      providerTransferRef: opts.providerTransferRef ?? null,
    };
    db.payoutOutbox = {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({
        id: 'outbox-1',
        attemptId: 'attempt-1',
        withdrawalId: 'wd-1',
        idempotencyKey: 'payout:wd-1:1',
        status: PayoutOutboxStatus.PENDING,
        attempts: 1,
        requestFingerprint: 'fp',
        payload: {
          provider: 'PAYSTACK',
          providerReference: 'kdo-payout-wd-1-1',
          amountMinor: '1000000',
          currency: 'NGN',
          beneficiaryId: 'bene-1',
          beneficiaryExternalRef: 'RCP_test',
          beneficiaryIdentity: { kind: 'bank', bankCode: '058', accountNumber: '0123456789', accountName: 'Test Beneficiary' },
          narration: 'KINDORA withdrawal WDR-TEST1',
          correlationId: 'KPO-WDR-TEST1',
        },
        nextRunAt: new Date(Date.now() - 1000),
        updatedAt: new Date(),
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    } as never;
    void queue;
    db.withdrawal.findUnique.mockResolvedValue({ ...withdrawalRow(WithdrawalStatus.PROCESSING) });
    db.withdrawal.findUniqueOrThrow.mockResolvedValue({ ...withdrawalRow(WithdrawalStatus.PROCESSING) });
    db.payoutAttempt.findUnique = jest.fn().mockResolvedValue(attempt);
    db.payoutAttempt.findUniqueOrThrow = jest.fn().mockResolvedValue(attempt);
    db.payoutBeneficiary.findUnique = jest.fn().mockResolvedValue({ id: 'bene-1', status: 'ACTIVE', destinationVersion: 1 });
    db.withdrawalApproval.findMany.mockResolvedValue([
      { ...approvalRow('FIRST_APPROVER', FIRST.id), snapshotHash: 'h1' },
      { ...approvalRow('SECOND_APPROVER', SECOND.id), snapshotHash: 'h1' },
    ]);
    db.withdrawalApproval.update = jest.fn().mockResolvedValue({});
    db.auditLog.create.mockResolvedValue({});
    db.payoutAttempt.update = jest.fn().mockResolvedValue({});
    db.$queryRaw.mockResolvedValue([{ id: attempt.id, status: attempt.status, withdrawalId: attempt.withdrawalId, requestFingerprint: attempt.requestFingerprint }]);
    return { db, registry, queue, manualReview, config, service };
  }

  it('definite provider rejection -> attempt FAILED + withdrawal FAILED + outbox FAILED_PERMANENT', async () => {
    const { db, registry, service } = setupOutbox(makeDeps());
    registry.require().initiateTransfer.mockRejectedValue(new PayoutProviderRejectedError('insufficient balance', 'PAYSTACK'));
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('REJECTED');
    expect(db.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'attempt-1' }, data: expect.objectContaining({ status: PayoutAttemptStatus.FAILED }) }));
    expect(db.withdrawal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: WithdrawalStatus.FAILED }) }));
    expect(db.payoutOutbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutOutboxStatus.FAILED_PERMANENT }) }));
  });

  it('ambiguous transport error -> SUBMISSION_PENDING, outbox back to PENDING with backoff (NO resubmission)', async () => {
    const { db, registry, service } = setupOutbox(makeDeps());
    registry.require().initiateTransfer.mockRejectedValue(new PayoutTransportError('network timeout', 'PAYSTACK', 'INITIATION'));
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('AMBIGUOUS');
    expect(db.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.SUBMISSION_PENDING, classification: 'UNKNOWN' }) }));
    const outboxUpdate = db.payoutOutbox.update.mock.calls[0][0];
    expect(outboxUpdate.data.status).toBe(PayoutOutboxStatus.PENDING);
    expect(outboxUpdate.data.nextRunAt).toBeInstanceOf(Date);
  });

  it('provider acceptance persists the provider transfer identity (ref + id) and marks the outbox SUBMITTED', async () => {
    const { db, registry, queue, service } = setupOutbox(makeDeps());
    registry.require().initiateTransfer.mockResolvedValue({
      accepted: true,
      providerTransferRef: 'kdo-payout-wd-1-1',
      providerTransferId: '860703114',
      providerStatus: 'pending',
      evidence: { status: 'pending' },
    });
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('SUBMITTED');
    expect(db.payoutAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: PayoutAttemptStatus.PENDING, providerTransferRef: 'kdo-payout-wd-1-1', providerTransferId: '860703114' }),
      }),
    );
    expect(db.payoutOutbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutOutboxStatus.SUBMITTED }) }));
    expect(queue.enqueue).toHaveBeenCalledWith('payouts', 'payouts.verify-attempt', { attemptId: 'attempt-1' }, expect.objectContaining({ delayMs: expect.any(Number) }));
  });

  it('an attempt that already carries a provider identity is NEVER resubmitted (crash recovery §4.4)', async () => {
    const { db, registry, service } = setupOutbox(makeDeps(), { providerTransferRef: 'already-submitted' });
    const initiate = registry.require().initiateTransfer;
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('ALREADY_SUBMITTED');
    expect(initiate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// v1.0.9 §2/§3/§7 — explicit lookup outcomes, durable coordination guard and
// reconcile-before-resubmission recovery.
// ---------------------------------------------------------------------------

describe('outbox submission — explicit lookup outcomes gate EVERY resubmission (v1.0.9 §2)', () => {
  function transfer(): PayoutTransferDetails {
    return {
      exists: true,
      providerStatus: 'success',
      providerTransferRef: 'kdo-payout-wd-1-1',
      providerTransferId: '860703114',
      amountMinor: 1_000_000n,
      currency: 'NGN',
      beneficiaryRef: 'RCP_test',
      evidence: { status: 'success' },
    };
  }

  function setupWithAttempts(opts: { attemptStatus?: PayoutAttemptStatus; updateManyCounts?: number[]; attempts?: number } = {}) {
    const deps = makeDeps();
    const { db, registry, queue, manualReview, config, service, attemptRow, metrics } = deps;
    const attempt = {
      ...attemptRow,
      status: opts.attemptStatus ?? PayoutAttemptStatus.INITIATED,
      providerTransferRef: null,
    };
    const counts = opts.updateManyCounts ?? [1];
    let call = 0;
    db.payoutOutbox = {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({
        id: 'outbox-1',
        attemptId: 'attempt-1',
        withdrawalId: 'wd-1',
        idempotencyKey: 'payout:wd-1:1',
        status: PayoutOutboxStatus.PENDING,
        attempts: opts.attempts ?? 2, // previously claimed → the recovery gate applies
        requestFingerprint: 'fp',
        payload: {
          provider: 'PAYSTACK',
          providerReference: 'kdo-payout-wd-1-1',
          amountMinor: '1000000',
          currency: 'NGN',
          beneficiaryId: 'bene-1',
          beneficiaryExternalRef: 'RCP_test',
          beneficiaryIdentity: { kind: 'bank', bankCode: '058', accountNumber: '0123456789', accountName: 'Test Beneficiary' },
          narration: 'KINDORA withdrawal WDR-TEST1',
          correlationId: 'KPO-WDR-TEST1',
        },
        nextRunAt: new Date(Date.now() - 1000),
        updatedAt: new Date(),
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockImplementation(() => Promise.resolve({ count: counts[Math.min(call++, counts.length - 1)] })),
    } as never;
    void queue;
    db.withdrawal.findUnique.mockResolvedValue({ ...withdrawalRow(WithdrawalStatus.PROCESSING) });
    db.withdrawal.findUniqueOrThrow.mockResolvedValue({ ...withdrawalRow(WithdrawalStatus.PROCESSING) });
    db.payoutAttempt.findUnique = jest.fn().mockResolvedValue(attempt);
    db.payoutAttempt.findUniqueOrThrow = jest.fn().mockResolvedValue(attempt);
    db.payoutBeneficiary.findUnique = jest.fn().mockResolvedValue({ id: 'bene-1', status: 'ACTIVE', destinationVersion: 1 });
    db.withdrawalApproval.findMany.mockResolvedValue([
      { ...approvalRow('FIRST_APPROVER', FIRST.id), snapshotHash: 'h1' },
      { ...approvalRow('SECOND_APPROVER', SECOND.id), snapshotHash: 'h1' },
    ]);
    db.auditLog.create.mockResolvedValue({});
    db.payoutAttempt.update = jest.fn().mockResolvedValue({});
    db.$queryRaw.mockResolvedValue([{ id: attempt.id, status: attempt.status, withdrawalId: attempt.withdrawalId, requestFingerprint: attempt.requestFingerprint }]);
    return { db, registry, manualReview, config, service, metrics };
  }

  it('an AMBIGUOUS lookup after a stale lease NEVER resubmits — the claim is released with backoff', async () => {
    const { db, registry, service, metrics } = setupWithAttempts();
    const adapter = registry.require();
    adapter.findTransferByReference.mockResolvedValue(lookupAmbiguous('lookup rate-limited (HTTP 429)'));
    const initiate = adapter.initiateTransfer;
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('LOOKUP_BLOCKED');
    expect(initiate).not.toHaveBeenCalled(); // no second transfer
    expect(db.payoutAttempt.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.INITIATED }) }));
    // v1.0.9 — recordLookupOutcome writes a lookup-outcome update first; the
    // backoff update is the one carrying a status.
    const outboxUpdate = db.payoutOutbox.update.mock.calls.map((c) => c[0]).find((c) => c.data?.status !== undefined);
    expect(outboxUpdate.data.status).toBe(PayoutOutboxStatus.PENDING);
    expect(outboxUpdate.data.nextRunAt).toBeInstanceOf(Date);
    expect(outboxUpdate.data.lastError).toContain('AMBIGUOUS');
    expect(metrics.snapshot().ambiguousLookupOutcomes).toBe(1);
  });

  it('an ERROR lookup (HTTP 401) after a stale lease NEVER resubmits and never releases the reservation', async () => {
    const { db, registry, service } = setupWithAttempts();
    const adapter = registry.require();
    adapter.findTransferByReference.mockResolvedValue(lookupError('lookup rejected with HTTP 401'));
    const initiate = adapter.initiateTransfer;
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('LOOKUP_BLOCKED');
    expect(initiate).not.toHaveBeenCalled();
    // No attempt STATUS change (the lookup-outcome bookkeeping update is not a
    // state transition) and no reservation release.
    expect(db.payoutAttempt.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: expect.anything() }) }));
    expect(db.withdrawal.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: WithdrawalStatus.FAILED }) }));
  });

  it('an AUTHORITATIVE NOT_FOUND after a stale lease permits the resubmission of the SAME reference', async () => {
    const { db, registry, service } = setupWithAttempts();
    const adapter = registry.require();
    adapter.findTransferByReference.mockResolvedValue({ outcome: 'NOT_FOUND', reason: 'LOOKUP_AUTHORITATIVE_NOT_FOUND', httpStatus: 404, evidence: {} });
    adapter.initiateTransfer.mockResolvedValue({
      accepted: true,
      providerTransferRef: 'kdo-payout-wd-1-1',
      providerTransferId: '860703114',
      providerStatus: 'pending',
      evidence: { status: 'pending' },
    });
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('SUBMITTED');
    // The SAME stable provider reference reaches the provider (idempotency §2.4).
    expect(adapter.initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ providerReference: 'kdo-payout-wd-1-1', idempotencyKey: 'payout:wd-1:1' }));
    expect(db.payoutOutbox.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutOutboxStatus.SUBMITTED }) }));
  });

  it('a FOUND lookup after a stale lease adopts the existing transfer — no new submission', async () => {
    const { db, registry, service } = setupWithAttempts();
    const adapter = registry.require();
    adapter.findTransferByReference.mockResolvedValue(lookupFound(transfer()));
    const initiate = adapter.initiateTransfer;
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('LOOKUP_FOUND');
    expect(initiate).not.toHaveBeenCalled();
    expect(db.payoutAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ providerTransferRef: 'kdo-payout-wd-1-1' }) }),
    );
  });

  it('a SUBMISSION_PENDING attempt with an AMBIGUOUS lookup keeps the reservation and retries the LOOKUP (not the submission)', async () => {
    const { db, registry, service } = setupWithAttempts({ attemptStatus: PayoutAttemptStatus.SUBMISSION_PENDING });
    const adapter = registry.require();
    adapter.findTransferByReference.mockResolvedValue(lookupAmbiguous('lookup transport failure: connection reset'));
    const initiate = adapter.initiateTransfer;
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('LOOKUP_BLOCKED');
    expect(initiate).not.toHaveBeenCalled();
    const outboxUpdateSp = db.payoutOutbox.update.mock.calls.map((c) => c[0]).find((c) => c.data?.status !== undefined);
    expect(outboxUpdateSp.data.status).toBe(PayoutOutboxStatus.PENDING);
  });

  it('a SUBMISSION_PENDING attempt with an AUTHORITATIVE NOT_FOUND re-arms the SAME attempt (same reference)', async () => {
    const { db, registry, service } = setupWithAttempts({ attemptStatus: PayoutAttemptStatus.SUBMISSION_PENDING });
    const adapter = registry.require();
    adapter.findTransferByReference.mockResolvedValue({ outcome: 'NOT_FOUND', reason: 'LOOKUP_AUTHORITATIVE_NOT_FOUND', httpStatus: 404, evidence: {} });
    adapter.initiateTransfer.mockResolvedValue({
      accepted: true,
      providerTransferRef: 'kdo-payout-wd-1-1',
      providerTransferId: '860703114',
      providerStatus: 'pending',
      evidence: { status: 'pending' },
    });
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('SUBMITTED');
    expect(adapter.initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ providerReference: 'kdo-payout-wd-1-1' }));
    expect(db.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.INITIATED }) }));
  });

  it('a valid manual-settlement guard claim DEFERS the submission (competing settlement path)', async () => {
    const { db, registry, service, metrics } = setupWithAttempts();
    // Guard claim returns 0 rows (held by another path) — but the FIRST
    // $executeRaw call sequence must reflect that. The guard claim is the
    // only $executeRaw in the stateCheck transaction.
    (db.$executeRaw as jest.Mock).mockResolvedValueOnce(0);
    const adapter = registry.require();
    const initiate = adapter.initiateTransfer;
    const summary = await service.submitOutbox('attempt-1');
    expect(summary.action).toBe('LOOKUP_PENDING');
    expect(summary.detail).toContain('guard');
    expect(initiate).not.toHaveBeenCalled();
    expect(metrics.snapshot().blockedSubmissionsByGuard).toBe(1);
  });
});
