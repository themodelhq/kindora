import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { PrismaService } from '../common/prisma.service';
import { PayoutEvidenceService } from '../payouts/payout-evidence.service';
import { LedgerService } from '../ledger/ledger.service';
import { PayoutService } from '../payouts/payout.service';

/**
 * Dual-approval separation-of-duties + evidence-validation unit tests
 * (v1.0.4 §6 / §10). No database: PrismaService, LedgerService and
 * PayoutService are jest shells; the SEPARATION LOGIC under test is real.
 *
 * §13.3 requires reproducing the v1.0.3 loophole explicitly:
 *   Administrator A moves the withdrawal to UNDER_REVIEW, then submits the
 *   SECOND approval — v1.0.3 accepted this (same admin as both approvers).
 *   v1.0.4 MUST reject it regardless of state.
 */

const ADMIN_A = { id: 'admin-a', role: 'ADMIN' };
const ADMIN_B = { id: 'admin-b', role: 'ADMIN' };
const ADMIN_C = { id: 'admin-c', role: 'ADMIN' };
const ORGANIZER = { id: 'org-1', role: 'USER' };

const AMOUNT = 1_000_000n;
const CURRENCY = 'NGN';

type Db = {
  withdrawal: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  withdrawalApproval: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock; updateMany: jest.Mock };
  storedFile: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; create: jest.Mock };
  auditLog: { create: jest.Mock };
  organizationMember: { count: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
  payoutAttempt: { findFirst: jest.Mock; findUnique: jest.Mock; count: jest.Mock; findMany: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: unknown;
};

function makeDb(): Db {
  const db: Db = {
    withdrawal: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
    withdrawalApproval: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'approval-new' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    storedFile: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    organizationMember: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    campaign: { findUnique: jest.fn() },
    payoutAttempt: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn(), count: jest.fn().mockResolvedValue(0), findMany: jest.fn() },
    $transaction: null as unknown as jest.Mock,
    $queryRaw: null as unknown as jest.Mock,
  };
  // Execute interactive transactions against the same shell so assertions see
  // writes performed inside $transaction callbacks.
  db.$transaction = jest.fn(async (input: unknown) => (typeof input === 'function' ? input(db) : Promise.resolve([])));
  // v1.0.7 §10: approve()/secondApproval() read the authoritative withdrawal
  // (and the first approval) through FOR UPDATE SELECTs. The shell resolves
  // those against the same in-memory rows the tests seed.
  db.$queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const sql = strings.join('?');
    const id = String(values[0] ?? '');
    if (sql.includes('FROM "Withdrawal" WHERE')) {
      return Promise.resolve(db.withdrawal.findUnique({ where: { id } }).then((row: unknown) => (row ? [row] : [])));
    }
    if (sql.includes('FROM "WithdrawalApproval"')) {
      return Promise.resolve(db.withdrawalApproval.findFirst({ where: { role: 'FIRST_APPROVER' } }).then((row: unknown) => (row ? [row] : [])));
    }
    return Promise.resolve([]);
  };
  return db;
}

function makeService(db: Db, configMap: Record<string, string> = {}) {
  const config = { get: jest.fn((key: string) => configMap[key]) } as unknown as ConfigService;
  const payouts = {
    settleManual: jest.fn().mockResolvedValue({ attempt: { id: 'attempt-1' }, withdrawal: { id: 'wd-1', status: 'PAID' } }),
    retry: jest.fn().mockResolvedValue({ id: 'attempt-2' }),
    verifyAttempt: jest.fn().mockResolvedValue({ applied: true }),
    reconcileWithdrawal: jest.fn().mockResolvedValue({ result: 'MATCHED' }),
  } as unknown as PayoutService;
  const ledger = { campaignAvailableBalance: jest.fn().mockResolvedValue(5_000_000n) } as unknown as LedgerService;
  const beneficiaries = {
    destinationHash: jest.fn().mockReturnValue('sha256:dest'),
    invalidateOnDestinationChange: jest.fn().mockResolvedValue(2),
  } as unknown as object;
  const manualReview = {
    assertAdmin: jest.fn(),
    list: jest.fn().mockResolvedValue([0, []]),
    getCase: jest.fn().mockResolvedValue(null),
    resolveCase: jest.fn().mockResolvedValue({ id: 'case-1', status: 'RESOLVED' }),
  } as unknown as object;
  // v1.0.8 — the REAL evidence validator runs against the db shell, so the
  // canonical §3.5 checks (and their exact messages) are under test.
  const payoutEvidence = new PayoutEvidenceService(db as unknown as PrismaService);
  const service = new WithdrawalsService(db as unknown as PrismaService, ledger, config, payouts, beneficiaries as never, manualReview as never, payoutEvidence);
  return { service, payouts, config };
}

