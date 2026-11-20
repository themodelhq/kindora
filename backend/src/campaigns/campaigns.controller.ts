import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { CampaignQueryDto, CreateCampaignUpdateDto } from './dto/campaign-query.dto';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Public()
  @Get()
  async list(@Query() query: CampaignQueryDto) {
    return this.campaigns.list(query);
  }

  // NOTE: static routes ('categories', 'mine', 'by-id') must be declared before ':slug'.

  @Public()
  @Get('categories')
  async categories() {
    return this.campaigns.categories();
  }

  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.campaigns.mine(user.id, pagination.skip, pagination.limit);
  }

  /** Raw campaign (incl. matching pools + media) for owner dashboards. */
  @Get('by-id/:id')
  async byId(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.byId(id, user);
  }

  @Post()
  async create(@Body() dto: CreateCampaignDto, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.create(dto, user);
  }

  @Public()
  @Get(':slug')
  async detail(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser | null) {
    return this.campaigns.detail(slug, user);
  }

  @Public()
  @Post(':slug/view')
  async view(@Param('slug') slug: string) {
    return this.campaigns.recordView(slug);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateCampaignDto, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.update(id, dto, user);
  }

  @Post(':id/submit')
  async submit(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.submit(id, user);
  }

  /** Owner-only pause toggle (ACTIVE -> PAUSED). */
  @Post(':id/pause')
  async pause(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.pause(id, user);
  }

  /** Owner-only resume toggle (PAUSED -> ACTIVE). */
  @Post(':id/resume')
  async resume(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.resume(id, user);
  }

  @Get(':id/analytics')
  async analytics(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.campaigns.analytics(id, user);
  }

  /** Organizer posts an update; donors are notified by email (queued). Identifier: id or slug. */
  @Post(':id/updates')
  async createUpdate(
    @Param('id') identifier: string,
    @Body() dto: CreateCampaignUpdateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.campaigns.createUpdate(identifier, dto, user);
  }

  @Public()
  @Get(':slug/updates')
  async updates(@Param('slug') slug: string, @Query() pagination: PaginationDto) {
    return this.campaigns.listUpdates(slug, pagination.skip, pagination.limit);
  }
}
