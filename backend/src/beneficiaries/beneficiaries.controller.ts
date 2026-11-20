import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { BeneficiariesService } from './beneficiaries.service';
import { CreateBeneficiaryDto, UpdateBeneficiaryDto } from './dto/beneficiaries.dto';

@Controller('beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Post()
  async create(@Body() dto: CreateBeneficiaryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.beneficiaries.create(dto, user.id);
  }

  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.beneficiaries.listMine(user.id, pagination.skip, pagination.limit);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBeneficiaryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.beneficiaries.update(id, dto, user);
  }
}
