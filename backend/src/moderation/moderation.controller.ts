import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { ModerationService } from './moderation.service';
import { CreateReportDto, ResolveCaseDto } from './dto/moderation.dto';

@Controller()
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Post('reports')
  async report(@Body() dto: CreateReportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.moderation.report(dto, user.id);
  }

  // ---- Admin ---------------------------------------------------------------

  @Roles('ADMIN')
  @Get('moderation/admin/cases')
  async cases(@Query('status') status: string | undefined, @Query() pagination: PaginationDto) {
    return this.moderation.listCases(status, pagination.skip, pagination.limit);
  }

  @Roles('ADMIN')
  @Post('moderation/admin/cases/:id/resolve')
  async resolve(@Param('id') id: string, @Body() dto: ResolveCaseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.moderation.resolveCase(id, dto, user);
  }

  @Roles('ADMIN')
  @Get('moderation/admin/fraud-signals')
  async fraudSignals(@Query('status') status: string | undefined, @Query() pagination: PaginationDto) {
    return this.moderation.listFraudSignals(status, pagination.skip, pagination.limit);
  }

  @Roles('ADMIN')
  @Post('moderation/admin/fraud-signals/:id/dismiss')
  async dismiss(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.moderation.dismissFraudSignal(id, user);
  }
}
