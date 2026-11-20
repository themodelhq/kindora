import { IsIn, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

export class CreateBeneficiaryDto {
  @IsString()
  @Length(3, 120)
  name: string;

  @IsIn(['INDIVIDUAL', 'ORGANIZATION', 'COMMUNITY'])
  type: 'INDIVIDUAL' | 'ORGANIZATION' | 'COMMUNITY';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  organizationId?: string;
}

export class UpdateBeneficiaryDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
