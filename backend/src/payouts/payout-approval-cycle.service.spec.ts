import { PayoutApprovalCycleService } from './payout-approval-cycle.service';

/**
 * v1.0.8 §12.2 — approval-cycle validation. Every invalid authorization
 * combination must produce a structured INVALID result with the exact reason;
 * the valid four-person cycle must pass.
 */

type Role = 'FIRST_APPROVER' | 'SECOND_APPROVER';

function approval(role: Role, approverId: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${role}-${approverId}`,
    cycle: 1,
    role,
    approverId,
    status: 'ACTIVE',
    amountAtApproval: 100_000n,
    currencyAtApproval: 'NGN',
    destinationVersionAtApproval: 1,
    snapshotHash: null as string | null,
    ...extra,
  };
}

function buildDb(overrides: {
  withdrawal?: Record<string, unknown>;
  approvals?: Array<Record<string, unknown> | null> | 'NONE';
  beneficiary?: Record<string, unknown> | null;
}) {
  const withdrawal = {
    id: 'wd-1',
    requestedById: 'requester',
    amount: 100_000n,
    currency: 'NGN',
    status: 'APPROVED',
    approvalCycle: 1,
    destinationVersion: 1,
    ...overrides.withdrawal,
  };
  const rawApprovals =
    overrides.approvals === 'NONE'
      ? []
      : (overrides.approvals ?? [approval('FIRST_APPROVER', 'alice'), approval('SECOND_APPROVER', 'bob')]);
  const approvals = (rawApprovals as Array<Record<string, unknown> | null>).filter(Boolean);
  const beneficiary = overrides.beneficiary === undefined ? { externalRef: 'rec_approved', status: 'ACTIVE' } : overrides.beneficiary;
  const db = {
    withdrawal: {
      findUnique: jest.fn().mockResolvedValue(withdrawal),
    },
    withdrawalApproval: {
      // Honor the where clause like Prisma would (status + cycle filtering).
      findMany: jest.fn().mockImplementation((args: { where?: { status?: string; cycle?: number } }) =>
        approvals.filter(
          (a) => a != null && (!args?.where?.status || (a as Record<string, unknown>).status === args.where.status) && (args?.where?.cycle == null || (a as Record<string, unknown>).cycle === args.where.cycle),
        ),
      ),
    },
    payoutBeneficiary: {
      findUnique: jest.fn().mockResolvedValue(beneficiary),
    },
  };
  return db;
}

const service = new PayoutApprovalCycleService({} as never);

function validate(db: ReturnType<typeof buildDb>, opts: Record<string, unknown> = {}) {
  return service.validate(db as never, 'wd-1', opts as never);
}

describe('validatePayoutApprovalCycle (v1.0.8 §4/§12.2)', () => {
  it('passes for a complete, distinct, four-person cycle', async () => {
    const result = await validate(buildDb({}), { executorId: 'executor' });
    expect(result.valid).toBe(true);
    expect(result.invalidReason).toBeNull();
    expect(result.approvalCycleId).toBe('wd-1#cycle1');
    expect(result.approvedAmountMinor).toBe(100_000n);
    expect(result.approvedCurrency).toBe('NGN');
    expect(result.approvedDestinationVersion).toBe(1);
    expect(result.firstApproverId).toBe('alice');
    expect(result.secondApproverId).toBe('bob');
  });

  it('FAILS: missing first approval', async () => {
    const result = await validate(buildDb({ approvals: [null, approval('SECOND_APPROVER', 'bob')] }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/no ACTIVE first approval/);
  });

  it('FAILS: missing second approval', async () => {
    const result = await validate(buildDb({ approvals: [approval('FIRST_APPROVER', 'alice'), null] }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/no ACTIVE second approval/);
  });

  it('FAILS: approvals from a stale cycle are not loaded', async () => {
    // Only cycle-2 rows exist: the service queries the CURRENT cycle (1) and
    // must not fall back to any stale/other-cycle approval.
    const db = buildDb({
      approvals: [approval('FIRST_APPROVER', 'alice', { cycle: 2 }), approval('SECOND_APPROVER', 'bob', { cycle: 2 })],
    });
    const result = await validate(db);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/no ACTIVE first approval/);
  });

  it('FAILS: invalidated approval status', async () => {
    // The INVALIDATED first approval is filtered out by the ACTIVE-only query.
    const result = await validate(
      buildDb({ approvals: [approval('FIRST_APPROVER', 'alice', { status: 'INVALIDATED' }), approval('SECOND_APPROVER', 'bob')] }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/no ACTIVE first approval/);
  });

  it('FAILS: first approver equals second approver', async () => {
    const result = await validate(buildDb({ approvals: [approval('FIRST_APPROVER', 'alice'), approval('SECOND_APPROVER', 'alice')] }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/must be distinct/);
  });

  it('FAILS: requester equals first approver', async () => {
    const result = await validate(buildDb({ approvals: [approval('FIRST_APPROVER', 'requester'), approval('SECOND_APPROVER', 'bob')] }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/requester cannot be the first approver/);
  });

  it('FAILS: requester equals second approver', async () => {
    const result = await validate(buildDb({ approvals: [approval('FIRST_APPROVER', 'alice'), approval('SECOND_APPROVER', 'requester')] }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/requester cannot be the second approver/);
  });

  it.each([
    ['executor equals requester', 'requester', /executor cannot be the withdrawal requester/],
    ['executor equals first approver', 'alice', /executor cannot be the first approver/],
    ['executor equals second approver', 'bob', /executor cannot be the second approver/],
  ])('FAILS: %s', async (_label, executorId, reason) => {
    const result = await validate(buildDb({}), { executorId });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(reason as RegExp);
  });

  it('FAILS: changed amount', async () => {
    const result = await validate(buildDb({ withdrawal: { amount: 200_000n } }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/no longer matches/);
  });

  it('FAILS: changed currency', async () => {
    const result = await validate(buildDb({ withdrawal: { currency: 'GHS' } }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/no longer matches/);
  });

  it('FAILS: changed destination version', async () => {
    const result = await validate(buildDb({ withdrawal: { destinationVersion: 2 } }));
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/destination version/);
  });

  it('FAILS: approval not bound to a destination version (null binding)', async () => {
    const result = await validate(
      buildDb({ approvals: [approval('FIRST_APPROVER', 'alice', { destinationVersionAtApproval: null }), approval('SECOND_APPROVER', 'bob')] }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/destination version/);
  });

  it('FAILS: changed provider against the bound snapshot hash', async () => {
    const db = buildDb({
      approvals: [
        approval('FIRST_APPROVER', 'alice', { snapshotHash: 'deadbeef' }),
        approval('SECOND_APPROVER', 'bob', { snapshotHash: 'deadbeef' }),
      ],
    });
    const result = await validate(db as never, { provider: 'PAYSTACK', beneficiaryId: 'ben-1' });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/snapshot hash/);
  });

  it('FAILS: beneficiary identity does not match the approved destination', async () => {
    const result = await validate(buildDb({}), { provider: 'PAYSTACK', beneficiaryExternalRef: 'rec_attacker' });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/beneficiary identity/);
  });

  it('FAILS: beneficiary row invalidated for the current destination version', async () => {
    const result = await validate(buildDb({ beneficiary: { externalRef: 'rec_approved', status: 'INVALIDATED' } }), {
      provider: 'PAYSTACK',
      beneficiaryExternalRef: 'rec_approved',
    });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/beneficiary identity/);
  });

  it('FAILS: invalid approval snapshot hash (hashes differ between approvers)', async () => {
    const result = await validate(
      buildDb({
        approvals: [approval('FIRST_APPROVER', 'alice', { snapshotHash: 'aaa' }), approval('SECOND_APPROVER', 'bob', { snapshotHash: 'bbb' })],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/differ/);
  });

  it('FAILS: snapshot hashes required (provider payout path) but absent', async () => {
    const result = await validate(buildDb({}), { requireBoundSnapshot: true });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/not bound on both approvals/);
  });

  it('FAILS: withdrawal not in an allowed status', async () => {
    const result = await validate(buildDb({ withdrawal: { status: 'PAID' } }), { allowedStatuses: ['APPROVED'] });
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/not valid for this operation/);
  });

  it('FAILS: withdrawal not found', async () => {
    const db = buildDb({});
    (db.withdrawal.findUnique as jest.Mock).mockResolvedValue(null);
    const result = await validate(db as never);
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toMatch(/not found/);
  });

  it('passes with a matching snapshot hash when provider + beneficiary are supplied', async () => {
    const db = buildDb({
      approvals: [
        approval('FIRST_APPROVER', 'alice', { snapshotHash: 'valid-hash' }),
        approval('SECOND_APPROVER', 'bob', { snapshotHash: 'valid-hash' }),
      ],
    });
    // Recompute the expected hash and inject it into the fake rows.
    const expected = service.snapshotHash({
      withdrawalId: 'wd-1',
      amountMinor: 100_000n,
      currency: 'NGN',
      destinationVersion: 1,
      provider: 'PAYSTACK',
      beneficiaryId: 'ben-1',
      requesterId: 'requester',
      firstApproverId: 'alice',
      secondApproverId: 'bob',
      cycle: 1,
    });
    (db.withdrawalApproval.findMany as jest.Mock).mockResolvedValue([
      approval('FIRST_APPROVER', 'alice', { snapshotHash: expected }),
      approval('SECOND_APPROVER', 'bob', { snapshotHash: expected }),
    ]);
    const result = await validate(db as never, { provider: 'PAYSTACK', beneficiaryId: 'ben-1', beneficiaryExternalRef: 'rec_approved' });
    expect(result.valid).toBe(true);
  });
});
