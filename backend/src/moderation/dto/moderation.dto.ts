import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateReportDto {
  @IsIn(['CAMPAIGN', 'COMMENT', 'USER', 'ORGANIZATION'])
  entityType: 'CAMPAIGN' | 'COMMENT' | 'USER' | 'ORGANIZATION';

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  entityId: string;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description: string;
}

export class ResolveCaseDto {
  @IsIn(['action', 'clear'])
  action: 'action' | 'clear';

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  note: string;
}
