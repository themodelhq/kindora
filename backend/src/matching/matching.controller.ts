import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { MatchingService } from './matching.service';
import { CreateMatchingPoolDto } from './dto/create-matching-pool.dto';

@Controller()
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Post('campaigns/:id/matching-pools')
  async createPool(
    @Param('id') id: string,
    @Body() dto: CreateMatchingPoolDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.matching.createPool(id, dto, user);
  }

  @Public()
  @Get('campaigns/:slug/matching-pools')
  async listForCampaign(@Param('slug') slug: string) {
    return this.matching.listForCampaign(slug);
  }

  @Get('matching/pools/mine')
  async mine(@CurrentUser() user: AuthenticatedUser) {
    return this.matching.listMine(user.id);
  }
}
