import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateMatchingPoolDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  /** Minor units (e.g. kobo) — must be a positive integer; stored as BigInt. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalCommittedMinor: number;

  /** Percent boost applied to each matched donation (100 = 1:1). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  matchRatio?: number;

  /** Optional per-donation match ceiling in minor units. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capPerDonationMinor?: number;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
