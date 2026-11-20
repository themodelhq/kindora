import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class CampaignQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsIn(['trending', 'newest', 'deadline', 'target'])
  sort?: 'trending' | 'newest' | 'deadline' | 'target';

  /** Comma-separated list; only ACTIVE/PAUSED/COMPLETED are exposed publicly. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  status?: string;
}

export class CreateCampaignUpdateDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsString()
  @MaxLength(10000)
  body: string;
}