/** A withdrawal in the given status with the given reviewer identity. */
function withdrawal(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'wd-1',
    publicRef: `WDR-TEST`,
    campaignId: 'camp-1',
    requestedById: ORGANIZER.id,
    amount: AMOUNT,
    feeAmount: 0n,
    netAmount: AMOUNT,
    currency: CURRENCY,
    status,
    approvalCycle: 1,
    destinationVersion: 1,
    reviewedById: null as string | null,
    secondApprovedById: null as string | null,
    destination: { accountNumber: '0123456789' },
    ...extra,
  };
}

describe('first approval separation (§6.3)', () => {
  it('the requester can never approve their own payout', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('PENDING'));
    await expect(service.approve('wd-1', ORGANIZER)).rejects.toThrow(ForbiddenException);
    expect(db.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it('a distinct administrator approves and an immutable approval row is created bound to amount+currency', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    const w = withdrawal('UNDER_REVIEW', { reviewedById: ADMIN_A.id });
    db.withdrawal.findUnique.mockResolvedValue(w);
    db.withdrawalApproval.create.mockResolvedValue({ id: 'appr-1' });

    await service.approve('wd-1', ADMIN_A);

    expect(db.withdrawalApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        withdrawalId: 'wd-1',
        role: 'FIRST_APPROVER',
        approverId: ADMIN_A.id,
        amountAtApproval: AMOUNT,
        currencyAtApproval: CURRENCY,
        status: 'ACTIVE',
        cycle: 1,
      }),
    });
  });
});

describe('second approval: the v1.0.3 UNDER_REVIEW loophole is REMOVED (§6.4)', () => {
  it('admin A reviews (UNDER_REVIEW), A attempts the second approval -> REJECTED', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    // A is the first approver (reviewedById) and the withdrawal is STILL in
    // UNDER_REVIEW — exactly the v1.0.3 exception scenario.
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('UNDER_REVIEW', { reviewedById: ADMIN_A.id }));
    await expect(service.secondApproval('wd-1', ADMIN_A, 'loophole attempt')).rejects.toThrow(
      /first approver cannot also be the second approver/,
    );
    expect(db.withdrawalApproval.create).not.toHaveBeenCalled();
  });

  it('admin A first-approves (APPROVED), A attempts second approval -> REJECTED', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id }));
    await expect(service.secondApproval('wd-1', ADMIN_A)).rejects.toThrow(/first approver cannot also be the second approver/);
  });

  it('the requester cannot be the second approver either', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id }));
    await expect(service.secondApproval('wd-1', ORGANIZER)).rejects.toThrow(/requester cannot be the second approver/);
  });

  it('second approval requires an ACTIVE first approval in the CURRENT cycle', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED'));
    db.withdrawalApproval.findFirst.mockResolvedValue(null); // no active first approval
    await expect(service.secondApproval('wd-1', ADMIN_B)).rejects.toThrow(/No active first approval/);
  });

  it('A approves, B second-approves -> succeeds with an immutable SECOND_APPROVER row', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id }));
    db.withdrawalApproval.findFirst.mockResolvedValue({
      id: 'first-1',
      role: 'FIRST_APPROVER',
      approverId: ADMIN_A.id,
      amountAtApproval: AMOUNT,
      currencyAtApproval: CURRENCY,
      destinationVersionAtApproval: 1,
    });

    await service.secondApproval('wd-1', ADMIN_B, 'ok');

    expect(db.withdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ secondApprovedById: null }),
        data: expect.objectContaining({ secondApprovedById: ADMIN_B.id }),
      }),
    );
    expect(db.withdrawalApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'SECOND_APPROVER', approverId: ADMIN_B.id }),
    });
  });

  it('concurrent second approvals: the loser gets 409 (updateMany count=0)', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id }));
    db.withdrawalApproval.findFirst.mockResolvedValue({
      role: 'FIRST_APPROVER',
      approverId: ADMIN_A.id,
      amountAtApproval: AMOUNT,
      currencyAtApproval: CURRENCY,
      destinationVersionAtApproval: 1,
    });
    db.withdrawal.updateMany.mockResolvedValue({ count: 0 }); // another admin won the race
    await expect(service.secondApproval('wd-1', ADMIN_B)).rejects.toThrow(ConflictException);
  });

  it('an amount change after first approval invalidates the cycle and forces reapproval (§13.3 binding)', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    // Withdrawal amount was increased after A approved 1,000,000.
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id, amount: 2_000_000n }));
    db.withdrawalApproval.findFirst.mockResolvedValue({
      role: 'FIRST_APPROVER',
      approverId: ADMIN_A.id,
      amountAtApproval: AMOUNT,
      currencyAtApproval: CURRENCY,
      destinationVersionAtApproval: 1,
    });
    db.withdrawal.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.secondApproval('wd-1', ADMIN_B)).rejects.toThrow(ConflictException);
    // Both approvals of the old cycle are invalidated and the cycle advances.
    expect(db.withdrawalApproval.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cycle: 1, status: 'ACTIVE' }),
        data: expect.objectContaining({ status: 'INVALIDATED' }),
      }),
    );
    expect(db.withdrawal.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ approvalCycle: 2 }) }),
    );
  });
});

