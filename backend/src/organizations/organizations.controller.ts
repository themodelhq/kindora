import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { OrganizationsService } from './organizations.service';
import {
  AddOrganizationMemberDto,
  CreateOrganizationDto,
  CreatePayoutMethodDto,
  UpdateOrganizationDto,
} from './dto/create-organization.dto';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  async create(@Body() dto: CreateOrganizationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.organizations.create(dto, user);
  }

  @Public()
  @Get()
  async list(@Query() pagination: PaginationDto) {
    return this.organizations.listPublic(pagination);
  }

  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listMine(user);
  }

  @Public()
  @Get(':slug')
  async getBySlug(@Param('slug') slug: string, @CurrentUser() user: AuthenticatedUser | null) {
    return this.organizations.getBySlug(slug, user);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizations.update(id, dto, user);
  }

  @Post(':id/members')
  async addMember(
    @Param('id') id: string,
    @Body() dto: AddOrganizationMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizations.addMember(id, dto, user);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizations.removeMember(id, userId, user);
  }

  @Post(':id/verify-request')
  async requestVerification(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.organizations.requestVerification(id, user);
  }

  @Get(':id/payout-methods')
  async listPayoutMethods(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listPayoutMethods(id, user);
  }

  @Post(':id/payout-methods')
  async createPayoutMethod(
    @Param('id') id: string,
    @Body() dto: CreatePayoutMethodDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.organizations.createPayoutMethod(id, dto, user);
  }
}
