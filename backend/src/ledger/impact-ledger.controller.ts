import { Controller, ForbiddenException, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../common/prisma.service';
import { LedgerService, LEDGER_CODES } from './ledger.service';
import { PaginationDto } from '../common/dto/pagination.dto';

/**
 * Public transparency endpoints backed by the double-entry ledger.
 * Donor identities and internal account details are never exposed here.
 */
@Controller('impact')
export class ImpactLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('summary')
  async summary() {
    const [succeeded, refunded, tips, recentDaily, ledger] = await this.prisma.$transaction(async (tx) => {
      const succeeded = await tx.donation.aggregate({ where: { status: 'SUCCEEDED' }, _count: true });
      const refunded = await tx.donation.count({ where: { status: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } } });
      const tips = await tx.donation.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { tipAmount: true } });
      const recentDaily = await tx.platformStatDaily.findMany({ orderBy: { date: 'desc' }, take: 30 });
      return [succeeded, refunded, tips, recentDaily, null];
    });
    const ledgerStats = await this.ledger.platformSummary();
    return {
      totalDonations: succeeded._count,
      totalRefunded: refunded,
      totalTipsMinor: (tips._sum.tipAmount ?? 0n).toString(),
      ledger: ledgerStats,
      recentDaily,
    };
  }

  @Public()
  @Get('transactions')
  async transactions(@Query() pagination: PaginationDto) {
    const { skip, limit } = pagination;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.ledgerTransaction.count(),
      this.prisma.ledgerTransaction.findMany({
        orderBy: { postedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          reference: true,
          type: true,
          description: true,
          postedAt: true,
          entries: { select: { direction: true, amount: true, currency: true } },
        },
      }),
    ]);
    return { total, items };
  }

  @Public()
  @Get('campaigns/:slug')
  async campaignLedger(@Param('slug') slug: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { slug },
      select: { id: true, title: true, currency: true, raisedAmount: true, targetAmount: true, status: true },
    });
    if (!campaign || campaign.status === 'DRAFT') throw new NotFoundException('Campaign not found');

    const account = await this.prisma.ledgerAccount.findUnique({
      where: { code: LEDGER_CODES.campaign(campaign.id, campaign.currency) },
    });
    if (!account) throw new ForbiddenException('No ledger activity for this campaign yet');

    const balance = await this.ledger.accountBalance(account.code);
    const [entries, paidWithdrawals] = await this.prisma.$transaction([
      this.prisma.ledgerEntry.findMany({
        where: { account: { campaignId: campaign.id } },
        take: 200,
        orderBy: { id: 'desc' },
        select: {
          direction: true,
          amount: true,
          currency: true,
          transaction: { select: { type: true, postedAt: true, description: true } },
        },
      }),
      this.prisma.withdrawal.findMany({
        where: { campaignId: campaign.id, status: 'PAID' },
        select: { publicRef: true, netAmount: true, paidAt: true },
        orderBy: { paidAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      campaign: {
        title: campaign.title,
        currency: campaign.currency,
        raisedAmount: campaign.raisedAmount.toString(),
        targetAmount: campaign.targetAmount.toString(),
      },
      balanceMinor: balance.toString(),
      entries,
      paidWithdrawals,
    };
  }
}
