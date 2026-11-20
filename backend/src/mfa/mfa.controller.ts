import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { MfaService, MfaPurpose } from './mfa.service';
import { MfaFreshGuard, MFA_METADATA_KEY, RequireMfa, type RequireMfaOptions } from './mfa-fresh.guard';
import { Reflector } from '@nestjs/core';

export class MfaEnrollDto {
  // Enrollment is keyed off the JWT identity; no body needed.
}

export class MfaConfirmDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code: string;
}

export class MfaChallengeDto {
  /** Purpose the caller wants to authorize (must match the protected endpoint). */
  @IsIn(Object.values(MfaPurpose) as string[])
  purpose: string;

  /**
   * Resource scope binding. For payout operations this MUST be the withdrawal
   * id; a challenge scoped to one withdrawal never authorizes another.
   */
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  scope?: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit TOTP code' })
  code: string;
}

/**
 * Fresh-MFA endpoints. Challenges are only useful to ADMIN accounts (they are
 * consumed by payout/refund step-up guards), so the routes are ADMIN-only.
 */
@Controller('mfa')
@Roles('ADMIN')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly reflector: Reflector,
  ) {}

  @Post('enroll')
  async enroll(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.enroll(user.id, user.email);
  }

  @Post('confirm')
  async confirm(@Body() dto: MfaConfirmDto, @CurrentUser() user: AuthenticatedUser) {
    return this.mfa.confirm(user.id, dto.code);
  }

  @Post('disable')
  async disable(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.disable(user.id);
  }

  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.status(user.id);
  }

  /** Exchange a current TOTP code for a single-use challenge token. */
  @UseGuards(MfaFreshGuard)
  @Post('challenge')
  async challenge(@Body() dto: MfaChallengeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.mfa.issueChallenge(user.id, dto.purpose as MfaPurpose, dto.code, dto.scope);
  }

  /** Introspection for the admin UI: which operations require fresh MFA. */
  @Get('policy')
  policy() {
    // The decorator metadata lives on handlers in other modules; this static
    // contract mirrors PAYOUT_STATE_MACHINE_V1.0.4.md / ADMIN_FRESH_MFA_POLICY.md.
    return {
      requiresFreshMfa: [
        'POST /withdrawals/:id/approve',
        'POST /withdrawals/:id/second-approval',
        'POST /withdrawals/:id/under-review',
        'POST /withdrawals/:id/require-info',
        'POST /withdrawals/:id/reject',
        'POST /withdrawals/:id/settle (manual settlement)',
        'POST /withdrawals/:id/retry',
        'POST /withdrawals/:id/reconcile',
        'POST /admin/refunds',
        'POST /admin/reconciliation/run',
      ],
      challengeTtlSeconds: 120,
      singleUse: true,
      scopeBound: true,
    };
  }
}

/** Re-exports so feature modules only need this module. */
export { MfaService, MfaPurpose, RequireMfa, MfaFreshGuard, MFA_METADATA_KEY };
export type { RequireMfaOptions };
