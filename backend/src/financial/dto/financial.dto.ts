import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentProvider, WebhookStatus } from '@prisma/client';

/**
 * Financial Control & Reconciliation Centre — query DTOs.
 *
 * All dates are ISO-8601 date strings validated by class-validator; the
 * service additionally enforces from<=to and a maximum 1-year window (the
 * same clamp that bounds every aggregate query). No raw SQL is used anywhere
 * in this module — every filter becomes a Prisma where object.
 */

const PROVIDERS: string[] = Object.values(PaymentProvider) as string[];
const WEBHOOK_STATUSES: string[] = Object.values(WebhookStatus) as string[];

export class FinancialSummaryQueryDto {
  @IsOptional()
  @IsDateString({}, { message: 'from must be an ISO-8601 date' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to must be an ISO-8601 date' })
  to?: string;

  @IsOptional()
  @IsIn(PROVIDERS)
  provider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;
}

export class PaymentReconciliationQueryDto {
  @IsOptional()
  @IsDateString({}, { message: 'from must be an ISO-8601 date' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to must be an ISO-8601 date' })
  to?: string;

  @IsOptional()
  @IsIn(PROVIDERS)
  provider?: string;

  @IsOptional()
  @IsIn(WEBHOOK_STATUSES)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;
}

export class WithdrawalReconciliationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}

export class FinancialAuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;
}
