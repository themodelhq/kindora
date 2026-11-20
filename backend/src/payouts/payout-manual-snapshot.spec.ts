import { PayoutApprovalCycleService } from './payout-approval-cycle.service';
import { safeEqualHex } from './payout-provider.adapter';

/**
 * v1.0.9 §5/§12.4 — immutable manual approval snapshot matrix.
 *
 * Manual settlement REQUIRES the bound snapshot: missing hashes, hash
 * mismatches, changed amounts/currency/beneficiary/destination-version,
 * channel mismatches and legacy withdrawals all BLOCK settlement. Hash
 * comparison is constant-time. Every invalid case fails closed.
 */

const CHANNEL = 'MANUAL_BANK_TRANSFER';

function withdrawalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wd-1',
    requestedById: 'req-1',
    status: 'APPROVED',
    approvalCycle: 1,
    amount: 1_000_000n,
    currency: 'NGN',
    destinationVersion: 1,
    destination: { accountNumber: '0123456789', bankCode: '058', accountName: 'Test Beneficiary' },
    ...overrides,
  };
}

function approvalRow(role: 'FIRST_APPROVER' | 'SECOND_APPROVER', approverId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `appr-${role}`,
    role,
    approverId,
    cycle: 1,
    status: 'ACTIVE',
    amountAtApproval: 1_000_000n,
    currencyAtApproval: 'NGN',
    destinationVersionAtApproval: 1,
    snapshotHash: null as string | null,
    approvedAt: new Date('2026-11-14T10:00:00.000Z'),
    ...overrides,
  };
}

const DESTINATION_REF = 'sha256:desthash';

/** Fresh approval fixtures per test — snapshot binding mutates the rows. */
function freshApprovals() {
  return [approvalRow('FIRST_APPROVER', 'admin-a'), approvalRow('SECOND_APPROVER', 'admin-b')];
}

function bindHashes(service: PayoutApprovalCycleService, withdrawal: ReturnType<typeof withdrawalRow>, approvals: ReturnType<typeof approvalRow>[], channel: string = CHANNEL) {
  const { expected } = service.buildManualSnapshot(withdrawal, approvals, channel, DESTINATION_REF);
  approvals.forEach((a) => {
    a.snapshotHash = expected;
  });
  return expected;
}

function makeClient(withdrawal: ReturnType<typeof withdrawalRow>, approvals: ReturnType<typeof approvalRow>[]) {
  return {
    withdrawal: { findUnique: jest.fn().mockResolvedValue(withdrawal) },
    withdrawalApproval: {
      findMany: jest.fn().mockImplementation((args: { where?: { status?: string; cycle?: number } }) =>
        approvals.filter((a) => (!args?.where?.status || a.status === args.where.status) && (!args?.where?.cycle || a.cycle === args.where.cycle)),
      ),
    },
  } as never;
}

