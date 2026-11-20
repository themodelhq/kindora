import { PayoutAttemptStatus, WithdrawalStatus } from '@prisma/client';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { ManualReviewService } from './manual-review.service';
import { PayoutApprovalCycleService } from './payout-approval-cycle.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';
import { LedgerService } from '../ledger/ledger.service';

/**
 * v1.0.7 §7.3 / v1.0.8 §4.5 — ATOMIC reconciliation for every outcome. The
 * test shell executes the single $transaction callback against one shared
 * `tx` object and asserts that EVERY state mutation for the outcome happened
 * on that same transaction client (all-or-nothing discipline) and that no
 * outcome can partially commit.
 *
 * v1.0.8: the shell carries a VALID approval cycle (four distinct identities,
 * bound amount/currency/destination version, matching snapshot hash) so the
 * mandatory approval-cycle gate passes for legitimate outcomes — and a
 * dedicated suite proves an INVALID cycle BLOCKS settlement.
 */

// Snapshot hash bound at initiation for the shell's fixture cycle (computed
// with the same canonical function the pipeline uses).
const SNAPSHOT_HASHES = (() => {
  const probe = new PayoutApprovalCycleService({} as never);
  const valid = probe.snapshotHash({
    withdrawalId: 'wd-1',
    amountMinor: 1_000_000n,
    currency: 'NGN',
    destinationVersion: 1,
    provider: 'PAYSTACK',
    beneficiaryId: 'bene-1',
    requesterId: 'req-1',
    firstApproverId: 'a1',
    secondApproverId: 'a2',
    cycle: 1,
  });
  return { valid };
})();

