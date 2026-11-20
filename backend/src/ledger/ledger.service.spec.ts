import { LedgerDirection, LedgerTxnType } from '@prisma/client';
import { LEDGER_CODES, LedgerEntryInput, LedgerService } from './ledger.service';
import { PrismaService } from '../common/prisma.service';

/**
 * Unit tests for the double-entry ledger engine.
 * PrismaService is replaced by a minimal jest.fn() object; the $transaction
 * mock simply invokes the interactive callback with the shared tx client, so
 * every code path is exercised without a database.
 */

type TxClientMock = {
  ledgerTransaction: { create: jest.Mock };
  ledgerAccount: { findUnique: jest.Mock; create: jest.Mock };
  ledgerEntry: { create: jest.Mock; aggregate: jest.Mock };
  withdrawal: { aggregate: jest.Mock };
};

function makeMocks() {
  const tx: TxClientMock = {
    ledgerTransaction: { create: jest.fn() },
    ledgerAccount: { findUnique: jest.fn(), create: jest.fn() },
    ledgerEntry: { create: jest.fn(), aggregate: jest.fn() },
    withdrawal: { aggregate: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (client: TxClientMock) => unknown) => fn(tx)),
    ledgerTransaction: tx.ledgerTransaction,
    ledgerAccount: tx.ledgerAccount,
    ledgerEntry: tx.ledgerEntry,
    withdrawal: tx.withdrawal,
  } as unknown as PrismaService;
  return { tx, prisma };
}

function entry(partial: Partial<LedgerEntryInput> & { code: string }): LedgerEntryInput {
  return {
    name: partial.code,
    type: 'ASSET',
    currency: 'NGN',
    direction: 'DEBIT',
    amount: 0n,
    ...partial,
  } as LedgerEntryInput;
}