describe('manual settlement approval snapshot (v1.0.9 §5.1/§12.4)', () => {
  const service = new PayoutApprovalCycleService({} as never);
  const baseWithdrawal = withdrawalRow();
  let baseApprovals: ReturnType<typeof freshApprovals>;

  beforeEach(() => {
    baseApprovals = freshApprovals();
  });

  it('a bound snapshot that recomputes exactly validates (happy path)', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireExecutor: true,
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(true);
    expect(result.approvalSnapshotHash).toBeTruthy();
  });

  it('missing snapshot hashes on a legacy withdrawal NEVER pass (no grandfathering, §5.2)', async () => {
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('not bound on both approvals');
  });

  it('a snapshot bound for a DIFFERENT channel blocks settlement (channel mismatch)', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals, 'MANUAL_BANK_TRANSFER');
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: 'CASH',
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('does not match the current manual settlement details');
  });

  it('a tampered FIRST approval hash blocks settlement', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    baseApprovals[0].snapshotHash = '0'.repeat(64);
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('differ between the two approvals');
  });

  it('a tampered SECOND approval hash blocks settlement', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    baseApprovals[1].snapshotHash = 'f'.repeat(64);
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('differ between the two approvals');
  });

  it('both approvals bound to a STALE hash (approved amount since changed) block settlement', async () => {
    // Bind against 900000 then present a withdrawal at 1000000.
    const staleWithdrawal = withdrawalRow({ amount: 900_000n });
    const staleApprovals = [approvalRow('FIRST_APPROVER', 'admin-a', { amountAtApproval: 900_000n }), approvalRow('SECOND_APPROVER', 'admin-b', { amountAtApproval: 900_000n })];
    bindHashes(service, staleWithdrawal, staleApprovals);
    const result = await service.validate(makeClient(baseWithdrawal, staleApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    // The stale amount binding itself is caught by the amount check.
    expect(result.invalidReason).toMatch(/stale|does not match/);
  });

  it('an amount change after approval blocks settlement (binding + snapshot recompute)', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const changed = withdrawalRow({ amount: 2_000_000n });
    const result = await service.validate(makeClient(changed, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
  });

  it('a currency change after approval blocks settlement', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const changed = withdrawalRow({ currency: 'GHS' });
    const result = await service.validate(makeClient(changed, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
  });

  it('a beneficiary/destination change blocks settlement (destinationRef recompute mismatch)', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: 'sha256:changed-destination',
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('does not match the current manual settlement details');
  });

  it('a destination version change blocks settlement', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const changed = withdrawalRow({ destinationVersion: 2 });
    const result = await service.validate(makeClient(changed, baseApprovals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
  });

  it('a missing persisted executor blocks the cycle validation (requireExecutor, §4)', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: null,
      requireExecutor: true,
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('executor identity is missing');
  });

  it('an executor colliding with the first approver blocks the cycle (§4.3)', async () => {
    bindHashes(service, baseWithdrawal, baseApprovals);
    const result = await service.validate(makeClient(baseWithdrawal, baseApprovals), 'wd-1', {
      executorId: 'admin-a',
      requireExecutor: true,
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('executor cannot be the first approver');
  });

  it('a provider-path snapshot never satisfies the manual snapshot check (no cross-path reuse)', async () => {
    const providerService = new PayoutApprovalCycleService({} as never);
    const providerHash = providerService.snapshotHash({
      withdrawalId: 'wd-1',
      amountMinor: 1_000_000n,
      currency: 'NGN',
      destinationVersion: 1,
      provider: 'PAYSTACK',
      beneficiaryId: 'bene-1',
      requesterId: 'req-1',
      firstApproverId: 'admin-a',
      secondApproverId: 'admin-b',
      cycle: 1,
    });
    const approvals = [
      approvalRow('FIRST_APPROVER', 'admin-a', { snapshotHash: providerHash }),
      approvalRow('SECOND_APPROVER', 'admin-b', { snapshotHash: providerHash }),
    ];
    const result = await service.validate(makeClient(baseWithdrawal, approvals), 'wd-1', {
      executorId: 'admin-exec',
      requireBoundSnapshot: true,
      settlementChannel: CHANNEL,
      manualDestinationRef: DESTINATION_REF,
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toContain('does not match the current manual settlement details');
  });
});

describe('safeEqualHex — constant-time hash comparison (v1.0.9 §5.1)', () => {
  it('matches identical digests and rejects different ones', () => {
    const a = 'a'.repeat(64);
    expect(safeEqualHex(a, a)).toBe(true);
    expect(safeEqualHex(a, 'b'.repeat(64))).toBe(false);
  });
  it('rejects malformed or missing inputs (never throws)', () => {
    expect(safeEqualHex(null, 'a'.repeat(64))).toBe(false);
    expect(safeEqualHex(undefined, undefined)).toBe(false);
    expect(safeEqualHex('short', 'longer-string')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});
