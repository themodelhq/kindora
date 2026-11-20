import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateDonationDto {
  @IsString()
  campaignSlug: string;

  /** Minor units (kobo/cents) — integers only. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountMinor: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  tipAmountMinor?: number;

  // MOCK is accepted here for test/offline environments (PROVIDER_MODE=mock);
  // in live mode PaymentsService.adapterFor('MOCK') throws 403 — the runtime
  // gate is the authoritative production safety, the DTO stays provider-shaped.
  @IsIn(['PAYSTACK', 'FLUTTERWAVE', 'STRIPE', 'PAYPAL', 'MOCK'])
  provider: string;

  /** Required for guest donations when not signed in (service-level check). */
  @IsOptional()
  @IsEmail()
  guestEmail?: string;

  @IsOptional()
  @IsString()
  guestName?: string;

  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsBoolean()
  recurring?: boolean;

  @IsOptional()
  @IsIn(['MONTHLY', 'QUARTERLY', 'YEARLY'])
  recurringFrequency?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

  @IsOptional()
  @IsString()
  circleId?: string;
}
