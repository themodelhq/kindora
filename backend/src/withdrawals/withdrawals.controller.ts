import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { MfaFreshGuard, MfaPurpose, RequireMfa } from '../mfa/mfa-fresh.guard';
import { WithdrawalsService } from './withdrawals.service';
import {
  CreateWithdrawalDto,
  ExecutePayoutDto,
  ReconcileDto,
  RequireInfoDto,
  ResolveReviewCaseDto,
  RetryPayoutDto,
  SettlePayoutDto,
  UpdateDestinationDto,
  WithdrawalReviewDto,
} from './dto/withdrawal.dto';

/**
 * Withdrawal routes (v1.0.4).
 *
 * REMOVED legacy payout-state manipulation endpoints (§3):
 *   POST /:id/mark-paid        -> replaced by POST /:id/settle (evidence file + dual approval + MFA)
 *   POST /:id/mark-processing  -> replaced by PayoutService attempt registry (POST /:id/settle or /:id/retry)
 *   POST /:id/mark-failed      -> FORBIDDEN: only authoritative provider verification may fail a transfer
 *
 * Every administrator state-changing route requires FRESH MFA (§7): a
 * single-use challenge token bound to (purpose, withdrawal) in the
 * `x-mfa-challenge` header. Read-only routes use normal admin authorization.
 */
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Post()
  async create(@Body() dto: CreateWithdrawalDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.request(dto, user);
  }

  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.withdrawals.listMine(user, pagination.skip, pagination.limit);
  }

  /** Available balance of a campaign the caller manages (403 otherwise). */
  @Get('available/:campaignId')
  async available(@Param('campaignId') campaignId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.availableBalance(campaignId, user);
  }

  // ---- Admin ---------------------------------------------------------------

  @Roles('ADMIN')
  @Get('admin/all')
  async adminList(@Query('status') status?: string, @Query() pagination?: PaginationDto) {
    return this.withdrawals.adminList(status, pagination?.skip ?? 0, pagination?.limit ?? 20);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_STATE_CHANGE)
  @Post(':id/under-review')
  underReview(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.markUnderReview(id, user);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_STATE_CHANGE)
  @Post(':id/require-info')
  requireInfo(@Param('id') id: string, @Body() dto: RequireInfoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.requireInfo(id, user, dto.note);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_FIRST_APPROVAL)
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.approve(id, user);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_SECOND_APPROVAL)
  @Post(':id/second-approval')
  secondApproval(@Param('id') id: string, @Body() dto: WithdrawalReviewDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.secondApproval(id, user, dto.note);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_STATE_CHANGE)
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() dto: WithdrawalReviewDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.reject(id, user, dto.note);
  }

  /**
   * v1.0.7 §8 — EXECUTE the payout via a real provider transfer (Paystack /
   * Flutterwave). Requires fresh PAYOUT_EXECUTION MFA. Separation of duties,
   * approval-snapshot binding and beneficiary validation are enforced in the
   * backend initiation pipeline BEFORE any provider call.
   */
  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_EXECUTION)
  @Post(':id/execute')
  execute(@Param('id') id: string, @Body() dto: ExecutePayoutDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.executePayout(id, user, dto);
  }

  /**
   * v1.0.7 §5.4 — update the payout destination. Bumps the destination
   * version and invalidates approvals + beneficiaries; fresh approvals are
   * required before execution.
   */
  @Post(':id/destination')
  updateDestination(@Param('id') id: string, @Body() dto: UpdateDestinationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.updateDestination(id, user, dto);
  }

  /** v1.0.7 §9 — manual review case list (read-only). */
  @Roles('ADMIN')
  @Get('review-cases')
  listReviewCases(@Query('status') status?: 'OPEN' | 'RESOLVED', @Query() pagination?: PaginationDto) {
    return this.withdrawals.listReviewCases(status, pagination?.skip ?? 0, pagination?.limit ?? 50);
  }

  /** v1.0.7 §9 — manual review case detail (read-only). */
  @Roles('ADMIN')
  @Get('review-cases/:caseId')
  getReviewCase(@Param('caseId') caseId: string) {
    return this.withdrawals.getReviewCase(caseId);
  }

  /**
   * v1.0.7 §9 — resolve a manual review case. Requires fresh
   * PAYOUT_MANUAL_REVIEW MFA. Resolution can NEVER settle a payout by itself:
   * success confirmations additionally require an evidence file and an
   * independent reviewer, and settlement still flows through verification or
   * the controlled manual-settlement path.
   */
  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_MANUAL_REVIEW)
  @Post('review-cases/:caseId/resolve')
  resolveReviewCase(@Param('caseId') caseId: string, @Body() dto: ResolveReviewCaseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.resolveReviewCase(caseId, user, dto);
  }

  /**
   * MANUAL SETTLEMENT — replaces the legacy mark-paid endpoint. Requires
   * fresh MFA (PAYOUT_SETTLEMENT), dual approval separation, a registered
   * private evidence file and a provider transfer reference.
   */
  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_SETTLEMENT)
  @Post(':id/settle')
  settle(@Param('id') id: string, @Body() dto: SettlePayoutDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.confirmSettlement(id, user, dto);
  }

  /**
   * Safe retry (PAYOUT_RETRY MFA). Only possible from FAILED with no
   * unresolved attempt — enforced again in PayoutService.
   */
  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_RETRY)
  @Post(':id/retry')
  retry(@Param('id') id: string, @Body() dto: RetryPayoutDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.retryPayout(id, user, dto);
  }

  /** Authoritative provider verification of a payout attempt (reconciliation execution MFA). */
  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_RECONCILIATION)
  @Post('attempts/:attemptId/verify')
  verifyAttempt(@Param('attemptId') attemptId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.verifyPayoutAttempt(attemptId, user);
  }

  @Roles('ADMIN')
  @UseGuards(MfaFreshGuard)
  @RequireMfa(MfaPurpose.PAYOUT_RECONCILIATION)
  @Post(':id/reconcile')
  reconcile(@Param('id') id: string, @Body() dto: ReconcileDto, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.reconcile(id, user, dto.evidenceFileId, dto.note);
  }

  /** Short-lived, audited evidence access (§10.4). Normal admin auth (read-only). */
  @Roles('ADMIN')
  @Get(':id/evidence-url')
  evidenceUrl(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.getEvidenceUrl(id, user);
  }

  /** Withdrawal detail — ownership enforced; bank details masked unless entitled. */
  @Get(':id')
  async getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.getOne(id, user);
  }

  /** Requester cancels a pending request. */
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.withdrawals.cancel(id, user);
  }
}
