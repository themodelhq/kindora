import { Body, Controller, Get, Headers, Ip, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { DonationsService } from './donations.service';
import { CreateDonationDto } from './dto/create-donation.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PrismaService } from '../common/prisma.service';

@Controller('donations')
export class DonationsController {
  constructor(
    private readonly donations: DonationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  async create(
    @Body() dto: CreateDonationDto,
    @CurrentUser() user: AuthenticatedUser | null,
    @Ip() ip: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.donations.create(dto, user, { ip, idempotencyKey });
  }

  @Public()
  @Get('status/:provider/:publicRef')
  async status(@Param('provider') provider: string, @Param('publicRef') publicRef: string) {
    const valid = ['PAYSTACK', 'FLUTTERWAVE', 'STRIPE', 'PAYPAL'];
    if (!valid.includes(provider.toUpperCase())) throw new NotFoundException('Unknown provider');
    return this.donations.verifyStatus(provider.toUpperCase() as never, publicRef);
  }

  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.donations.listMine(user.id, pagination.skip, pagination.limit);
  }

  @Public()
  @Get('campaigns/:slug/donors')
  async donors(@Param('slug') slug: string, @Query() pagination: PaginationDto) {
    const campaign = await this.prisma.campaign.findUnique({ where: { slug }, select: { id: true } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return this.donations.listCampaignDonors(campaign.id, pagination.skip, pagination.limit);
  }

  @Public()
  @Get(':publicRef')
  async get(@Param('publicRef') publicRef: string) {
    return this.donations.getDonation(publicRef);
  }
}