function makeShell(opts: { approvalCycle?: 'VALID' | 'INVALID_DUPLICATE_APPROVER' | 'NONE' } = {}) {
  const auditRows: unknown[] = [];
  const withdrawalRow = {
    id: 'wd-1',
    requestedById: 'req-1',
    status: WithdrawalStatus.PROCESSING,
    approvalCycle: 1,
    amount: 1_000_000n,
    currency: 'NGN',
    destinationVersion: 1,
  };
  const approvalRows =
    opts.approvalCycle === 'NONE'
      ? []
      : opts.approvalCycle === 'INVALID_DUPLICATE_APPROVER'
        ? [
            { role: 'FIRST_APPROVER', approverId: 'a1', status: 'ACTIVE', amountAtApproval: 1_000_000n, currencyAtApproval: 'NGN', destinationVersionAtApproval: 1, snapshotHash: null },
            { role: 'SECOND_APPROVER', approverId: 'a1', status: 'ACTIVE', amountAtApproval: 1_000_000n, currencyAtApproval: 'NGN', destinationVersionAtApproval: 1, snapshotHash: null },
          ]
        : [
            { role: 'FIRST_APPROVER', approverId: 'a1', status: 'ACTIVE', amountAtApproval: 1_000_000n, currencyAtApproval: 'NGN', destinationVersionAtApproval: 1, snapshotHash: SNAPSHOT_HASHES.valid },
            { role: 'SECOND_APPROVER', approverId: 'a2', status: 'ACTIVE', amountAtApproval: 1_000_000n, currencyAtApproval: 'NGN', destinationVersionAtApproval: 1, snapshotHash: SNAPSHOT_HASHES.valid },
          ];
  const tx = {
    $queryRaw: jest.fn(),
    // v1.0.9 — the reconciliation settles the coordination guard via raw SQL.
    $executeRaw: jest.fn().mockResolvedValue(1),
    withdrawal: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
      // v1.0.8 — the approval-cycle validator reads the withdrawal inside tx.
      findUnique: jest.fn().mockResolvedValue(withdrawalRow),
    },
    payoutAttempt: { update: jest.fn().mockResolvedValue({}) },
    payoutBeneficiary: { findUnique: jest.fn().mockResolvedValue({ id: 'bene-1', externalRef: 'RCP_approved', status: 'ACTIVE' }) },
    withdrawalApproval: {
      // Honor the ACTIVE filter like Prisma would.
      findMany: jest.fn().mockImplementation((args: { where?: { status?: string } }) => approvalRows.filter((a) => !args?.where?.status || a.status === args.where.status)),
    },
    payoutVerificationEvidence: { create: jest.fn().mockResolvedValue({}) },
    payoutReconciliation: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockImplementation((args: unknown) => { auditRows.push(args); return Promise.resolve({}); }) },
  };

  const db = {
    payoutAttempt: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    manualReviewCase: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    $transaction: null as unknown as jest.Mock,
  };
  // The service opens ONE transaction per apply(); the shell runs the callback
  // against the SAME tx and lets thrown errors reject the whole "transaction".
  db.$transaction = jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
  const ledger = {
    postWithdrawal: jest.fn().mockResolvedValue({ id: 'txn-1' }),
    postWithdrawalReversal: jest.fn().mockResolvedValue({ id: 'txn-reversal-1' }),
  } as unknown as LedgerService;
  const manualReview = {
    openCase: jest.fn().mockResolvedValue({ id: 'case-1' }),
    escalateStaleUnknowns: jest.fn().mockResolvedValue(0),
  } as unknown as ManualReviewService;
  const approvalCycles = new PayoutApprovalCycleService(db as never);
  const metrics = new PayoutSecurityMetricsService();
  const service = new PayoutReconciliationService(db as never, ledger, manualReview, approvalCycles, metrics);

  // Attempt row used for every scenario.
  const attempt = {
    id: 'attempt-1',
    withdrawalId: 'wd-1',
    attemptNo: 1,
    provider: 'PAYSTACK',
    idempotencyKey: 'payout:wd-1:1',
    amount: 1_000_000n,
    currency: 'NGN',
    status: PayoutAttemptStatus.PROVIDER_ACCEPTED,
    providerTransferRef: 'kdo-payout-wd-1-1',
    providerTransferId: '860703114',
    beneficiaryId: 'bene-1',
    // v1.0.9 §4.2 — the PERSISTED executor identity (fourth person, distinct
    // from requester req-1 and approvers a1/a2) is now mandatory at
    // reconciliation; a missing executor invalidates the cycle.
    initiatedById: 'exec-1',
    destinationRef: 'sha256:dest',
  };

  db.payoutAttempt.findUnique.mockResolvedValue(attempt);

  function lockedWithdrawal(status: WithdrawalStatus) {
    return { id: 'wd-1', status, approvalCycle: 1, amount: 1_000_000n, currency: 'NGN' };
  }
  // v1.0.10 §5.2 — the locked payout-attempt query now selects withdrawalId,
  // initiatedById, provider, idempotencyKey together with the settlement
  // fields; the shell's locked row mirrors the REAL locked shape. Overrides
  // let the executor/collision scenarios simulate authoritative row values.
  function lockedAttempt(
    status: PayoutAttemptStatus,
    overrides: Partial<{ initiatedById: string | null; provider: string; idempotencyKey: string; withdrawalId: string }> = {},
  ) {
    return {
      id: attempt.id,
      withdrawalId: attempt.withdrawalId,
      initiatedById: attempt.initiatedById,
      provider: attempt.provider,
      providerTransferRef: attempt.providerTransferRef,
      idempotencyKey: attempt.idempotencyKey,
      status,
      amount: attempt.amount,
      currency: attempt.currency,
      beneficiaryId: attempt.beneficiaryId,
      reversalState: null,
      ...overrides,
    };
  }

  return { db, tx, auditRows, ledger, manualReview, service, attempt, lockedWithdrawal, lockedAttempt, withdrawalRow };
}

