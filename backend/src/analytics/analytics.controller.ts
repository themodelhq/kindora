import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { RecomputeDayDto } from './dto/analytics.dto';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Roles('ADMIN')
  @Get('platform')
  async platform() {
    return this.analytics.platform();
  }

  /** 14-day per-campaign series incl. daily revenue (owner/admin). */
  @Get('campaign/:id')
  async campaign(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.analytics.campaignAnalytics(id, user);
  }

  /** Aggregated stats across all campaigns owned/managed by the caller. */
  @Get('organizer')
  async organizer(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.organizerSummary(user.id);
  }

  @Roles('ADMIN')
  @Post('recompute-day')
  async recomputeDay(@Body() dto: RecomputeDayDto) {
    return this.analytics.recomputeDay(dto);
  }
}
