import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCircleDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn(['PUBLIC', 'PRIVATE'])
  privacy?: 'PUBLIC' | 'PRIVATE';

  /** Major units (e.g. naira) — converted to minor BigInt server-side. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  goalAmountMajor?: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsString()
  campaignSlug?: string;
}

export class UpdateCircleDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  coverImageUrl?: string;

  /** Major units — converted to minor BigInt server-side. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  goalAmountMajor?: number;

  /** Send null to detach the circle from its campaign focus. */
  @IsOptional()
  @IsString()
  campaignSlug?: string | null;

  @IsOptional()
  @IsIn(['PUBLIC', 'PRIVATE'])
  privacy?: 'PUBLIC' | 'PRIVATE';
}

export class JoinCircleDto {
  @IsOptional()
  @IsString()
  inviteCode?: string;
}

export class CreateCircleContributionDto {
  @IsString()
  circleId: string;

  @IsOptional()
  @IsString()
  campaignSlug?: string;

  /** Minor units — integer, minimum 10000 (100.00 in 2-decimal currencies). */
  @Type(() => Number)
  @IsInt()
  @Min(10000)
  amountMinor: number;

  @IsIn(['DONATION', 'PLEDGE'])
  kind: 'DONATION' | 'PLEDGE';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * publicRef of an existing SUCCEEDED donation owned by the caller.
   * Required for DONATION kind — circles never move money themselves.
   */
  @IsOptional()
  @IsString()
  donationRef?: string;
}
