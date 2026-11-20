import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CirclesService } from './circles.service';
import { CreateCircleContributionDto, CreateCircleDto, JoinCircleDto, UpdateCircleDto } from './dto/create-circle.dto';

@Controller('circles')
export class CirclesController {
  constructor(private readonly circles: CirclesService) {}

  @Post()
  async create(@Body() dto: CreateCircleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.circles.create(dto, user);
  }

  @Public()
  @Get()
  async list(@Query() pagination: PaginationDto, @CurrentUser() user: AuthenticatedUser | null) {
    return this.circles.list(pagination, user);
  }

  // NOTE: must be declared before @Get(':slug') so 'mine' is not captured as a slug.
  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.circles.listMine(user, pagination.skip, pagination.limit);
  }

  @Public()
  @Get(':slug')
  async getBySlug(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser | null) {
    return this.circles.getBySlug(slug, user);
  }

  @Public()
  @Get(':slug/leaderboard')
  async leaderboard(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser | null) {
    return this.circles.leaderboard(slug, user);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCircleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.circles.update(id, dto, user);
  }

  @Post(':slug/join')
  async join(
    @Param('slug') slug: string,
    @Body() dto: JoinCircleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.circles.join(slug, dto, user);
  }

  @Post(':slug/contribute')
  async contribute(
    @Param('slug') slug: string,
    @Body() dto: CreateCircleContributionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.circles.contribute(slug, dto, user);
  }
}
