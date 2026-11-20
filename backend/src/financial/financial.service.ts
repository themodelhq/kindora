import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DonationStatus, LedgerAccountType, LedgerDirection, PaymentProvider, Prisma, WebhookStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

/**
 * Financial Control & Reconciliation Centre (hardening spec §9).
 *
 * READ-ONLY analytics and reconciliation views: this service NEVER mutates
 * financial state and NEVER auto-fixes anything it flags. The only writes are
 * audit-log rows (REPORT_EXPORTED) recording that an admin exported a report.
 *
 * Conventions:
 *  - All amounts are BigInt minor units inside the service; the global
 *    BigIntSerializerInterceptor converts them to strings at the JSON edge.
 *  - Currencies are NEVER combined: every aggregate is bucketed per currency.
 *  - Every query is bounded: date ranges default to 30 days, may never span
 *    more than 1 year, and all filters are Prisma `where` objects (no raw SQL).
 */

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
/** Ledger iteration page size for the full-scan integrity checks. */
const SCAN_PAGE = 500;
/** Response-size caps for violation lists (the scan itself is complete). */
const MAX_VIOLATIONS = 50;

/** Withdrawal statuses whose gross amount is "reserved" against the campaign. */
const RESERVED_WITHDRAWAL_STATUSES = [
  'PENDING',
  'UNDER_REVIEW',
  'APPROVED',
  'PROCESSING',
  'REQUIRES_INFORMATION',
] as const;

/** System ledger account-code prefixes (see LedgerService.LEDGER_CODES). */
const ACCOUNT_PREFIXES = {
  clearing: '1100:CLEARING:',
  campaign: '2000:CAMPAIGN:',
  platformRevenue: '4000:PLATFORM_REVENUE:',
  providerFees: '5000:PROVIDER_FEES:',
} as const;

export type PaymentAnomaly =
  | 'PROVIDER_MISMATCH'
  | 'AMOUNT_UNVERIFIED'
  | 'REFERENCE_NOT_FOUND'
  | 'UNKNOWN_EVENT'
  | 'DUPLICATE'
  | 'OK';