describe('settlement executor separation (§6.3)', () => {
  function approvalRows() {
    return [
      { role: 'FIRST_APPROVER', approverId: ADMIN_A.id, amountAtApproval: AMOUNT, currencyAtApproval: CURRENCY, status: 'ACTIVE' },
      { role: 'SECOND_APPROVER', approverId: ADMIN_B.id, amountAtApproval: AMOUNT, currencyAtApproval: CURRENCY, status: 'ACTIVE' },
    ];
  }

  function cleanEvidence(uploaderId: string) {
    return {
      id: 'file-1',
      uploaderId,
      status: 'APPROVED',
      scanVerdict: 'CLEAN',
      visibility: 'PRIVATE',
      kind: 'PAYOUT_EVIDENCE',
      evidenceForWithdrawalId: null,
      withdrawalId: null,
    };
  }

  function setupForSettlement(db: Db, executor: { id: string }) {
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id, secondApprovedById: ADMIN_B.id }));
    db.withdrawalApproval.findMany.mockResolvedValue(approvalRows());
    db.storedFile.findUnique.mockResolvedValue(cleanEvidence(executor.id));
  }

  it('A approves, B second-approves, B attempts settlement -> REJECTED (executor ≠ second approver)', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    setupForSettlement(db, ADMIN_B);
    await expect(
      service.confirmSettlement('wd-1', ADMIN_B, { payoutProvider: 'MANUAL_BANK', providerTransferRef: 'trf-1', evidenceFileId: 'file-1' }),
    ).rejects.toThrow(/second approver cannot execute/);
    expect(db.storedFile.update).not.toHaveBeenCalled();
  });

  it('A approves, B second-approves, A attempts settlement -> REJECTED (v1.0.7 §8.2: executor cannot be the first approver)', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    setupForSettlement(db, ADMIN_A);
    await expect(
      service.confirmSettlement('wd-1', ADMIN_A, { payoutProvider: 'MANUAL_BANK', providerTransferRef: 'trf-3', evidenceFileId: 'file-1' }),
    ).rejects.toThrow(/first approver cannot execute/);
    expect(db.storedFile.update).not.toHaveBeenCalled();
  });

  it('A approves, B second-approves, C executes -> succeeds and records an EXECUTOR approval row', async () => {
    const db = makeDb();
    const { service, payouts } = makeService(db);
    setupForSettlement(db, ADMIN_C);

    await service.confirmSettlement('wd-1', ADMIN_C, {
      payoutProvider: 'MANUAL_BANK',
      providerTransferRef: 'trf-2',
      evidenceFileId: 'file-1',
    });

    expect(payouts.settleManual).toHaveBeenCalledWith('wd-1', ADMIN_C, {
      payoutProvider: 'MANUAL_BANK',
      providerTransferRef: 'trf-2',
      payoutProviderTxnId: undefined,
      evidenceFileId: 'file-1',
      note: undefined,
    });
    expect(db.withdrawalApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ role: 'EXECUTOR', approverId: ADMIN_C.id }),
    });
  });

  it('settlement without both active approvals is refused (dual-approval mode ALL default)', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED', { reviewedById: ADMIN_A.id, secondApprovedById: null }));
    db.withdrawalApproval.findMany.mockResolvedValue([approvalRows()[0]]); // first only
    await expect(
      service.confirmSettlement('wd-1', ADMIN_C, { payoutProvider: 'MANUAL_BANK', providerTransferRef: 'trf-3', evidenceFileId: 'file-1' }),
    ).rejects.toThrow(/second administrator approval is required/);
  });

  it('first and second approver being the same person is refused even if rows exist', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('APPROVED'));
    db.withdrawalApproval.findMany.mockResolvedValue([
      { role: 'FIRST_APPROVER', approverId: ADMIN_A.id, amountAtApproval: AMOUNT, currencyAtApproval: CURRENCY, status: 'ACTIVE' },
      { role: 'SECOND_APPROVER', approverId: ADMIN_A.id, amountAtApproval: AMOUNT, currencyAtApproval: CURRENCY, status: 'ACTIVE' },
    ]);
    await expect(
      service.confirmSettlement('wd-1', ADMIN_C, { payoutProvider: 'MANUAL_BANK', providerTransferRef: 'trf-4', evidenceFileId: 'file-1' }),
    ).rejects.toThrow(/must be different administrators/);
  });

  it('the requester cannot execute the settlement', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    setupForSettlement(db, ORGANIZER);
    await expect(
      service.confirmSettlement('wd-1', ORGANIZER, { payoutProvider: 'MANUAL_BANK', providerTransferRef: 'trf-5', evidenceFileId: 'file-1' }),
    ).rejects.toThrow(/cannot settle/);
  });
});

