import { Donation, DonationStatus, PaymentProvider } from '@prisma/client';
import { DonationPaymentService } from './donation-payment.service';
import { LedgerService } from '../ledger/ledger.service';
import { QueueService } from '../common/queue.service';
import { PrismaService } from '../common/prisma.service';

/**
 * Unit tests for the idempotent donation state machine.
 * PrismaService is a jest.fn() shell; the $transaction mock invokes the
 * interactive callback with a shared tx-client mock so the exactly-once
 * guarantee (conditional UPDATE as the first write) is exercised directly.
 */

type TxMock = {
  donation: { updateMany: jest.Mock; update: jest.Mock };
  campaign: { update: jest.Mock };
  matchingPool: { findFirst: jest.Mock; update: jest.Mock };
};

type PrismaMock = PrismaService & {
  donation: { findUnique: jest.Mock; findFirst: jest.Mock; updateMany: jest.Mock };
  campaign: { findUnique: jest.Mock };
  notification: { createMany: jest.Mock };
};

type LedgerMock = LedgerService & { postDonationSuccess: jest.Mock; postMatch: jest.Mock };
type QueueMock = QueueService & { enqueue: jest.Mock };

const DONATION_BASE = {
  id: 'd1',
  publicRef: 'KDO-TEST0001',
  campaignId: 'c1',
  currency: 'NGN',
  amount: 1000000n,
  tipAmount: 100000n,
  matchedAmount: 0n,
  status: DonationStatus.PENDING,
  provider: PaymentProvider.MOCK,
  providerReference: null,
  receiptNumber: null,
  donorUserId: 'u1',
  guestEmail: null,
  matchingPoolId: null,
  campaign: { id: 'c1', status: 'ACTIVE', targetAmount: 100000000n },
};

function makeDonation(overrides: Record<string, unknown> = {}) {
  return { ...DONATION_BASE, ...overrides } as unknown as Donation & {
    campaign: { id: string; status: string; targetAmount: bigint };
  };
}