describe('atomic reconciliation (v1.0.7 §7.3)', () => {
  it('verified success: settles in ONE transaction — attempt SUCCESSFUL + withdrawal PAID + ledger + evidence + audit', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)]) // withdrawal lock
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]); // attempt lock
    tx.withdrawal.findUniqueOrThrow.mockResolvedValue({ id: 'wd-1', publicRef: 'WDR-1', campaignId: 'c1', currency: 'NGN', amount: 1_000_000n, feeAmount: 0n, netAmount: 1_000_000n });

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: {
        classification: 'SUCCESSFUL',
        providerStatus: 'success',
        providerReference: 'kdo-payout-wd-1-1',
        providerTransferId: '860703114',
        amountMinor: 1_000_000n,
        currency: 'NGN',
        beneficiaryRef: 'RCP_approved',
        evidence: { status: 'success' },
      },
    });

    expect(result.outcome).toBe('PROVIDER_SUCCESS_INTERNAL_PENDING');
    expect(result.applied).toBe(true);
    // ALL writes on the SAME transaction client:
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.payoutVerificationEvidence.create).toHaveBeenCalledTimes(1);
    expect(tx.payoutReconciliation.create).toHaveBeenCalledTimes(1);
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'attempt-1' }, data: expect.objectContaining({ status: PayoutAttemptStatus.SUCCESSFUL }) }));
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: [WithdrawalStatus.PROCESSING, WithdrawalStatus.REQUIRES_RECONCILIATION] } }), data: expect.objectContaining({ status: WithdrawalStatus.PAID }) }));
    expect(ledger.postWithdrawal).toHaveBeenCalledTimes(1);
    // Settlement ledger entry ran inside the transaction (tx passed through).
    expect((ledger.postWithdrawal as jest.Mock).mock.calls[0][1]).toBe(tx);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PAYOUT_SETTLED_PROVIDER_VERIFIED' }) }));
    // No manual review case for a clean settlement.
    expect((manualReview.openCase as jest.Mock).mock.calls.length).toBe(0);
  });

  it('pending outcome: attempt PENDING, withdrawal stays PROCESSING, reservation intact, no ledger', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'PENDING', providerStatus: 'pending' },
    });
    expect(result.outcome).toBe('PROVIDER_PENDING');
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.PENDING }) }));
    // The withdrawal is NOT moved and the ledger is NOT touched.
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
  });

  it('authoritative failure: attempt FAILED + withdrawal FAILED atomically (reservation released by status change)', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'FAILED', providerStatus: 'failed', failureReason: 'beneficiary account blocked' },
    });
    expect(result.outcome).toBe('PROVIDER_FAILED_INTERNAL_PROCESSING');
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.FAILED }) }));
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: WithdrawalStatus.FAILED }) }));
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
  });

  it('verified reversal: recorded separately, PAID -> REVERSED, with audit + manual review case (§7.4)', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PAID)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.SUCCESSFUL)]);
    tx.withdrawal.findUniqueOrThrow.mockResolvedValue({ id: 'wd-1', publicRef: 'WDR-1', campaignId: 'c1', currency: 'NGN', amount: 1_000_000n, feeAmount: 0n, netAmount: 1_000_000n });

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'REVERSED', providerStatus: 'reversed', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(result.outcome).toBe('PROVIDER_REVERSED');
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.REVERSED }) }));
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: WithdrawalStatus.REVERSED }) }));
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'PROVIDER_REVERSAL' }));
  });

  it('AMOUNT MISMATCH: never settles, keeps the reservation, escalates to a manual review case', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 500n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(result.outcome).toBe('AMOUNT_MISMATCH');
    expect(tx.withdrawal.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: WithdrawalStatus.PROCESSING }), data: expect.objectContaining({ status: WithdrawalStatus.REQUIRES_RECONCILIATION }) }));
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'AMOUNT_MISMATCH' }));
  });

  it('MISSING provider beneficiary evidence on a success -> PROVIDER_DATA_INCOMPLETE, fail closed', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1_000_000n, currency: 'NGN' },
    });
    expect(result.outcome).toBe('PROVIDER_DATA_INCOMPLETE');
    expect((ledger as unknown as { postWithdrawal: jest.Mock }).postWithdrawal).not.toHaveBeenCalled();
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'PROVIDER_DATA_INCOMPLETE' }));
  });

  it('provider beneficiary not matching the approved one -> DESTINATION_MISMATCH (never settles)', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_SOMEONE_ELSE' },
    });
    expect(result.outcome).toBe('DESTINATION_MISMATCH');
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'BENEFICIARY_MISMATCH' }));
  });

  it('a failed withdrawal state update aborts the ENTIRE transaction (no partial commit)', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);
    tx.withdrawal.findUniqueOrThrow.mockResolvedValue({ id: 'wd-1', publicRef: 'WDR-1', campaignId: 'c1', currency: 'NGN', amount: 1_000_000n, feeAmount: 0n, netAmount: 1_000_000n });
    // The withdrawal state transition loses the race: updateMany returns 0.
    tx.withdrawal.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.apply({
        attemptId: 'attempt-1',
        source: 'API_VERIFY',
        verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
      }),
    ).rejects.toThrow(/changed concurrently during settlement/);
    // The transaction rolled back: the reconciliation row was attempted but
    // the caller sees the throw — in a real DB every write in the callback
    // would be rolled back together. Critically, the LEDGER was never posted
    // after the failure point.
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
  });

  it('duplicate provider reference bound to another attempt -> DUPLICATE_REFERENCE, never settles', async () => {
    const { db, tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    db.payoutAttempt.findFirst.mockResolvedValue({ id: 'attempt-OTHER' }); // ref already bound elsewhere
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved', providerReference: 'kdo-payout-wd-1-1' },
    });
    expect(result.outcome).toBe('DUPLICATE_REFERENCE');
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'DUPLICATE_REFERENCE' }));
  });

  // ---- v1.0.8 §4.5 — the approval cycle is a MANDATORY settlement gate ----

  it('v1.0.8: an INVALID approval cycle (duplicate approver) BLOCKS a verified success — no settlement, escalation', async () => {
    const { tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell({ approvalCycle: 'INVALID_DUPLICATE_APPROVER' });
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    // Provider verification can NEVER replace internal authorization.
    expect(result.outcome).toBe('INTERNAL_STATE_MISMATCH');
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.MANUAL_REVIEW }) }));
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: WithdrawalStatus.PAID }) }));
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE' }) }));
  });

  it('v1.0.8: a MISSING approval cycle BLOCKS a verified success', async () => {
    const { tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell({ approvalCycle: 'NONE' });
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'SUCCESSFUL', providerStatus: 'success', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(result.outcome).toBe('INTERNAL_STATE_MISMATCH');
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE' }) }));
  });

  it('v1.0.8 §8.2: an IN-PROGRESS reversal is recorded in the reversal lifecycle — attempt stays unresolved, withdrawal untouched', async () => {
    const { db, tx, ledger, manualReview, service, attempt, lockedWithdrawal, lockedAttempt } = makeShell();
    // Flutterwave reports reverse_initiated/reversing — provider-specific
    // reversal lifecycle normalization (Paystack exposes no such statuses).
    db.payoutAttempt.findUnique.mockResolvedValue({ ...attempt, provider: 'FLUTTERWAVE' } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      // v1.0.10 §5.5 — the reversal lifecycle reads the PROVIDER from the
      // LOCKED row: the locked attempt is FLUTTERWAVE here too.
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PENDING, { provider: 'FLUTTERWAVE' })]);

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'REVERSAL_IN_PROGRESS', providerStatus: 'reverse_initiated', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(result.outcome).toBe('PROVIDER_REVERSAL_IN_PROGRESS');
    // The attempt is NOT flipped to terminal REVERSED — only the lifecycle advances.
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reversalState: 'INITIATED', classification: 'REVERSAL_IN_PROGRESS' }) }));
    expect(tx.payoutAttempt.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.REVERSED }) }));
    // The withdrawal is NOT moved and the ledger is NOT touched.
    expect(tx.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(ledger.postWithdrawalReversal).not.toHaveBeenCalled();
    // A controlled recovery decision is escalated.
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'PROVIDER_REVERSAL' }));
  });

  it('v1.0.8 §8.3: a COMPLETED reversal posts the accounting correction exactly once', async () => {
    const { tx, ledger, manualReview, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PAID)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.SUCCESSFUL)]);
    tx.withdrawal.findUniqueOrThrow.mockResolvedValue({ id: 'wd-1', publicRef: 'WDR-1', campaignId: 'c1', currency: 'NGN', amount: 1_000_000n, feeAmount: 0n, netAmount: 1_000_000n });

    const result = await service.apply({
      attemptId: 'attempt-1',
      source: 'API_VERIFY',
      verification: { classification: 'REVERSED', providerStatus: 'reversed', amountMinor: 1_000_000n, currency: 'NGN', beneficiaryRef: 'RCP_approved' },
    });
    expect(result.outcome).toBe('PROVIDER_REVERSED');
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.REVERSED, reversalState: 'COMPLETED' }) }));
    // The reversal accounting correction posts ONCE, inside the transaction,
    // with its own exactly-once ledger reference — the original settlement
    // history is preserved untouched.
    expect(ledger.postWithdrawalReversal).toHaveBeenCalledTimes(1);
    expect((ledger.postWithdrawalReversal as jest.Mock).mock.calls[0][1]).toBe(tx);
    expect((manualReview.openCase as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ category: 'PROVIDER_REVERSAL' }));
  });

  // ---- v1.0.10 §5.6 — the LOCKED executor identity governs settlement ----

  const successVerification = {
    classification: 'SUCCESSFUL' as const,
    providerStatus: 'success',
    amountMinor: 1_000_000n,
    currency: 'NGN',
    beneficiaryRef: 'RCP_approved',
  };

  function expectBlockedByInvalidCycle(tx: { auditLog: { create: jest.Mock }; payoutAttempt: { update: jest.Mock } }) {
    expect(tx.payoutAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: PayoutAttemptStatus.MANUAL_REVIEW }) }));
    const blockedCall = tx.auditLog.create.mock.calls.map((c: unknown[]) => c[0]).find((d: { data?: { action?: string } }) => d?.data?.action === 'PAYOUT_SETTLEMENT_BLOCKED_INVALID_APPROVAL_CYCLE');
    expect(blockedCall).toBeTruthy();
    return (blockedCall as { data: { metadata: Record<string, unknown> } }).data.metadata;
  }

  it('v1.0.10 §5.6: a MISSING locked executor blocks reconciliation — the validator receives locked.initiatedById, never a caller-supplied one', async () => {
    const { tx, ledger, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      // The LOCKED row carries NO executor — this is the authoritative value
      // the final authorization decision uses (§5.3: reject settlement).
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED, { initiatedById: null })]);

    const result = await service.apply({ attemptId: 'attempt-1', source: 'API_VERIFY', verification: successVerification });
    expect(result.outcome).toBe('INTERNAL_STATE_MISMATCH');
    const metadata = expectBlockedByInvalidCycle(tx);
    expect(metadata.executorId).toBeNull(); // the LOCKED (missing) identity was used
    expect(String(metadata.invalidReason)).toContain('executor');
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
  });

  it('v1.0.10 §5.6: an executor that COLLIDES with the first approver (authoritative row) invalidates authorization', async () => {
    const { tx, ledger, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED, { initiatedById: 'a1' })]);

    const result = await service.apply({ attemptId: 'attempt-1', source: 'API_VERIFY', verification: successVerification });
    expect(result.outcome).toBe('INTERNAL_STATE_MISMATCH');
    const metadata = expectBlockedByInvalidCycle(tx);
    expect(metadata.executorId).toBe('a1');
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
  });

  it('v1.0.10 §5.6: ALL four-identity collisions are rejected (executor = requester / first / second approver)', async () => {
    for (const executor of ['req-1', 'a1', 'a2'] as const) {
      const { tx, ledger, service, lockedWithdrawal, lockedAttempt } = makeShell();
      tx.$queryRaw
        .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
        .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED, { initiatedById: executor })]);
      const result = await service.apply({ attemptId: 'attempt-1', source: 'API_VERIFY', verification: successVerification });
      expect(result.outcome).toBe('INTERNAL_STATE_MISMATCH');
      expect(ledger.postWithdrawal).not.toHaveBeenCalled();
    }
  });

  it('v1.0.10 §5.6: a VALID locked executor (the fourth person) settles — the audit event records the LOCKED executor identity', async () => {
    const { tx, ledger, service, lockedWithdrawal, lockedAttempt } = makeShell();
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED, { initiatedById: 'exec-1' })]);
    tx.withdrawal.findUniqueOrThrow.mockResolvedValue({ id: 'wd-1', publicRef: 'WDR-1', campaignId: 'c1', currency: 'NGN', amount: 1_000_000n, feeAmount: 0n, netAmount: 1_000_000n });

    const result = await service.apply({ attemptId: 'attempt-1', source: 'API_VERIFY', verification: successVerification });
    expect(result.outcome).toBe('PROVIDER_SUCCESS_INTERNAL_PENDING');
    expect(ledger.postWithdrawal).toHaveBeenCalledTimes(1);
    const settledCall = tx.auditLog.create.mock.calls.map((c: unknown[]) => c[0]).find((d: { data?: { action?: string } }) => d?.data?.action === 'PAYOUT_SETTLED_PROVIDER_VERIFIED');
    expect((settledCall as { data: { metadata: Record<string, unknown> } }).data.metadata.executorId).toBe('exec-1');
  });

  it('v1.0.10 §5.5: a pre-transaction attempt row that DIVERGED from the locked row aborts reconciliation before anything is applied', async () => {
    const { db, tx, ledger, manualReview, service, attempt, lockedWithdrawal, lockedAttempt } = makeShell();
    // The caller loaded a DIFFERENT attempt state before the transaction
    // (e.g. a stale worker payload): the locked row is the source of truth
    // and the divergence is a hard abort.
    db.payoutAttempt.findUnique.mockResolvedValue({ ...attempt, provider: 'FLUTTERWAVE', idempotencyKey: 'payout:wd-1:9' } as never);
    tx.$queryRaw
      .mockResolvedValueOnce([lockedWithdrawal(WithdrawalStatus.PROCESSING)])
      .mockResolvedValueOnce([lockedAttempt(PayoutAttemptStatus.PROVIDER_ACCEPTED)]);

    await expect(service.apply({ attemptId: 'attempt-1', source: 'API_VERIFY', verification: successVerification })).rejects.toThrow(/changed concurrently/);
    expect(ledger.postWithdrawal).not.toHaveBeenCalled();
    expect(tx.payoutReconciliation.create).not.toHaveBeenCalled();
    expect((manualReview.openCase as jest.Mock).mock.calls.length).toBe(0);
  });
});
