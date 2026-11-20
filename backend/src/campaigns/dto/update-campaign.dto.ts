import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @Length(5, 120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  excerpt?: string;

  @IsOptional()
  @IsString()
  story?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  targetAmountMajor?: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsISO8601()
  deadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverImageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  videoUrl?: string;

  @IsOptional()
  @IsBoolean()
  allowComments?: boolean;

  /** Move the campaign to a different category (id). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  /** Owners may only pause or (re)activate from PAUSED. */
  @IsOptional()
  @IsIn(['PAUSED', 'ACTIVE'])
  status?: 'PAUSED' | 'ACTIVE';
}