function makeService() {
  const tx: TxMock = {
    donation: { updateMany: jest.fn(), update: jest.fn() },
    campaign: { update: jest.fn() },
    matchingPool: { findFirst: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    donation: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    campaign: { findUnique: jest.fn() },
    notification: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((fn: (client: TxMock) => unknown) => fn(tx)),
  } as unknown as PrismaMock;
  const ledger = {
    postDonationSuccess: jest.fn().mockResolvedValue({ id: 'txn-1' }),
    postMatch: jest.fn().mockResolvedValue({ id: 'txn-2' }),
  } as unknown as LedgerMock;
  const queue = { enqueue: jest.fn().mockResolvedValue(null) } as unknown as QueueMock;
  const service = new DonationPaymentService(prisma, ledger, queue);
  return { service, tx, prisma, ledger, queue };
}

describe('DonationPaymentService.applySuccess', () => {
  const params = { publicRef: 'KDO-TEST0001', provider: PaymentProvider.MOCK, providerReference: 'mock_KDO-TEST0001' };

  function setupSuccessDonation(donationOverrides: Record<string, unknown> = {}) {
    const ctx = makeService();
    ctx.prisma.donation.findFirst.mockResolvedValue(makeDonation(donationOverrides));
    ctx.tx.donation.updateMany.mockResolvedValue({ count: 1 });
    ctx.tx.campaign.update.mockResolvedValue({});
    ctx.tx.donation.update.mockResolvedValue({});
    ctx.tx.matchingPool.findFirst.mockResolvedValue(null);
    ctx.prisma.campaign.findUnique.mockResolvedValue({
      id: 'c1',
      title: 'Test campaign',
      createdById: 'u2',
      slug: 'test-campaign',
      currency: 'NGN',
      targetAmount: 100000000n,
    });
    return ctx;
  }

  it('treats updateMany count 0 as a duplicate and performs NO ledger or campaign writes', async () => {
    const { service, tx, prisma, ledger, queue } = makeService();
    prisma.donation.findFirst.mockResolvedValue(makeDonation());
    tx.donation.updateMany.mockResolvedValue({ count: 0 }); // a racing caller already applied the outcome

    const result = await service.applySuccess(params);

    expect(result).toEqual({ donation: null, duplicate: true });
    // The race-winning conditional update was attempted with the right guard...
    expect(tx.donation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1', status: DonationStatus.PENDING },
        data: expect.objectContaining({ status: DonationStatus.SUCCEEDED }),
      }),
    );
    // ...but the money path never ran.
    expect(ledger.postDonationSuccess).not.toHaveBeenCalled();
    expect(tx.campaign.update).not.toHaveBeenCalled();
    expect(tx.matchingPool.findFirst).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('rejects a cross-provider completion: provider X can never succeed provider Y\'s donation', async () => {
    const { service, prisma, ledger } = makeService();
    // findFirst with the caller's provider finds nothing; findUnique reveals
    // the donation exists but belongs to another provider.
    prisma.donation.findFirst.mockResolvedValue(null);
    prisma.donation.findUnique.mockResolvedValue(makeDonation({ provider: PaymentProvider.PAYSTACK }));

    const result = await service.applySuccess({ publicRef: 'KDO-TEST0001', provider: PaymentProvider.FLUTTERWAVE });

    expect(result).toEqual({ donation: null, duplicate: true });
    expect(ledger.postDonationSuccess).not.toHaveBeenCalled();
  });

  it('guards the transition on status=PENDING so webhook and status-poll racing cannot double-apply', async () => {
    const { service, tx } = setupSuccessDonation();
    await service.applySuccess(params);
    expect(tx.donation.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.donation.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: DonationStatus.PENDING },
      data: expect.objectContaining({
        status: DonationStatus.SUCCEEDED,
        totalCharged: 1100000n, // amount + tip
        providerReference: 'mock_KDO-TEST0001',
        receiptNumber: expect.stringMatching(/^RCP-/),
      }),
    });
  });

  it('on count 1 posts the ledger exactly once and increments the campaign by amount (+match)', async () => {
    const { service, tx, ledger, queue, prisma } = setupSuccessDonation();

    const result = await service.applySuccess(params);

    expect(result.duplicate).toBe(false);
    expect(result.donation).not.toBeNull();
    expect(ledger.postDonationSuccess).toHaveBeenCalledTimes(1);
    expect(ledger.postDonationSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        donationId: 'd1',
        publicRef: 'KDO-TEST0001',
        campaignId: 'c1',
        currency: 'NGN',
        amount: 1000000n,
        tipAmount: 100000n,
        totalCharged: 1100000n,
        providerName: PaymentProvider.MOCK,
      }),
      expect.anything(),
    );
    expect(tx.campaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({
        raisedAmount: { increment: 1000000n }, // amount + matched (no pool -> matched = 0; tips never inflate the campaign)
        donorCount: { increment: 1 },
      }),
    });
    // Post-commit side effects.
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith('email', 'email.donation-organizer', { donationId: 'd1' });
  });

  it('marks the campaign COMPLETED when the donation reaches the target', async () => {
    const { service, tx } = setupSuccessDonation({
      amount: 100000000n,
      tipAmount: 0n,
      campaign: { id: 'c1', status: 'ACTIVE', targetAmount: 100000000n },
    });

    await service.applySuccess(params);

    expect(tx.campaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({
        raisedAmount: { increment: 100000000n },
        status: 'COMPLETED',
        completedAt: expect.any(Date),
      }),
    });
  });
});