describe('LedgerService', () => {
  let service: LedgerService;
  let tx: TxClientMock;

  beforeEach(() => {
    const mocks = makeMocks();
    tx = mocks.tx;
    service = new LedgerService(mocks.prisma);
    // Default behaviour: transactions are created, accounts always exist.
    tx.ledgerTransaction.create.mockResolvedValue({ id: 'txn-1' });
    tx.ledgerAccount.findUnique.mockResolvedValue({ id: 'acc-1', code: 'X', type: 'ASSET' });
    tx.ledgerAccount.create.mockImplementation(({ data }: { data: { code: string } }) =>
      Promise.resolve({ id: `acc-${data.code}`, ...data }),
    );
    tx.ledgerEntry.create.mockResolvedValue({});
  });

  describe('postTransaction', () => {
    it('posts balanced entries and returns the transaction', async () => {
      const txn = await service.postTransaction({
        reference: 'donation:d1',
        type: LedgerTxnType.DONATION,
        description: 'ok',
        entries: [
          entry({ code: '1100:CLEARING:NGN', direction: 'DEBIT', amount: 1000n }),
          entry({ code: '2000:CAMPAIGN:c1:NGN', type: 'LIABILITY', direction: 'CREDIT', amount: 1000n }),
        ],
      });

      expect(txn).toMatchObject({ id: 'txn-1' });
      expect(tx.ledgerTransaction.create).toHaveBeenCalledWith({
        data: { reference: 'donation:d1', type: LedgerTxnType.DONATION, description: 'ok' },
      });
      expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
    });

    it('balances per currency across mixed-currency entries', async () => {
      await service.postTransaction({
        reference: 'multi-currency-1',
        type: LedgerTxnType.DONATION,
        entries: [
          entry({ code: 'A:USD', currency: 'USD', direction: 'DEBIT', amount: 500n }),
          entry({ code: 'B:USD', currency: 'USD', direction: 'CREDIT', amount: 500n }),
          entry({ code: 'A:NGN', currency: 'NGN', direction: 'DEBIT', amount: 200n }),
          entry({ code: 'B:NGN', currency: 'NGN', direction: 'CREDIT', amount: 200n }),
        ],
      });
      expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(4);
    });

    it('throws on imbalance (debit 100 / credit 90) and posts nothing', async () => {
      await expect(
        service.postTransaction({
          reference: 'donation:bad',
          type: LedgerTxnType.DONATION,
          entries: [
            entry({ code: '1100:CLEARING:NGN', direction: 'DEBIT', amount: 100n }),
            entry({ code: '2000:CAMPAIGN:c1:NGN', type: 'LIABILITY', direction: 'CREDIT', amount: 90n }),
          ],
        }),
      ).rejects.toThrow(/Ledger imbalance for donation:bad \(NGN\): debit=100 credit=90/);

      expect(tx.ledgerTransaction.create).not.toHaveBeenCalled();
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
    });

    it('throws when a single currency is imbalanced even if the totals match', async () => {
      await expect(
        service.postTransaction({
          reference: 'cross-currency-bad',
          type: LedgerTxnType.DONATION,
          entries: [
            entry({ code: 'A:USD', currency: 'USD', direction: 'DEBIT', amount: 100n }),
            entry({ code: 'B:USD', currency: 'USD', direction: 'CREDIT', amount: 50n }),
            entry({ code: 'A:NGN', currency: 'NGN', direction: 'DEBIT', amount: 50n }),
            entry({ code: 'B:NGN', currency: 'NGN', direction: 'CREDIT', amount: 100n }),
          ],
        }),
      ).rejects.toThrow(/Ledger imbalance/);
    });

    it('skips zero-amount entries entirely', async () => {
      await service.postTransaction({
        reference: 'donation:zero-tip',
        type: LedgerTxnType.DONATION,
        entries: [
          entry({ code: '1100:CLEARING:NGN', direction: 'DEBIT', amount: 2500000n }),
          entry({ code: '2000:CAMPAIGN:c1:NGN', type: 'LIABILITY', direction: 'CREDIT', amount: 2500000n }),
          entry({ code: '4000:PLATFORM_REVENUE:NGN', type: 'REVENUE', direction: 'CREDIT', amount: 0n }),
        ],
      });

      expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
      expect(tx.ledgerEntry.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ amount: 0n }) }),
      );
    });

    it('surfaces a P2002 unique-constraint violation from the reference unique index', async () => {
      tx.ledgerTransaction.create.mockRejectedValue({ code: 'P2002', message: 'Unique constraint failed' });

      await expect(
        service.postTransaction({
          reference: 'donation:already-posted',
          type: LedgerTxnType.DONATION,
          entries: [entry({ code: 'A', direction: 'DEBIT', amount: 1n }), entry({ code: 'B', direction: 'CREDIT', amount: 1n })],
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('reuses the provided transaction client when one is passed', async () => {
      const outerTx = {
        ledgerTransaction: { create: jest.fn().mockResolvedValue({ id: 'txn-outer' }) },
        ledgerAccount: { findUnique: jest.fn().mockResolvedValue({ id: 'a', type: 'ASSET' }), create: jest.fn() },
        ledgerEntry: { create: jest.fn(), aggregate: jest.fn() },
        withdrawal: { aggregate: jest.fn() },
      };
      await service.postTransaction(
        {
          reference: 'donation:in-tx',
          type: LedgerTxnType.DONATION,
          entries: [entry({ code: 'A', direction: 'DEBIT', amount: 5n }), entry({ code: 'B', direction: 'CREDIT', amount: 5n })],
        },
        outerTx as never,
      );
      expect(outerTx.ledgerTransaction.create).toHaveBeenCalled();
      // The ambient $transaction mock was never used.
      expect(service['prisma'].$transaction).not.toHaveBeenCalled();
    });
  });

  describe('accountBalance', () => {
    function stubAggregates(debit: bigint, credit: bigint) {
      tx.ledgerEntry.aggregate.mockImplementation((args: { where: { direction: LedgerDirection } }) =>
        Promise.resolve({ _sum: { amount: args.where.direction === LedgerDirection.DEBIT ? debit : credit } }),
      );
    }

    it('is debit-positive for ASSET accounts', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue({ id: 'a1', code: '1100:CLEARING:NGN', type: 'ASSET' });
      stubAggregates(700n, 200n); // debits 700, credits 200

      await expect(service.accountBalance('1100:CLEARING:NGN')).resolves.toBe(500n);
      expect(tx.ledgerEntry.aggregate).toHaveBeenCalledWith({
        where: { accountId: 'a1', direction: LedgerDirection.DEBIT },
        _sum: { amount: true },
      });
      expect(tx.ledgerEntry.aggregate).toHaveBeenCalledWith({
        where: { accountId: 'a1', direction: LedgerDirection.CREDIT },
        _sum: { amount: true },
      });
    });

    it('is credit-positive for LIABILITY accounts', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue({ id: 'a2', code: '2000:CAMPAIGN:c1:NGN', type: 'LIABILITY' });
      stubAggregates(700n, 200n);

      await expect(service.accountBalance('2000:CAMPAIGN:c1:NGN')).resolves.toBe(-500n);
    });

    it('is credit-positive for REVENUE accounts', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue({ id: 'a3', code: '4000:PLATFORM_REVENUE:NGN', type: 'REVENUE' });
      stubAggregates(100n, 900n);

      await expect(service.accountBalance('4000:PLATFORM_REVENUE:NGN')).resolves.toBe(800n);
    });

    it('treats missing accounts as zero balance', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue(null);
      await expect(service.accountBalance('2000:CAMPAIGN:unknown:NGN')).resolves.toBe(0n);
      expect(tx.ledgerEntry.aggregate).not.toHaveBeenCalled();
    });
  });

  describe('campaignAvailableBalance', () => {
    it('subtracts in-flight withdrawals from the campaign liability balance', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue({ id: 'a2', code: '2000:CAMPAIGN:c1:NGN', type: 'LIABILITY' });
      tx.ledgerEntry.aggregate.mockImplementation((args: { where: { direction: LedgerDirection } }) =>
        Promise.resolve({ _sum: { amount: args.where.direction === LedgerDirection.DEBIT ? 0n : 2500000n } }),
      );
      tx.withdrawal.aggregate.mockResolvedValue({ _sum: { amount: 1000000n } });

      await expect(service.campaignAvailableBalance('c1', 'NGN')).resolves.toBe(1500000n);
      expect(tx.withdrawal.aggregate).toHaveBeenCalledWith({
        // Every reservation-holding state (incl. UNDER_REVIEW / REQUIRES_INFORMATION /
        // REQUIRES_RECONCILIATION — the payout outcome is unresolved) reduces availability.
        where: { campaignId: 'c1', currency: 'NGN', status: { in: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'REQUIRES_INFORMATION', 'REQUIRES_RECONCILIATION'] } },
        _sum: { amount: true },
      });
    });

    it('never returns a negative available balance', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue({ id: 'a2', type: 'LIABILITY' });
      tx.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount: 0n } });
      tx.withdrawal.aggregate.mockResolvedValue({ _sum: { amount: 999999n } });

      await expect(service.campaignAvailableBalance('c1', 'NGN')).resolves.toBe(0n);
    });
  });

  describe('postDonationSuccess', () => {
    const baseInput = {
      donationId: 'd1',
      publicRef: 'KDO-TEST0001',
      campaignId: 'c1',
      currency: 'NGN',
      amount: 2500000n,
      tipAmount: 125000n,
      totalCharged: 2625000n,
      providerName: 'MOCK',
    };

    function postedEntries() {
      return tx.ledgerEntry.create.mock.calls.map((call) => call[0].data);
    }

    beforeEach(() => {
      tx.ledgerAccount.findUnique.mockResolvedValue(null); // force account creation to reveal codes
    });

    it('posts DEBIT clearing = amount + tip, CREDIT campaign = amount, CREDIT platform revenue = tip', async () => {
      await service.postDonationSuccess(baseInput);

      expect(tx.ledgerTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reference: 'donation:d1', type: LedgerTxnType.DONATION }),
      });

      const entries = postedEntries();
      expect(entries).toHaveLength(3);

      // 1. Provider clearing (ASSET) is debited with the TOTAL charged.
      expect(entries[0]).toMatchObject({
        direction: 'DEBIT',
        amount: 2625000n, // amount + tip
        currency: 'NGN',
      });
      expect(entries[0].accountId).toBe(`acc-${LEDGER_CODES.clearing('NGN')}`);

      // 2. Campaign payable (LIABILITY) is credited with the donation amount only.
      expect(entries[1]).toMatchObject({
        direction: 'CREDIT',
        amount: 2500000n,
        currency: 'NGN',
      });
      expect(entries[1].accountId).toBe(`acc-${LEDGER_CODES.campaign('c1', 'NGN')}`);

      // 3. Platform revenue (REVENUE) is credited with the tip only.
      expect(entries[2]).toMatchObject({
        direction: 'CREDIT',
        amount: 125000n,
        currency: 'NGN',
      });
      expect(entries[2].accountId).toBe(`acc-${LEDGER_CODES.platformRevenue('NGN')}`);
    });

    it('omits the platform-revenue entry when there is no tip', async () => {
      await service.postDonationSuccess({ ...baseInput, tipAmount: 0n, totalCharged: 2500000n });
      const entries = postedEntries();
      expect(entries).toHaveLength(2);
      expect(entries.some((e) => e.accountId.includes('PLATFORM_REVENUE'))).toBe(false);
    });

    it('records the publicRef in the transaction metadata', async () => {
      await service.postDonationSuccess(baseInput);
      expect(tx.ledgerTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { donationId: 'd1', publicRef: 'KDO-TEST0001', tip: '125000' },
        }),
      });
    });
  });

  describe('postMatch', () => {
    it('moves matched funds from the pool liability to the campaign liability', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue(null);
      await service.postMatch({
        poolId: 'pool-1',
        donationId: 'd1',
        publicRef: 'KDO-TEST0001',
        campaignId: 'c1',
        currency: 'NGN',
        matchedAmount: 500000n,
      });

      expect(tx.ledgerTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reference: 'match:pool-1:d1', type: LedgerTxnType.MATCH }),
      });
      const entries = tx.ledgerEntry.create.mock.calls.map((call) => call[0].data);
      expect(entries[0]).toMatchObject({ direction: 'DEBIT', amount: 500000n });
      expect(entries[0].accountId).toBe(`acc-${LEDGER_CODES.matchPool('pool-1')}`);
      expect(entries[1]).toMatchObject({ direction: 'CREDIT', amount: 500000n });
      expect(entries[1].accountId).toBe(`acc-${LEDGER_CODES.campaign('c1', 'NGN')}`);
    });
  });

  describe('postWithdrawal', () => {
    it('debits the campaign and credits clearing for the net amount', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue(null);
      await service.postWithdrawal({
        withdrawalId: 'w1',
        publicRef: 'WDR-TEST0001',
        campaignId: 'c1',
        currency: 'NGN',
        amount: 1000000n,
        feeAmount: 0n,
        netAmount: 1000000n,
      });

      expect(tx.ledgerTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reference: 'withdrawal:w1', type: LedgerTxnType.WITHDRAWAL }),
      });
      const entries = tx.ledgerEntry.create.mock.calls.map((call) => call[0].data);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ direction: 'DEBIT', amount: 1000000n });
      expect(entries[0].accountId).toBe(`acc-${LEDGER_CODES.campaign('c1', 'NGN')}`);
      expect(entries[1]).toMatchObject({ direction: 'CREDIT', amount: 1000000n });
      expect(entries[1].accountId).toBe(`acc-${LEDGER_CODES.clearing('NGN')}`);
    });

    it('posts the fee as platform revenue when present', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue(null);
      await service.postWithdrawal({
        withdrawalId: 'w1',
        publicRef: 'WDR-TEST0001',
        campaignId: 'c1',
        currency: 'NGN',
        amount: 1000000n,
        feeAmount: 15000n,
        netAmount: 985000n,
      });
      const entries = tx.ledgerEntry.create.mock.calls.map((call) => call[0].data);
      expect(entries).toHaveLength(3);
      expect(entries[2]).toMatchObject({ direction: 'CREDIT', amount: 15000n });
      expect(entries[2].accountId).toBe(`acc-${LEDGER_CODES.platformRevenue('NGN')}`);
    });
  });

  describe('postRefund', () => {
    it('reverses the donation posting including the tip', async () => {
      tx.ledgerAccount.findUnique.mockResolvedValue(null);
      await service.postRefund({
        refundId: 'r1',
        donationId: 'd1',
        publicRef: 'KDO-TEST0001',
        campaignId: 'c1',
        currency: 'NGN',
        amount: 2500000n,
        tipAmount: 125000n,
      });

      expect(tx.ledgerTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ reference: 'refund:r1', type: LedgerTxnType.REFUND }),
      });
      const entries = tx.ledgerEntry.create.mock.calls.map((call) => call[0].data);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ direction: 'DEBIT', amount: 2500000n }); // campaign payable back
      expect(entries[1]).toMatchObject({ direction: 'CREDIT', amount: 2625000n }); // clearing released
      expect(entries[2]).toMatchObject({ direction: 'DEBIT', amount: 125000n }); // tip revenue reversed
    });
  });

  describe('LEDGER_CODES', () => {
    it('builds deterministic account codes', () => {
      expect(LEDGER_CODES.clearing('NGN')).toBe('1100:CLEARING:NGN');
      expect(LEDGER_CODES.campaign('c1', 'USD')).toBe('2000:CAMPAIGN:c1:USD');
      expect(LEDGER_CODES.platformRevenue('NGN')).toBe('4000:PLATFORM_REVENUE:NGN');
      expect(LEDGER_CODES.matchPool('p1')).toBe('2400:MATCH_POOL:p1');
      expect(LEDGER_CODES.providerFees('NGN')).toBe('5000:PROVIDER_FEES:NGN');
    });
  });
});