export const REPORT_TYPES = ['daily-closing', 'campaign-balances', 'withdrawals', 'refunds', 'platform-fees'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

interface DonationBucket {
  count: number;
  amountMinor: bigint;
}

interface CurrencySummary {
  currency: string;
  donationsInitiated: DonationBucket;
  donationsSucceeded: DonationBucket & { feesMinor: bigint; tipsMinor: bigint };
  donationsPending: DonationBucket;
  donationsFailed: { count: number };
  donationsRefunded: DonationBucket;
  recurringActive: { count: number; monthlyMinor: bigint };
  recurringFailures: { count: number; lastFailureAt: Date | null };
  campaignLiabilityMinor: bigint;
  reservedForWithdrawalsMinor: bigint;
  paidWithdrawalsMinor: bigint;
  outstandingPayoutLiabilityMinor: bigint;
  platformRevenueMinor: bigint;
  providerFeesMinor: bigint;
  clearingMinor: bigint;
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

@Injectable()
export class FinancialService {
  private readonly logger = new Logger(FinancialService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---- shared helpers -------------------------------------------------------

  /**
   * Validates and clamps the reporting window. Defaults to the last 30 days;
   * a window wider than 1 year is rejected so aggregate queries stay bounded.
   */
  private resolveRange(from?: string, to?: string): { from: Date; to: Date } {
    const to_date = to ? new Date(to) : new Date();
    const from_date = from ? new Date(from) : new Date(to_date.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
    if (Number.isNaN(from_date.getTime()) || Number.isNaN(to_date.getTime())) {
      throw new BadRequestException('Invalid date range');
    }
    if (from_date.getTime() > to_date.getTime()) {
      throw new BadRequestException('from must not be after to');
    }
    if (to_date.getTime() - from_date.getTime() > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
    }
    return { from: from_date, to: to_date };
  }

  /** Donation filters shared by the summary groupBys. */
  private donationWhere(
    range: { from: Date; to: Date },
    filters: { provider?: string; campaignId?: string; organizationId?: string },
  ): Prisma.DonationWhereInput {
    const campaignFilter: Prisma.CampaignWhereInput = {};
    if (filters.campaignId) campaignFilter.id = filters.campaignId;
    if (filters.organizationId) campaignFilter.organizationId = filters.organizationId;
    return {
      createdAt: { gte: range.from, lte: range.to },
      ...(filters.provider ? { provider: filters.provider as PaymentProvider } : {}),
      ...(Object.keys(campaignFilter).length > 0 ? { campaign: campaignFilter } : {}),
    };
  }

  /**
   * Signed balance per ledger account, computed with ONE grouped query.
   * Natural sign: ASSET/EXPENSE = debit - credit, everything else (liability,
   * revenue, equity) = credit - debit — identical to LedgerService.accountBalance.
   */
  private async accountBalances(accountIds: string[]): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    if (accountIds.length === 0) return balances;
    const groups = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId', 'direction'],
      where: { accountId: { in: accountIds } },
      _sum: { amount: true },
    });
    const signed = new Map<string, { debit: bigint; credit: bigint }>();
    for (const g of groups) {
      const acc = signed.get(g.accountId) ?? { debit: 0n, credit: 0n };
      if (g.direction === LedgerDirection.DEBIT) acc.debit += g._sum.amount ?? 0n;
      else acc.credit += g._sum.amount ?? 0n;
      signed.set(g.accountId, acc);
    }
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, type: true },
    });
    for (const account of accounts) {
      const sums = signed.get(account.id) ?? { debit: 0n, credit: 0n };
      const balance =
        account.type === LedgerAccountType.ASSET || account.type === LedgerAccountType.EXPENSE
          ? sums.debit - sums.credit
          : sums.credit - sums.debit;
      balances.set(account.id, balance);
    }
    return balances;
  }

  /**
   * Fetches every system ledger account used by the control centre plus its
   * signed balance, bucketed by currency and code prefix.
   */
  private async ledgerBucketsByCurrency(
    campaignIdFilter?: Set<string>,
  ): Promise<Map<string, { campaignLiabilityMinor: bigint; platformRevenueMinor: bigint; providerFeesMinor: bigint; clearingMinor: bigint }>> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: {
        OR: [
          { code: { startsWith: ACCOUNT_PREFIXES.clearing } },
          { code: { startsWith: ACCOUNT_PREFIXES.campaign } },
          { code: { startsWith: ACCOUNT_PREFIXES.platformRevenue } },
          { code: { startsWith: ACCOUNT_PREFIXES.providerFees } },
        ],
      },
      select: { id: true, code: true, currency: true, campaignId: true },
    });
    // When scoped to specific campaigns, only the CAMPAIGN accounts are
    // narrowed; clearing/revenue/fee accounts are platform-wide and keep
    // their platform-wide balances (the labels say exactly that).
    const relevant = campaignIdFilter
      ? accounts.filter(
          (a) =>
            !a.code.startsWith(ACCOUNT_PREFIXES.campaign) ||
            (a.campaignId !== null && campaignIdFilter.has(a.campaignId)),
        )
      : accounts;
    const balances = await this.accountBalances(relevant.map((a) => a.id));

    const buckets = new Map<string, { campaignLiabilityMinor: bigint; platformRevenueMinor: bigint; providerFeesMinor: bigint; clearingMinor: bigint }>();
    const empty = () => ({ campaignLiabilityMinor: 0n, platformRevenueMinor: 0n, providerFeesMinor: 0n, clearingMinor: 0n });
    for (const account of relevant) {
      const bucket = buckets.get(account.currency) ?? empty();
      const balance = balances.get(account.id) ?? 0n;
      if (account.code.startsWith(ACCOUNT_PREFIXES.campaign)) bucket.campaignLiabilityMinor += balance;
      else if (account.code.startsWith(ACCOUNT_PREFIXES.platformRevenue)) bucket.platformRevenueMinor += balance;
      else if (account.code.startsWith(ACCOUNT_PREFIXES.providerFees)) bucket.providerFeesMinor += balance;
      else if (account.code.startsWith(ACCOUNT_PREFIXES.clearing)) bucket.clearingMinor += balance;
      buckets.set(account.currency, bucket);
    }
    return buckets;
  }

  // ---- 1. summary -----------------------------------------------------------

  /**
   * Per-currency financial control summary. Balances (ledger accounts, withdrawal
   * reservations, recurring schedules) are point-in-time snapshots; donation
   * buckets are filtered by createdAt within the (bounded) reporting window.
   */
  async summary(filters: { from?: string; to?: string; provider?: string; campaignId?: string; organizationId?: string }) {
    const range = this.resolveRange(filters.from, filters.to);
    const donationWhere = this.donationWhere(range, filters);

    const campaignIdFilter: Set<string> | undefined = filters.campaignId
      ? new Set([filters.campaignId])
      : filters.organizationId
        ? new Set(
            (
              await this.prisma.campaign.findMany({
                where: { organizationId: filters.organizationId },
                select: { id: true },
              })
            ).map((c) => c.id),
          )
        : undefined;

    const withdrawalCampaignWhere: Prisma.WithdrawalWhereInput = filters.campaignId
      ? { campaignId: filters.campaignId }
      : filters.organizationId
        ? { campaign: { organizationId: filters.organizationId } }
        : {};

    const recurringWhere: Prisma.RecurringDonationWhereInput = {
      ...(filters.provider ? { provider: filters.provider as PaymentProvider } : {}),
      ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      ...(filters.organizationId ? { campaign: { organizationId: filters.organizationId } } : {}),
    };

    const [donationGroups, recurringActive, recurringFailures, withdrawalGroups, ledgerBuckets, disputesOpen] =
      await Promise.all([
        this.prisma.donation.groupBy({
          by: ['currency', 'status'],
          where: donationWhere,
          _count: { _all: true },
          _sum: { amount: true, tipAmount: true, providerFeeMinor: true },
        }),
        this.prisma.recurringDonation.groupBy({
          by: ['currency'],
          where: { ...recurringWhere, status: 'ACTIVE' },
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.recurringDonation.groupBy({
          by: ['currency'],
          where: { ...recurringWhere, failureCount: { gt: 0 } },
          _count: { _all: true },
          _max: { lastFailureAt: true },
        }),
        this.prisma.withdrawal.groupBy({
          by: ['currency', 'status'],
          where: withdrawalCampaignWhere,
          _sum: { amount: true },
        }),
        this.ledgerBucketsByCurrency(campaignIdFilter),
        // Disputes are audited provider-wide (AuditLog carries no currency), so
        // the count is reported at the top level and never attributed to a
        // currency bucket.
        this.prisma.auditLog.count({
          where: { action: 'PROVIDER_DISPUTE', createdAt: { gte: range.from, lte: range.to } },
        }),
      ]);

    const currencies = new Set<string>();
    for (const g of donationGroups) currencies.add(g.currency);
    for (const g of recurringActive) currencies.add(g.currency);
    for (const g of recurringFailures) currencies.add(g.currency);
    for (const g of withdrawalGroups) currencies.add(g.currency);
    for (const c of ledgerBuckets.keys()) currencies.add(c);

    const result: CurrencySummary[] = [];
    for (const currency of Array.from(currencies).sort()) {
      const row = (status: DonationStatus) => donationGroups.find((g) => g.currency === currency && g.status === status);
      const initiated = donationGroups.filter((g) => g.currency === currency);
      const succeeded = row(DonationStatus.SUCCEEDED);
      const pending = row(DonationStatus.PENDING);
      const failed = row(DonationStatus.FAILED);
      const refunded = initiated.filter((g) => g.status === DonationStatus.REFUNDED || g.status === DonationStatus.PARTIALLY_REFUNDED);
      const activeRecurring = recurringActive.find((g) => g.currency === currency);
      const failingRecurring = recurringFailures.find((g) => g.currency === currency);
      const ledger = ledgerBuckets.get(currency) ?? {
        campaignLiabilityMinor: 0n,
        platformRevenueMinor: 0n,
        providerFeesMinor: 0n,
        clearingMinor: 0n,
      };

      // Withdrawal reservations (gross amount) and paid payouts for this currency.
      let reservedMinor = 0n;
      let paidMinor = 0n;
      for (const g of withdrawalGroups.filter((g) => g.currency === currency)) {
        if (g.status === 'PAID') {
          paidMinor += g._sum.amount ?? 0n;
        } else if ((RESERVED_WITHDRAWAL_STATUSES as readonly string[]).includes(g.status)) {
          reservedMinor += g._sum.amount ?? 0n;
        }
      }

      // OUTSTANDING PAYOUT LIABILITY (precise definition): the gross amount of
      // every withdrawal that is reserved but NOT yet settled. The reserved set
      // already INCLUDES the approved-not-paid states (APPROVED, PROCESSING),
      // so outstanding == reservedForWithdrawalsMinor by construction.
      const outstandingMinor = reservedMinor;

      result.push({
        currency,
        donationsInitiated: {
          count: initiated.reduce((n, g) => n + g._count._all, 0),
          amountMinor: initiated.reduce((sum, g) => sum + (g._sum.amount ?? 0n), 0n),
        },
        donationsSucceeded: {
          count: succeeded?._count._all ?? 0,
          amountMinor: succeeded?._sum.amount ?? 0n,
          // feesMinor = Σ providerFeeMinor of SUCCEEDED donations in range.
          feesMinor: succeeded?._sum.providerFeeMinor ?? 0n,
          tipsMinor: succeeded?._sum.tipAmount ?? 0n,
        },
        donationsPending: { count: pending?._count._all ?? 0, amountMinor: pending?._sum.amount ?? 0n },
        donationsFailed: { count: failed?._count._all ?? 0 },
        // Refund buckets count donation face value (donation.amount) for
        // REFUNDED and PARTIALLY_REFUNDED rows — refund proceeds live in the
        // Refund table and are exported separately in the refunds report.
        donationsRefunded: {
          count: refunded.reduce((n, g) => n + g._count._all, 0),
          amountMinor: refunded.reduce((sum, g) => sum + (g._sum.amount ?? 0n), 0n),
        },
        // monthlyMinor is the SUM OF SCHEDULE AMOUNTS as configured (monthly,
        // quarterly and yearly schedules contribute their raw amount). It is
        // deliberately NOT normalised to a per-month figure — the label states
        // exactly what it is.
        recurringActive: {
          count: activeRecurring?._count._all ?? 0,
          monthlyMinor: activeRecurring?._sum.amount ?? 0n,
        },
        recurringFailures: {
          count: failingRecurring?._count._all ?? 0,
          lastFailureAt: failingRecurring?._max.lastFailureAt ?? null,
        },
        campaignLiabilityMinor: ledger.campaignLiabilityMinor,
        reservedForWithdrawalsMinor: reservedMinor,
        paidWithdrawalsMinor: paidMinor,
        outstandingPayoutLiabilityMinor: outstandingMinor,
        platformRevenueMinor: ledger.platformRevenueMinor,
        providerFeesMinor: ledger.providerFeesMinor,
        clearingMinor: ledger.clearingMinor,
      });
    }

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      disputesOpen,
      currencies: result,
    };
  }

  // ---- 2. payment reconciliation -------------------------------------------

  /**
   * Compares WebhookEvent rows against donations for the (bounded) period.
   * The full period is analysed so the anomaly counts are complete, then a
   * 50-per-page slice is returned.
   */
  async paymentReconciliation(filters: { from?: string; to?: string; provider?: string; status?: string; page: number }) {
    const range = this.resolveRange(filters.from, filters.to);
    const page = Math.max(1, filters.page);
    const pageSize = 50;

    const where: Prisma.WebhookEventWhereInput = {
      createdAt: { gte: range.from, lte: range.to },
      ...(filters.provider ? { provider: filters.provider as PaymentProvider } : {}),
      ...(filters.status ? { status: filters.status as WebhookStatus } : {}),
    };

    const events = await this.prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        provider: true,
        eventId: true,
        eventType: true,
        reference: true,
        signatureValid: true,
        status: true,
        handledAction: true,
        processedAt: true,
        createdAt: true,
      },
    });

    // Donation state lookup by provider reference (donation.providerReference
    // is the unique handle the webhooks controller matches on).
    const refs = Array.from(new Set(events.map((e) => e.reference).filter((r): r is string => Boolean(r))));
    const donations = refs.length
      ? await this.prisma.donation.findMany({
          where: { providerReference: { in: refs } },
          select: { providerReference: true, publicRef: true, status: true, provider: true, providerFeeMinor: true },
        })
      : [];
    const donationByRef = new Map(
      donations
        .filter((d): d is (typeof donations)[number] & { providerReference: string } => d.providerReference !== null)
        .map((d) => [d.providerReference, d] as const),
    );

    const classify = (event: (typeof events)[number]): PaymentAnomaly => {
      if (event.status === 'DUPLICATE') return 'DUPLICATE';
      if (event.handledAction === 'IGNORED_UNRECOGNIZED') return 'UNKNOWN_EVENT';
      const donation = event.reference ? donationByRef.get(event.reference) : undefined;
      if (event.reference && !donation) return 'REFERENCE_NOT_FOUND';
      if (donation && donation.provider !== event.provider) return 'PROVIDER_MISMATCH';
      // Informational: a succeeded charge whose provider fee was never
      // verified against the provider API (MOCK provider has no real fee feed).
      if (donation && donation.status === DonationStatus.SUCCEEDED && donation.providerFeeMinor === null && donation.provider !== PaymentProvider.MOCK) {
        return 'AMOUNT_UNVERIFIED';
      }
      return 'OK';
    };

    const counts: Record<PaymentAnomaly, number> = {
      PROVIDER_MISMATCH: 0,
      AMOUNT_UNVERIFIED: 0,
      REFERENCE_NOT_FOUND: 0,
      UNKNOWN_EVENT: 0,
      DUPLICATE: 0,
      OK: 0,
    };
    const rows = events.map((event) => {
      const anomaly = classify(event);
      counts[anomaly] += 1;
      const donation = event.reference ? donationByRef.get(event.reference) : undefined;
      return {
        id: event.id,
        provider: event.provider,
        eventType: event.eventType,
        reference: event.reference,
        eventId: event.eventId,
        signatureValid: event.signatureValid,
        status: event.status,
        handledAction: event.handledAction,
        processedAt: event.processedAt,
        createdAt: event.createdAt,
        donationState: donation
          ? { publicRef: donation.publicRef, status: donation.status, provider: donation.provider }
          : null,
        anomaly,
      };
    });

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      total: rows.length,
      page,
      pageSize,
      counts,
      items: rows.slice((page - 1) * pageSize, page * pageSize),
    };
  }

  // ---- 3. withdrawal reconciliation ----------------------------------------

  async withdrawalReconciliation(query: { page: number; limit: number }) {
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const where: Prisma.WithdrawalWhereInput = {};

    const [total, rows, paid, awaiting, failed, rejected, reservations] = await Promise.all([
      this.prisma.withdrawal.count({ where }),
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          publicRef: true,
          status: true,
          currency: true,
          amount: true,
          netAmount: true,
          payoutProvider: true,
          providerTransferRef: true,
          payoutProviderTxnId: true,
          evidenceUrl: true,
          paidAt: true,
          reconciledAt: true,
          createdAt: true,
          campaign: { select: { title: true, slug: true } },
        },
      }),
      this.prisma.withdrawal.count({ where: { ...where, status: 'PAID' } }),
      this.prisma.withdrawal.count({ where: { ...where, status: 'PAID', reconciledAt: null } }),
      this.prisma.withdrawal.count({ where: { ...where, status: 'FAILED' } }),
      this.prisma.withdrawal.count({ where: { ...where, status: 'REJECTED' } }),
      this.prisma.withdrawal.groupBy({
        by: ['currency'],
        where: { ...where, status: { in: [...RESERVED_WITHDRAWAL_STATUSES] } },
        _sum: { amount: true },
      }),
    ]);

    const outstandingReservationMinor: Record<string, string> = {};
    for (const g of reservations) {
      outstandingReservationMinor[g.currency] = (g._sum.amount ?? 0n).toString();
    }

    return {
      total,
      page,
      pageSize: limit,
      summary: {
        paid,
        awaitingReconciliation: awaiting,
        failed,
        rejected,
        outstandingReservationMinor,
      },
      items: rows.map((w) => ({
        id: w.id,
        publicRef: w.publicRef,
        status: w.status,
        currency: w.currency,
        amountMinor: w.amount,
        netAmountMinor: w.netAmount,
        payoutProvider: w.payoutProvider,
        providerTransferRef: w.providerTransferRef,
        payoutProviderTxnId: w.payoutProviderTxnId,
        paidAt: w.paidAt,
        reconciledAt: w.reconciledAt,
        campaign: w.campaign,
        needsReconciliation: w.status === 'PAID' && w.reconciledAt === null,
        missingEvidence: w.status === 'PAID' && w.evidenceUrl === null && w.payoutProviderTxnId === null,
      })),
    };
  }

  // ---- 4. ledger integrity ---------------------------------------------------

  /**
   * Read-only integrity sweep. NEVER auto-fixes anything — it only reports.
   *
   * Checks:
   *  (a) every LedgerTransaction sums DEBIT == CREDIT per currency (full scan,
   *      cursor-batched at 500 transactions; violating references capped at 50);
   *  (b) campaign liability ledger balance vs raisedAmount minus withdrawal
   *      aggregates — see the derivation comment below;
   *  (c) donation.totalCharged === amount + tipAmount for SUCCEEDED rows;
   *  (d) ledger transaction count vs distinct references (informational; the
   *      DB unique constraint makes drift impossible, so it mostly proves the
   *      check itself ran over consistent data).
   */
  async ledgerIntegrity() {
    const checkedAt = new Date();

    // (a) Unbalanced transactions: full cursor scan of transactions+entries.
    const unbalancedTxns: string[] = [];
    let transactionsChecked = 0;
    let cursor: string | undefined;
    for (;;) {
      const txns = await this.prisma.ledgerTransaction.findMany({
        take: SCAN_PAGE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          reference: true,
          entries: { select: { direction: true, amount: true, currency: true } },
        },
      });
      if (txns.length === 0) break;
      cursor = txns[txns.length - 1].id;
      for (const txn of txns) {
        transactionsChecked += 1;
        const sums = new Map<string, { debit: bigint; credit: bigint }>();
        for (const entry of txn.entries) {
          const acc = sums.get(entry.currency) ?? { debit: 0n, credit: 0n };
          if (entry.direction === LedgerDirection.DEBIT) acc.debit += entry.amount;
          else acc.credit += entry.amount;
          sums.set(entry.currency, acc);
        }
        const unbalanced = [...sums.values()].some((s) => s.debit !== s.credit);
        if (unbalanced && unbalancedTxns.length < MAX_VIOLATIONS) unbalancedTxns.push(txn.reference);
      }
      if (txns.length < SCAN_PAGE) break;
    }

    // (b) Campaign liability check.
    //
    // DERIVATION (kept in sync with LedgerService postings):
    //   Campaign ledger account (LIABILITY, credit-positive):
    //     CREDIT donation.amount         on success (postDonationSuccess)
    //     CREDIT match.matchedAmount     on match   (postMatch)
    //     DEBIT  withdrawal.amount GROSS when PAID  (postWithdrawal — the
    //          platform fee portion is recognised as platform revenue, so the
    //          campaign liability falls by the GROSS amount, not the net)
    //     DEBIT  refund campaignPart     on refund  (postRefund)
    //     DEBIT  match reversal amount   on refund  (postMatchReversal)
    //   raisedAmount counter (donation-payment.service / refund-processor):
    //     + (donation.amount + matchedAmount) on success
    //     - (campaignPart + matchedAmount)    on refund (GUARDED decrement that
    //          may silently fail — exactly the drift this check exists to catch)
    //   => healthy identity: ledgerBalance == raisedAmount - Σ(PAID amount GROSS)
    //   In-flight (reserved) withdrawals are NOT yet posted to the ledger, so
    //   their money is still inside ledgerBalance and MUST NOT be subtracted
    //   from raisedAmount (that would false-positive every campaign with a
    //   pending payout). Because paid fees go to platform revenue, paid NET is
    //   intentionally NOT used here either — the comparison uses paid GROSS.
    //   Formula: expectedMinor = raisedAmount - paidGrossTotal (tolerance 0).
    const campaignAccounts = await this.prisma.ledgerAccount.findMany({
      where: { code: { startsWith: ACCOUNT_PREFIXES.campaign }, campaignId: { not: null } },
      select: { id: true, campaignId: true, currency: true },
    });
    const balances = await this.accountBalances(campaignAccounts.map((a) => a.id));
    const ledgerByCampaign = new Map<string, { currency: string; balance: bigint }>();
    for (const account of campaignAccounts) {
      if (!account.campaignId) continue;
      const existing = ledgerByCampaign.get(account.campaignId);
      const balance = balances.get(account.id) ?? 0n;
      if (existing) existing.balance += balance;
      else ledgerByCampaign.set(account.campaignId, { currency: account.currency, balance });
    }

    const withdrawalGroups = await this.prisma.withdrawal.groupBy({
      by: ['campaignId', 'status'],
      where: { status: 'PAID' },
      _sum: { amount: true },
    });
    const paidGrossByCampaign = new Map<string, bigint>();
    for (const g of withdrawalGroups) {
      if (g.status === 'PAID') {
        paidGrossByCampaign.set(g.campaignId, (paidGrossByCampaign.get(g.campaignId) ?? 0n) + (g._sum.amount ?? 0n));
      }
    }

    const campaigns = await this.prisma.campaign.findMany({
      where: { id: { in: [...ledgerByCampaign.keys()] } },
      select: { id: true, currency: true, raisedAmount: true },
    });

    const campaignMismatches: { campaignId: string; currency: string; ledgerBalanceMinor: bigint; expectedMinor: bigint }[] = [];
    for (const campaign of campaigns) {
      const ledger = ledgerByCampaign.get(campaign.id);
      if (!ledger) continue;
      const paidGross = paidGrossByCampaign.get(campaign.id) ?? 0n;
      // See derivation above: reserved withdrawals stay inside the ledger
      // balance (never subtracted here) and paid GROSS — not paid NET —
      // leaves it (the fee portion is booked to platform revenue).
      const expectedMinor = campaign.raisedAmount - paidGross;
      if (ledger.balance !== expectedMinor && campaignMismatches.length < MAX_VIOLATIONS) {
        campaignMismatches.push({
          campaignId: campaign.id,
          currency: ledger.currency || campaign.currency,
          ledgerBalanceMinor: ledger.balance,
          expectedMinor,
        });
      }
    }

    // (c) SUCCEEDED donations must satisfy totalCharged === amount + tipAmount.
    const chargeMismatches: string[] = [];
    let donationCursor: string | undefined;
    for (;;) {
      const donations = await this.prisma.donation.findMany({
        where: { status: DonationStatus.SUCCEEDED },
        take: SCAN_PAGE,
        orderBy: { id: 'asc' },
        ...(donationCursor ? { cursor: { id: donationCursor }, skip: 1 } : {}),
        select: { id: true, publicRef: true, amount: true, tipAmount: true, totalCharged: true },
      });
      if (donations.length === 0) break;
      donationCursor = donations[donations.length - 1].id;
      for (const donation of donations) {
        const expected = donation.amount + donation.tipAmount;
        if (donation.totalCharged !== expected && chargeMismatches.length < MAX_VIOLATIONS) {
          chargeMismatches.push(donation.publicRef);
        }
      }
      if (donations.length < SCAN_PAGE) break;
    }

    // (d) Transaction count vs distinct references.
    const referenceGroups = await this.prisma.ledgerTransaction.groupBy({ by: ['reference'], _count: { _all: true } });
    const uniqueReferences = referenceGroups.length;
    const totalReferences = referenceGroups.reduce((n, g) => n + g._count._all, 0);
    const referencesConsistent = uniqueReferences === totalReferences;

    return {
      checkedAt,
      transactionsChecked,
      violations: {
        unbalancedTxns,
        campaignMismatches,
        chargeMismatches,
        referenceStats: { transactions: totalReferences, uniqueReferences, consistent: referencesConsistent },
      },
      ok: unbalancedTxns.length === 0 && campaignMismatches.length === 0 && chargeMismatches.length === 0 && referencesConsistent,
    };
  }

  // ---- 5. CSV reports --------------------------------------------------------

  private toCsv(header: string[], rows: (string | number | bigint | null | undefined)[][]): string {
    const lines = ['# minor units', header.map(csvEscape).join(',')];
    for (const row of rows) {
      lines.push(row.map((cell) => csvEscape(cell === null || cell === undefined ? '' : String(cell))).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  private dayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private reportFilename(type: ReportType): string {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `kindora-${type}-${stamp}.csv`;
  }

  private async buildDailyClosingCsv(): Promise<string> {
    // Last 30 days, per currency per day. Donation metrics bucketed by
    // donation.createdAt; platform revenue bucketed by ledger postedAt.
    const to = new Date();
    const from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);

    const [donations, revenueEntries] = await Promise.all([
      this.prisma.donation.findMany({
        where: {
          createdAt: { gte: from, lte: to },
          status: { in: [DonationStatus.SUCCEEDED, DonationStatus.REFUNDED, DonationStatus.PARTIALLY_REFUNDED] },
        },
        select: { createdAt: true, currency: true, amount: true, tipAmount: true, providerFeeMinor: true, status: true },
      }),
      this.prisma.ledgerEntry.findMany({
        where: {
          account: { code: { startsWith: ACCOUNT_PREFIXES.platformRevenue } },
          transaction: { postedAt: { gte: from, lte: to } },
        },
        select: { amount: true, currency: true, direction: true, transaction: { select: { postedAt: true } } },
      }),
    ]);

    interface DayRow {
      succeededCount: number;
      succeededAmountMinor: bigint;
      tipsMinor: bigint;
      refundedCount: number;
      refundedAmountMinor: bigint;
      feesMinor: bigint;
      platformRevenueMinor: bigint;
    }
    const days = new Map<string, DayRow>();
    const blank = (): DayRow => ({
      succeededCount: 0,
      succeededAmountMinor: 0n,
      tipsMinor: 0n,
      refundedCount: 0,
      refundedAmountMinor: 0n,
      feesMinor: 0n,
      platformRevenueMinor: 0n,
    });
    const key = (day: string, currency: string) => `${day}|${currency}`;

    for (const donation of donations) {
      const k = key(this.dayKey(donation.createdAt), donation.currency);
      const row = days.get(k) ?? blank();
      if (donation.status === DonationStatus.SUCCEEDED) {
        row.succeededCount += 1;
        row.succeededAmountMinor += donation.amount;
        row.tipsMinor += donation.tipAmount;
        row.feesMinor += donation.providerFeeMinor ?? 0n;
      } else {
        row.refundedCount += 1;
        row.refundedAmountMinor += donation.amount;
      }
      days.set(k, row);
    }
    for (const entry of revenueEntries) {
      const k = key(this.dayKey(entry.transaction.postedAt), entry.currency);
      const row = days.get(k) ?? blank();
      // Revenue account: credits increase revenue, refund reversals (debits) reduce it.
      row.platformRevenueMinor += entry.direction === LedgerDirection.CREDIT ? entry.amount : -entry.amount;
      days.set(k, row);
    }

    const sortedKeys = [...days.keys()].sort();
    return this.toCsv(
      ['day', 'currency', 'succeededCount', 'succeededAmountMinor', 'tipsMinor', 'refundedCount', 'refundedAmountMinor', 'providerFeesMinor', 'platformRevenueMinor'],
      sortedKeys.map((k) => {
        const [day, currency] = k.split('|');
        const row = days.get(k) as DayRow;
        return [
          day,
          currency,
          row.succeededCount,
          row.succeededAmountMinor,
          row.tipsMinor,
          row.refundedCount,
          row.refundedAmountMinor,
          row.feesMinor,
          row.platformRevenueMinor,
        ];
      }),
    );
  }

  private async buildCampaignBalancesCsv(): Promise<string> {
    // Campaign balances: raisedAmount (denormalised counter) vs the ledger
    // liability, withdrawal reservations and paid payouts. Derived formula:
    //   ledgerBalance = raisedAmount - paidGross   (see ledgerIntegrity derivation)
    //   derivedAvailableMinor = ledgerBalance - reservedGross (what organizers
    //   may still request; matches LedgerService.campaignAvailableBalance).
    const [campaignAccounts, withdrawalGroups, campaigns] = await Promise.all([
      this.prisma.ledgerAccount.findMany({
        where: { code: { startsWith: ACCOUNT_PREFIXES.campaign }, campaignId: { not: null } },
        select: { id: true, campaignId: true, currency: true },
      }),
      this.prisma.withdrawal.groupBy({
        by: ['campaignId', 'status'],
        where: { status: { in: ['PAID', ...RESERVED_WITHDRAWAL_STATUSES] } },
        _sum: { amount: true, netAmount: true },
      }),
      this.prisma.campaign.findMany({
        where: { OR: [{ donations: { some: {} } }, { withdrawals: { some: {} } }] },
        select: { id: true, title: true, slug: true, currency: true, raisedAmount: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const balances = await this.accountBalances(campaignAccounts.map((a) => a.id));

    const ledgerByCampaign = new Map<string, bigint>();
    for (const account of campaignAccounts) {
      if (!account.campaignId) continue;
      ledgerByCampaign.set(account.campaignId, (ledgerByCampaign.get(account.campaignId) ?? 0n) + (balances.get(account.id) ?? 0n));
    }
    const reservedByCampaign = new Map<string, bigint>();
    const paidNetByCampaign = new Map<string, bigint>();
    for (const g of withdrawalGroups) {
      if (g.status === 'PAID') {
        paidNetByCampaign.set(g.campaignId, (paidNetByCampaign.get(g.campaignId) ?? 0n) + (g._sum.netAmount ?? 0n));
      } else {
        reservedByCampaign.set(g.campaignId, (reservedByCampaign.get(g.campaignId) ?? 0n) + (g._sum.amount ?? 0n));
      }
    }

    const rows = campaigns.map((c) => {
      const ledgerBalance = ledgerByCampaign.get(c.id) ?? 0n;
      const reserved = reservedByCampaign.get(c.id) ?? 0n;
      return [
        c.slug,
        c.title,
        c.currency,
        c.raisedAmount,
        ledgerBalance,
        reserved,
        paidNetByCampaign.get(c.id) ?? 0n,
        ledgerBalance - reserved,
      ];
    });
    return this.toCsv(
      ['campaign', 'title', 'currency', 'raisedAmountMinor', 'ledgerBalanceMinor', 'reservedMinor', 'paidNetMinor', 'derivedAvailableMinor'],
      rows,
    );
  }

  private async buildWithdrawalsCsv(): Promise<string> {
    // Full withdrawal export including payout metadata (cursor-batched).
    const header = [
      'id', 'publicRef', 'campaign', 'status', 'currency', 'amountMinor', 'feeAmountMinor', 'netAmountMinor',
      'method', 'payoutProvider', 'providerTransferRef', 'payoutProviderTxnId', 'evidenceUrl',
      'createdAt', 'paidAt', 'reconciledAt',
    ];
    const lines: string[] = ['# minor units', header.map(csvEscape).join(',')];
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.withdrawal.findMany({
        take: SCAN_PAGE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, publicRef: true, status: true, currency: true, amount: true, feeAmount: true, netAmount: true,
          method: true, payoutProvider: true, providerTransferRef: true, payoutProviderTxnId: true, evidenceUrl: true,
          createdAt: true, paidAt: true, reconciledAt: true,
          campaign: { select: { slug: true } },
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const w of rows) {
        lines.push(
          [
            w.id, w.publicRef, w.campaign.slug, w.status, w.currency, w.amount, w.feeAmount, w.netAmount,
            w.method, w.payoutProvider, w.providerTransferRef, w.payoutProviderTxnId, w.evidenceUrl,
            w.createdAt.toISOString(), w.paidAt?.toISOString() ?? '', w.reconciledAt?.toISOString() ?? '',
          ]
            .map((cell) => csvEscape(cell === null || cell === undefined ? '' : String(cell)))
            .join(','),
        );
      }
      if (rows.length < SCAN_PAGE) break;
    }
    return `${lines.join('\n')}\n`;
  }

  private async buildRefundsCsv(): Promise<string> {
    const header = ['id', 'donationPublicRef', 'currency', 'amountMinor', 'status', 'providerRef', 'reason', 'createdAt', 'processedAt'];
    const lines: string[] = ['# minor units', header.map(csvEscape).join(',')];
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.refund.findMany({
        take: SCAN_PAGE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, amount: true, status: true, providerRef: true, reason: true, createdAt: true, processedAt: true,
          donation: { select: { publicRef: true, currency: true } },
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const r of rows) {
        lines.push(
          [
            r.id, r.donation.publicRef, r.donation.currency, r.amount, r.status, r.providerRef, r.reason,
            r.createdAt.toISOString(), r.processedAt?.toISOString() ?? '',
          ]
            .map((cell) => csvEscape(cell === null || cell === undefined ? '' : String(cell)))
            .join(','),
        );
      }
      if (rows.length < SCAN_PAGE) break;
    }
    return `${lines.join('\n')}\n`;
  }

  private async buildPlatformFeesCsv(): Promise<string> {
    // Verified provider processing fees for SUCCEEDED donations.
    const header = ['donationPublicRef', 'provider', 'currency', 'providerFeeMinor', 'createdAt', 'succeededAt'];
    const lines: string[] = ['# minor units', header.map(csvEscape).join(',')];
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.donation.findMany({
        where: { status: DonationStatus.SUCCEEDED, providerFeeMinor: { not: null } },
        take: SCAN_PAGE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, publicRef: true, provider: true, currency: true, providerFeeMinor: true, createdAt: true, succeededAt: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const d of rows) {
        lines.push(
          [d.publicRef, d.provider, d.currency, d.providerFeeMinor ?? 0n, d.createdAt.toISOString(), d.succeededAt?.toISOString() ?? '']
            .map((cell) => csvEscape(cell === null || cell === undefined ? '' : String(cell)))
            .join(','),
        );
      }
      if (rows.length < SCAN_PAGE) break;
    }
    return `${lines.join('\n')}\n`;
  }

  /** Streams a CSV report. The admin actor is recorded in the audit log. */
  async buildReport(type: ReportType): Promise<string> {
    switch (type) {
      case 'daily-closing':
        return this.buildDailyClosingCsv();
      case 'campaign-balances':
        return this.buildCampaignBalancesCsv();
      case 'withdrawals':
        return this.buildWithdrawalsCsv();
      case 'refunds':
        return this.buildRefundsCsv();
      case 'platform-fees':
        return this.buildPlatformFeesCsv();
    }
  }

  async recordReportExport(type: ReportType, admin: { id: string }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'REPORT_EXPORTED',
        entityType: 'REPORT',
        entityId: type,
        metadata: { type, format: 'csv' },
      },
    });
  }

  reportFilenameFor(type: ReportType): string {
    return this.reportFilename(type);
  }

  // ---- 6. audit history ------------------------------------------------------

  async listAudit(query: { page: number; limit: number; action?: string }) {
    const page = Math.max(1, query.page);
    const limit = Math.min(100, Math.max(1, query.limit));
    const where: Prisma.AuditLogWhereInput = query.action ? { action: query.action } : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          ip: true,
          createdAt: true,
          actor: { select: { email: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    return { total, page, pageSize: limit, items };
  }

  parseReportType(raw: string): ReportType {
    // Accept both /reports/daily-closing and /reports/daily-closing.csv.
    const normalized = raw.endsWith('.csv') ? raw.slice(0, -'.csv'.length) : raw;
    if (!(REPORT_TYPES as readonly string[]).includes(normalized)) {
      throw new BadRequestException(`Unknown report type "${normalized}". Allowed: ${REPORT_TYPES.join(', ')}`);
    }
    return normalized as ReportType;
  }
}
