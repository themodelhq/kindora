import { Body, Controller, UseGuards, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CampaignStatus, KycStatus } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { MfaFreshGuard, MfaPurpose, RequireMfa } from '../mfa/mfa-fresh.guard';
import { AdminService } from './admin.service';
import { StorageService } from '../storage/storage.service';

const CAMPAIGN_STATUSES: string[] = Object.values(CampaignStatus) as string[];
const KYC_STATUSES: string[] = Object.values(KycStatus) as string[];

class AdminCampaignQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(CAMPAIGN_STATUSES)
  status?: string;
}

class AdminKycQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(KYC_STATUSES)
  status?: string;
}

class OptionalNoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

class RequiredNoteDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note: string;
}

class RefundRequestDto {
  @IsString()
  donationRef: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

class KycReviewDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly storage: StorageService,
  ) {}

  @Get('stats')
  async stats() {
    return this.admin.stats();
  }

  @Get('campaigns')
  async listCampaigns(@Query() query: AdminCampaignQueryDto) {
    return this.admin.listCampaigns(query);
  }

  @Post('campaigns/:id/approve')
  async approveCampaign(
    @Param('id') id: string,
    @Body() dto: OptionalNoteDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.admin.approveCampaign(id, admin, dto.note);
  }

  @Post('campaigns/:id/reject')
  async rejectCampaign(
    @Param('id') id: string,
    @Body() dto: RequiredNoteDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.admin.rejectCampaign(id, admin, dto.note);
  }

  @Post('campaigns/:id/suspend')
  async suspendCampaign(
    @Param('id') id: string,
    @Body() dto: OptionalNoteDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.admin.suspendCampaign(id, admin, dto.note);
  }

  @Post('campaigns/:id/feature')
  async featureCampaign(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.admin.featureCampaign(id, admin, true);
  }

  @Post('campaigns/:id/unfeature')
  async unfeatureCampaign(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.admin.featureCampaign(id, admin, false);
  }

  @Get('users')
  async listUsers(@Query() query: PaginationDto) {
    return this.admin.listUsers(query);
  }

  @Post('users/:id/suspend')
  async suspendUser(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.admin.suspendUser(id, admin);
  }

  @Post('users/:id/activate')
  async activateUser(@Param('id') id: string, @CurrentUser() admin: AuthenticatedUser) {
    return this.admin.activateUser(id, admin);
  }

  @Get('transactions')
  async listTransactions(@Query() query: PaginationDto) {
    return this.admin.listTransactions(query);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.REFUND_EXECUTION, 'body.donationRef')
  @Post('refunds')
  async refund(@Body() dto: RefundRequestDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.admin.refund(dto, admin);
  }

  @Get('kyc')
  async listKyc(@Query() query: AdminKycQueryDto) {
    return this.admin.listKyc(query);
  }

  @Post('kyc/:id/review')
  async reviewKyc(
    @Param('id') id: string,
    @Body() dto: KycReviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.admin.reviewKyc(id, admin, dto);
  }

  /**
   * Reviewer access to a verification document by file id. Signed URL is
   * issued only to ADMIN callers and every access is audited
   * (PRIVILEGED_DOCUMENT_ACCESS) with actor, file, owner and context.
   */
  @Roles('ADMIN')
  @Get('files/:id/download-url')
  async fileDownloadUrl(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.storage.adminSignUrl(id, user);
  }

  @Get('reconciliation')
  async reconciliation() {
    return this.admin.reconciliation();
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_RECONCILIATION, null)
  @Post('reconciliation/run')
  async runReconciliation(@CurrentUser() admin: AuthenticatedUser) {
    return this.admin.runReconciliation(admin);
  }
}