describe('DonationPaymentService matching', () => {
  const params = { publicRef: 'KDO-TEST0001', provider: PaymentProvider.MOCK };

  function setupWithPool(pool: Record<string, unknown> | null) {
    const ctx = makeService();
    ctx.prisma.donation.findFirst.mockResolvedValue(makeDonation({ amount: 1000000n, tipAmount: 0n }));
    ctx.prisma.campaign.findUnique.mockResolvedValue({
      id: 'c1',
      title: 'T',
      createdById: 'u2',
      slug: 's',
      currency: 'NGN',
      targetAmount: 100000000n,
    });
    ctx.tx.donation.updateMany.mockResolvedValue({ count: 1 });
    ctx.tx.campaign.update.mockResolvedValue({});
    ctx.tx.donation.update.mockResolvedValue({});
    ctx.tx.matchingPool.findFirst.mockResolvedValue(pool);
    ctx.tx.matchingPool.update.mockResolvedValue({});
    return ctx;
  }

  it('caps the match at the remaining pool funds (500000) and marks the pool EXHAUSTED', async () => {
    // remaining = 1_000_000 - 500_000 = 500_000; ratioShare = 1_000_000 (ratio 100)
    const { service, tx, ledger } = setupWithPool({
      id: 'pool-1',
      totalCommitted: 1000000n,
      matchedAmount: 500000n,
      matchRatio: 100,
      status: 'ACTIVE',
    });

    const result = await service.applySuccess(params);

    expect(result.duplicate).toBe(false);
    // matched = min(ratioShare, remaining) = 500000
    expect(tx.matchingPool.update).toHaveBeenCalledWith({
      where: { id: 'pool-1' },
      data: { matchedAmount: { increment: 500000n }, status: 'EXHAUSTED' },
    });
    expect(tx.donation.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { matchedAmount: 500000n, matchingPoolId: 'pool-1' },
    });
    expect(ledger.postMatch).toHaveBeenCalledWith(
      expect.objectContaining({ poolId: 'pool-1', donationId: 'd1', matchedAmount: 500000n, currency: 'NGN' }),
      expect.anything(),
    );
    // Campaign grows by amount + matched = 1_500_000.
    expect(tx.campaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ raisedAmount: { increment: 1500000n } }),
    });
  });

  it('respects capPerDonation when the ratio share exceeds the cap', async () => {
    const { service, tx, ledger } = setupWithPool({
      id: 'pool-2',
      totalCommitted: 10000000n,
      matchedAmount: 0n,
      matchRatio: 100,
      capPerDonation: 100000n,
      status: 'ACTIVE',
    });

    await service.applySuccess(params);

    expect(tx.matchingPool.update).toHaveBeenCalledWith({
      where: { id: 'pool-2' },
      data: { matchedAmount: { increment: 100000n } }, // no EXHAUSTED: pool still has funds
    });
    expect(ledger.postMatch).toHaveBeenCalledWith(
      expect.objectContaining({ matchedAmount: 100000n }),
      expect.anything(),
    );
    expect(tx.campaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ raisedAmount: { increment: 1100000n } }),
    });
  });

  it('marks an already-spent pool EXHAUSTED and skips matching without touching the donation', async () => {
    const { service, tx, ledger } = setupWithPool({
      id: 'pool-3',
      totalCommitted: 1000000n,
      matchedAmount: 1000000n, // remaining = 0
      matchRatio: 100,
      status: 'ACTIVE',
    });

    await service.applySuccess(params);

    expect(tx.matchingPool.update).toHaveBeenCalledWith({
      where: { id: 'pool-3' },
      data: { status: 'EXHAUSTED' },
    });
    expect(tx.donation.update).not.toHaveBeenCalled();
    expect(ledger.postMatch).not.toHaveBeenCalled();
    expect(tx.campaign.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: expect.objectContaining({ raisedAmount: { increment: 1000000n } }), // amount only
    });
  });

  it('skips matching entirely when no ACTIVE pool exists', async () => {
    const { service, tx, ledger } = setupWithPool(null);
    await service.applySuccess(params);
    expect(tx.matchingPool.update).not.toHaveBeenCalled();
    expect(ledger.postMatch).not.toHaveBeenCalled();
  });
});

describe('DonationPaymentService.applyFailure', () => {
  it('transitions a PENDING donation to FAILED and reports duplicates otherwise', async () => {
    const { service, prisma } = makeService();
    prisma.donation.findFirst.mockResolvedValue(makeDonation());
    prisma.donation.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.applyFailure({ publicRef: 'KDO-TEST0001', reason: 'provider timeout' });

    expect(result).toEqual({ donation: null, duplicate: true });
    expect(prisma.donation.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: DonationStatus.PENDING },
      data: { status: DonationStatus.FAILED, failureReason: 'provider timeout' },
    });
  });

  it('truncates long failure reasons to 500 characters', async () => {
    const { service, prisma } = makeService();
    prisma.donation.findFirst.mockResolvedValue(makeDonation());
    prisma.donation.updateMany.mockResolvedValue({ count: 1 });

    await service.applyFailure({ publicRef: 'KDO-TEST0001', reason: 'x'.repeat(600) });

    expect(prisma.donation.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: DonationStatus.PENDING },
      data: { status: DonationStatus.FAILED, failureReason: 'x'.repeat(500) },
    });
  });
});
