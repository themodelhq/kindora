import { Injectable, Logger } from '@nestjs/common';
import { LedgerDirection, LedgerTxnType, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

export type TxClient = Prisma.TransactionClient | PrismaClient;

export interface LedgerEntryInput {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  currency: string;
  campaignId?: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: bigint;
}

/** System account codes. Suffix per currency keeps balances unambiguous. */
export const LEDGER_CODES = {
  clearing: (currency: string) => `1100:CLEARING:${currency}`,
  campaign: (campaignId: string, currency: string) => `2000:CAMPAIGN:${campaignId}:${currency}`,
  platformRevenue: (currency: string) => `4000:PLATFORM_REVENUE:${currency}`,
  matchPool: (poolId: string) => `2400:MATCH_POOL:${poolId}`,
  providerFees: (currency: string) => `5000:PROVIDER_FEES:${currency}`,
};

/**
 * Double-entry ledger engine.
 *
 * Invariants (enforced on every post):
 *  1. Sum(DEBIT) == Sum(CREDIT) per currency within a transaction.
 *  2. Every transaction reference is unique -> postings are exactly-once.
 *  3. Entries are immutable: no update/delete paths exist for posted entries.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async ensureAccount(tx: TxClient, input: Pick<LedgerEntryInput, 'code' | 'name' | 'type' | 'currency' | 'campaignId'>) {
    const existing = await tx.ledgerAccount.findUnique({ where: { code: input.code } });
    if (existing) return existing;
    try {
      return await tx.ledgerAccount.create({
        data: {
          code: input.code,
          name: input.name,
          type: input.type,
          currency: input.currency,
          ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        },
      });
    } catch (err) {
      // Two concurrent first postings for the same account race the unique
      // constraint; the loser must reuse the winner's account instead of
      // rolling back a money movement at the payment moment.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const account = await tx.ledgerAccount.findUnique({ where: { code: input.code } });
        if (account) return account;
      }
      throw err;
    }
  }

  /**
   * Posts an immutable double-entry transaction.
   * Throws when debits/credits do not balance for any currency, or when the
   * reference was already posted (idempotency).
   */
  async postTransaction(
    input: {
      reference: string;
      type: LedgerTxnType;
      description?: string;
      entries: LedgerEntryInput[];
      metadata?: Record<string, unknown>;
    },
    tx?: TxClient,
  ) {
    const run = async (client: TxClient) => {
      const byCurrency = new Map<string, { debit: bigint; credit: bigint }>();
      for (const e of input.entries) {
        const acc = byCurrency.get(e.currency) ?? { debit: 0n, credit: 0n };
        if (e.direction === 'DEBIT') acc.debit += e.amount;
        else acc.credit += e.amount;
        byCurrency.set(e.currency, acc);
      }
      for (const [currency, sums] of byCurrency) {
        if (sums.debit !== sums.credit) {
          throw new Error(
            `Ledger imbalance for ${input.reference} (${currency}): debit=${sums.debit} credit=${sums.credit}`,
          );
        }
      }

      const txn = await client.ledgerTransaction.create({
        data: {
          reference: input.reference,
          type: input.type,
          description: input.description,
          ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        },
      });

      for (const e of input.entries) {
        if (e.amount === 0n) continue;
        const account = await this.ensureAccount(client, e);
        await client.ledgerEntry.create({
          data: {
            transactionId: txn.id,
            accountId: account.id,
            direction: e.direction,
            amount: e.amount,
            currency: e.currency,
          },
        });
      }
      return txn;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Signed balance for an account: natural sign by account type. */
  async accountBalance(code: string, tx?: TxClient): Promise<bigint> {
    const run = async (client: TxClient) => {
      const account = await client.ledgerAccount.findUnique({ where: { code } });
      if (!account) return 0n;
      const debit = await client.ledgerEntry.aggregate({
        where: { accountId: account.id, direction: LedgerDirection.DEBIT },
        _sum: { amount: true },
      });
      const credit = await client.ledgerEntry.aggregate({
        where: { accountId: account.id, direction: LedgerDirection.CREDIT },
        _sum: { amount: true },
      });
      const d = debit._sum.amount ?? 0n;
      const c = credit._sum.amount ?? 0n;
      return account.type === 'ASSET' || account.type === 'EXPENSE' ? d - c : c - d;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /**
   * Funds available for withdrawal on a campaign:
   * campaign liability balance minus in-flight (reserved) withdrawals.
   * Accepts an optional transaction client so callers inside an open
   * transaction (e.g. row-locked withdrawal creation) see a consistent view.
   */
  async campaignAvailableBalance(campaignId: string, currency: string, tx?: TxClient): Promise<bigint> {
    const run = async (client: TxClient) => {
      const balance = await this.accountBalance(LEDGER_CODES.campaign(campaignId, currency), client);
      const inFlight = await client.withdrawal.aggregate({
        where: {
          campaignId,
          currency,
          status: { in: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'REQUIRES_INFORMATION', 'REQUIRES_RECONCILIATION'] },
        },
        _sum: { amount: true },
      });
      const locked = inFlight._sum.amount ?? 0n;
      return balance > locked ? balance - locked : 0n;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /**
   * Posts a successful donation: money at provider clears into the campaign
   * payable account; platform tips are recognised as revenue.
   */
  postDonationSuccess(
    input: {
      donationId: string;
      publicRef: string;
      campaignId: string;
      currency: string;
      amount: bigint;
      tipAmount: bigint;
      totalCharged: bigint;
      providerName: string;
    },
    tx?: TxClient,
  ) {
    const cur = input.currency;
    const entries: LedgerEntryInput[] = [
      {
        code: LEDGER_CODES.clearing(cur),
        name: `Provider clearing (${cur})`,
        type: 'ASSET',
        currency: cur,
        direction: 'DEBIT',
        amount: input.totalCharged,
      },
      {
        code: LEDGER_CODES.campaign(input.campaignId, cur),
        name: 'Campaign payable',
        type: 'LIABILITY',
        currency: cur,
        campaignId: input.campaignId,
        direction: 'CREDIT',
        amount: input.amount,
      },
    ];
    if (input.tipAmount > 0n) {
      entries.push({
        code: LEDGER_CODES.platformRevenue(cur),
        name: 'Platform revenue (tips & fees)',
        type: 'REVENUE',
        currency: cur,
        direction: 'CREDIT',
        amount: input.tipAmount,
      });
    }
    return this.postTransaction(
      {
        reference: `donation:${input.donationId}`,
        type: LedgerTxnType.DONATION,
        description: `Donation ${input.publicRef} via ${input.providerName}`,
        metadata: { donationId: input.donationId, publicRef: input.publicRef, tip: input.tipAmount.toString() },
        entries,
      },
      tx,
    );
  }

  /** Posts the sponsor-funded matching increment for a donation. */
  postMatch(
    input: { poolId: string; donationId: string; publicRef: string; campaignId: string; currency: string; matchedAmount: bigint },
    tx?: TxClient,
  ) {
    return this.postTransaction(
      {
        reference: `match:${input.poolId}:${input.donationId}`,
        type: LedgerTxnType.MATCH,
        description: `Matched donation ${input.publicRef}`,
        metadata: { poolId: input.poolId, donationId: input.donationId },
        entries: [
          {
            code: LEDGER_CODES.matchPool(input.poolId),
            name: 'Matching pool (sponsor funds held)',
            type: 'LIABILITY',
            currency: input.currency,
            direction: 'DEBIT',
            amount: input.matchedAmount,
          },
          {
            code: LEDGER_CODES.campaign(input.campaignId, input.currency),
            name: 'Campaign payable',
            type: 'LIABILITY',
            currency: input.currency,
            campaignId: input.campaignId,
            direction: 'CREDIT',
            amount: input.matchedAmount,
          },
        ],
      },
      tx,
    );
  }

  /** Withdrawal payout: campaign liability and provider clearing are reduced; fee is revenue. */
  postWithdrawal(
    input: {
      withdrawalId: string;
      publicRef: string;
      campaignId: string;
      currency: string;
      amount: bigint;
      feeAmount: bigint;
      netAmount: bigint;
    },
    tx?: TxClient,
  ) {
    const cur = input.currency;
    const entries: LedgerEntryInput[] = [
      {
        code: LEDGER_CODES.campaign(input.campaignId, cur),
        name: 'Campaign payable',
        type: 'LIABILITY',
        currency: cur,
        campaignId: input.campaignId,
        direction: 'DEBIT',
        amount: input.amount,
      },
      {
        code: LEDGER_CODES.clearing(cur),
        name: `Provider clearing (${cur})`,
        type: 'ASSET',
        currency: cur,
        direction: 'CREDIT',
        amount: input.netAmount,
      },
    ];
    if (input.feeAmount > 0n) {
      entries.push({
        code: LEDGER_CODES.platformRevenue(cur),
        name: 'Platform revenue (tips & fees)',
        type: 'REVENUE',
        currency: cur,
        direction: 'CREDIT',
        amount: input.feeAmount,
      });
    }
    return this.postTransaction(
      {
        reference: `withdrawal:${input.withdrawalId}`,
        type: LedgerTxnType.WITHDRAWAL,
        description: `Payout ${input.publicRef}`,
        metadata: { withdrawalId: input.withdrawalId, fee: input.feeAmount.toString(), net: input.netAmount.toString() },
        entries,
      },
      tx,
    );
  }

  /**
   * v1.0.8 §8.3 — accounting correction for a COMPLETED, authoritatively
   * verified reversal. Posts the exact mirror of the original payout entries
   * as a SEPARATE financial event with its own exactly-once reference
   * (`withdrawal-reversal:<id>`): the original successful transfer history is
   * preserved untouched, and a duplicate reversal posting is impossible at
   * the DB level (unique reference). Callers must only invoke this AFTER the
   * provider reversal is verified terminal (reversalState COMPLETED).
   */
  postWithdrawalReversal(
    input: {
      withdrawalId: string;
      publicRef: string;
      campaignId: string;
      currency: string;
      amount: bigint;
      feeAmount: bigint;
      netAmount: bigint;
      attemptId?: string;
    },
    tx?: TxClient,
  ) {
    const cur = input.currency;
    const entries: LedgerEntryInput[] = [
      {
        code: LEDGER_CODES.campaign(input.campaignId, cur),
        name: 'Campaign payable',
        type: 'LIABILITY',
        currency: cur,
        campaignId: input.campaignId,
        direction: 'CREDIT',
        amount: input.amount,
      },
      {
        code: LEDGER_CODES.clearing(cur),
        name: `Provider clearing (${cur})`,
        type: 'ASSET',
        currency: cur,
        direction: 'DEBIT',
        amount: input.netAmount,
      },
    ];
    if (input.feeAmount > 0n) {
      entries.push({
        code: LEDGER_CODES.platformRevenue(cur),
        name: 'Platform revenue (tips & fees)',
        type: 'REVENUE',
        currency: cur,
        direction: 'DEBIT',
        amount: input.feeAmount,
      });
    }
    return this.postTransaction(
      {
        reference: `withdrawal-reversal:${input.withdrawalId}`,
        type: LedgerTxnType.WITHDRAWAL_REVERSAL,
        description: `Reversal of payout ${input.publicRef} (authoritative provider evidence)`,
        metadata: {
          withdrawalId: input.withdrawalId,
          fee: input.feeAmount.toString(),
          net: input.netAmount.toString(),
          ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        },
        entries,
      },
      tx,
    );
  }

  /**
   * Posts the provider processing fee: fee expense is recognised and the
   * clearing asset is reduced by the same amount, so clearing converges to
   * the amount the provider will actually settle. Reference is per-donation
   * unique, making the posting exactly-once.
   */
  postProviderFee(
    input: { donationId: string; publicRef: string; currency: string; feeMinor: bigint },
    tx?: TxClient,
  ) {
    if (input.feeMinor <= 0n) return Promise.resolve(null);
    const cur = input.currency;
    return this.postTransaction(
      {
        reference: `fee:donation:${input.donationId}`,
        type: LedgerTxnType.PROVIDER_FEE,
        description: `Provider fee for donation ${input.publicRef}`,
        metadata: { donationId: input.donationId, publicRef: input.publicRef, fee: input.feeMinor.toString() },
        entries: [
          {
            code: LEDGER_CODES.providerFees(cur),
            name: 'Provider processing fees (expense)',
            type: 'EXPENSE',
            currency: cur,
            direction: 'DEBIT',
            amount: input.feeMinor,
          },
          {
            code: LEDGER_CODES.clearing(cur),
            name: `Provider clearing (${cur})`,
            type: 'ASSET',
            currency: cur,
            direction: 'CREDIT',
            amount: input.feeMinor,
          },
        ],
      },
      tx,
    );
  }

  /** Refund reversal: campaign payable and tip revenue are reversed, clearing decreases. */
  postRefund(
    input: { refundId: string; donationId: string; publicRef: string; campaignId: string; currency: string; amount: bigint; tipAmount: bigint },
    tx?: TxClient,
  ) {
    const cur = input.currency;
    const total = input.amount + input.tipAmount;
    const entries: LedgerEntryInput[] = [
      {
        code: LEDGER_CODES.campaign(input.campaignId, cur),
        name: 'Campaign payable',
        type: 'LIABILITY',
        currency: cur,
        campaignId: input.campaignId,
        direction: 'DEBIT',
        amount: input.amount,
      },
      {
        code: LEDGER_CODES.clearing(cur),
        name: `Provider clearing (${cur})`,
        type: 'ASSET',
        currency: cur,
        direction: 'CREDIT',
        amount: total,
      },
    ];
    if (input.tipAmount > 0n) {
      entries.push({
        code: LEDGER_CODES.platformRevenue(cur),
        name: 'Platform revenue (tips & fees)',
        type: 'REVENUE',
        currency: cur,
        direction: 'DEBIT',
        amount: input.tipAmount,
      });
    }
    return this.postTransaction(
      {
        reference: `refund:${input.refundId}`,
        type: LedgerTxnType.REFUND,
        description: `Refund of donation ${input.publicRef}`,
        metadata: { donationId: input.donationId, refundId: input.refundId },
        entries,
      },
      tx,
    );
  }

  /** Reverses the sponsor matching increment when a donation is refunded. */
  postMatchReversal(
    input: { poolId: string; donationId: string; publicRef: string; campaignId: string; currency: string; matchedAmount: bigint },
    tx?: TxClient,
  ) {
    return this.postTransaction(
      {
        reference: `matchrev:${input.poolId}:${input.donationId}`,
        type: LedgerTxnType.MATCH,
        description: `Match reversal for refunded donation ${input.publicRef}`,
        metadata: { poolId: input.poolId, donationId: input.donationId, reversal: true },
        entries: [
          {
            code: LEDGER_CODES.campaign(input.campaignId, input.currency),
            name: 'Campaign payable',
            type: 'LIABILITY',
            currency: input.currency,
            campaignId: input.campaignId,
            direction: 'DEBIT',
            amount: input.matchedAmount,
          },
          {
            code: LEDGER_CODES.matchPool(input.poolId),
            name: 'Matching pool (sponsor funds held)',
            type: 'LIABILITY',
            currency: input.currency,
            direction: 'CREDIT',
            amount: input.matchedAmount,
          },
        ],
      },
      tx,
    );
  }

  /** Platform-wide totals for the public impact page. */
  async platformSummary() {
    const [accounts, txnCount, donations] = await this.prisma.$transaction([
      this.prisma.ledgerAccount.findMany({ where: { type: 'LIABILITY' }, select: { code: true, currency: true } }),
      this.prisma.ledgerTransaction.count(),
      this.prisma.donation.aggregate({ where: { status: 'SUCCEEDED' }, _count: true }),
    ]);
    return { ledgerAccounts: accounts.length, ledgerTransactions: txnCount, successfulDonations: donations._count };
  }
}
