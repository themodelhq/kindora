import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  @Length(5, 120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  excerpt?: string;

  @IsString()
  @MinLength(200)
  story: string;

  /** Major units (e.g. naira); converted to BigInt minor units server-side. */
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  targetAmountMajor: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /** Category by slug (matches the 12 seeded categories, e.g. 'education'). */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  categorySlug?: string;

  /** Category by id (alternative to categorySlug; one of the two is required). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  @IsOptional()
  @IsISO8601()
  deadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  city?: string;

  @IsOptional()
  @IsIn(['INDIVIDUAL', 'ORGANIZATION'])
  type?: 'INDIVIDUAL' | 'ORGANIZATION';

  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  beneficiaryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverImageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  videoUrl?: string;
}
