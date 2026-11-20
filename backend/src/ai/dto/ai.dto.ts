import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Length, MaxLength, Min, MinLength } from 'class-validator';

export class StoryDraftDto {
  @IsString()
  @Length(5, 120)
  title: string;

  @IsString()
  @MaxLength(80)
  category: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  targetAmountMajor?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  keywords?: string;
}

export class StoryImproveDto {
  @IsString()
  @Length(50, 20000)
  story: string;
}

export class TranslateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(20000)
  text: string;

  /** Target language name or ISO code, e.g. 'French' or 'fr'. */
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  targetLanguage: string;
}