describe('manual payout evidence validation (§10)', () => {
  function file(overrides: Record<string, unknown> = {}) {
    return {
      id: 'file-1',
      uploaderId: ADMIN_C.id,
      status: 'APPROVED',
      scanVerdict: 'CLEAN',
      visibility: 'PRIVATE',
      kind: 'PAYOUT_EVIDENCE',
      evidenceForWithdrawalId: null,
      withdrawalId: null,
      ...overrides,
    };
  }

  it.each([
    ['nonexistent file', null, /Evidence file not found/],
    ['uploaded by someone else', file({ uploaderId: ADMIN_A.id }), /uploaded by the submitting administrator/],
    ['quarantined', file({ status: 'QUARANTINED' }), /QUARANTINED/],
    ['rejected', file({ status: 'REJECTED' }), /REJECTED/],
    ['still scanning', file({ status: 'SCANNING', scanVerdict: 'PENDING' }), /scan has not completed/],
    ['infested', file({ scanVerdict: 'INFESTED' }), /did not pass the security scan/],
    ['public visibility', file({ visibility: 'PUBLIC' }), /stored privately/],
    ['wrong purpose kind', file({ kind: 'CAMPAIGN_IMAGE' }), /Wrong evidence purpose/],
    ['bound to another withdrawal', file({ evidenceForWithdrawalId: 'wd-other' }), /bound to a different withdrawal/],
  ])('rejects %s', async (_label, fileOrNull, match) => {
    const db = makeDb();
    const { service } = makeService(db);
    db.storedFile.findUnique.mockResolvedValue(fileOrNull);
    await expect(service.validateEvidenceFile('file-1', ADMIN_C, 'wd-1')).rejects.toThrow(match as RegExp);
  });

  it('accepts a clean private PAYOUT_EVIDENCE file uploaded by the acting admin', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.storedFile.findUnique.mockResolvedValue(file());
    await expect(service.validateEvidenceFile('file-1', ADMIN_C, 'wd-1')).resolves.toBeTruthy();
  });

  it('binding the evidence marks the file (unique constraint prevents cross-withdrawal reuse)', async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.withdrawal.findUnique.mockResolvedValue(withdrawal('PAID'));
    db.withdrawalApproval.findMany.mockResolvedValue([]);
    db.storedFile.findUnique.mockResolvedValue({
      id: 'file-1',
      uploaderId: ADMIN_C.id,
      status: 'APPROVED',
      scanVerdict: 'CLEAN',
      visibility: 'PRIVATE',
      kind: 'PAYOUT_EVIDENCE',
      evidenceForWithdrawalId: null,
      withdrawalId: null,
    });
    // reuse: update throws P2002 (file already bound elsewhere)
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique constraint', { code: 'P2002', clientVersion: '6.19.3' });
    db.storedFile.update.mockRejectedValue(p2002);
    await expect(service.reconcile('wd-1', ADMIN_C, 'file-1', 'attach')).rejects.toThrow(ConflictException);
    expect(db.storedFile.update).toHaveBeenCalledWith({
      where: { id: 'file-1' },
      data: expect.objectContaining({ evidenceForWithdrawalId: 'wd-1' }),
    });
  });
});

describe('legacy manipulation methods are gone', () => {
  it('the service no longer exposes markPaid / markProcessing / markFailed', () => {
    const service = makeService(makeDb()).service as unknown as Record<string, unknown>;
    expect(service['markPaid']).toBeUndefined();
    expect(service['markProcessing']).toBeUndefined();
    expect(service['markFailed']).toBeUndefined();
    // Settlement is the canonical replacement.
    expect(typeof service['confirmSettlement']).toBe('function');
    expect(typeof service['retryPayout']).toBe('function');
  });
});
