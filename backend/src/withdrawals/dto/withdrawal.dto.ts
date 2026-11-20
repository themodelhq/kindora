import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { MANUAL_SETTLEMENT_CHANNELS } from '../../payouts/manual-settlement-channels';

export class CreateWithdrawalDto {
  @IsString()
  campaignId: string;

  /** Requested gross amount in minor units. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountMinor: number;

  @IsEnum(['BANK', 'MOBILE_MONEY'])
  method: 'BANK' | 'MOBILE_MONEY';

  /** Destination snapshot: { accountNumber, bankName, accountName, ... } */
  @IsObject()
  destination: Record<string, string>;
}

export class WithdrawalReviewDto {
  @IsString()
  @MinLength(3)
  note: string;
}

/**
 * MANUAL SETTLEMENT (v1.0.4 §10). Evidence is a StoredFile id — NEVER an
 * arbitrary external URL. The file must be:
 *  - uploaded by the submitting administrator,
 *  - stored PRIVATELY,
 *  - of kind PAYOUT_EVIDENCE,
 *  - security-scanned CLEAN and APPROVED,
 *  - bound to exactly this withdrawal (unique constraint prevents reuse).
 */
export class SettlePayoutDto {
  /**
   * v1.0.8 §3.2 — the settlement channel MUST be one of the explicit
   * server-side allowlisted MANUAL channels. API providers (PAYSTACK,
   * PAYSTACK_TRANSFER, FLUTTERWAVE, FLUTTERWAVE_TRANSFER, STRIPE, PAYPAL)
   * and every other value are rejected HERE at the DTO layer — and again at
   * the controller and the service (defense in depth, §3.3).
   */
  @IsIn(MANUAL_SETTLEMENT_CHANNELS, {
    message: `settlement channel must be one of the approved manual channels: ${MANUAL_SETTLEMENT_CHANNELS.join(', ')}`,
  })
  payoutProvider: string;

  /** Provider transaction / NUBAN transfer reference. Required proof of settlement. */
  @IsString()
  @MinLength(3)
  providerTransferRef: string;

  /** Provider-side transaction id when distinct from the human reference. */
  @IsOptional()
  @IsString()
  payoutProviderTxnId?: string;

  /** Registered private evidence file (PAYOUT_EVIDENCE kind) — required. */
  @IsString()
  @MinLength(6)
  evidenceFileId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Reconciliation evidence — same StoredFile policy (§10). */
export class ReconcileDto {
  @IsOptional()
  @IsString()
  @MinLength(6)
  evidenceFileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RequireInfoDto {
  @IsString()
  @MinLength(3)
  note: string;
}

/**
 * v1.0.7 §8 — payout execution through a real provider transfer. Only
 * genuinely-implemented API providers are accepted (PAYSTACK, FLUTTERWAVE;
 * the service registry rejects STRIPE/PAYPAL with an explicit reason).
 */
export class ExecutePayoutDto {
  @IsString()
  @MinLength(2)
  payoutProvider: string;
}

/** v1.0.7 §5.4 — destination update (invalidates approvals + beneficiaries). */
export class UpdateDestinationDto {
  @IsObject()
  destination: Record<string, string>;
}

/** v1.0.7 §9 — controlled manual review resolution. */
export class ResolveReviewCaseDto {
  @IsEnum(['RETURN_TO_VERIFICATION', 'CONFIRM_PROVIDER_SUCCESS_WITH_EVIDENCE', 'RECORD_REVERSAL_DECISION', 'NO_INTERNAL_CHANGE'])
  resolution: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;

  @IsOptional()
  @IsString()
  evidenceFileId?: string;

  @IsOptional()
  @IsString()
  reviewerId?: string;
}

/** Safe retry authorization (v1.0.4 §5.4). */
export class RetryPayoutDto {
  /** Provider for the new attempt; defaults to the previous attempt's provider. */
  @IsOptional()
  @IsString()
  payoutProvider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
