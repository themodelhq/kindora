import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  logoUrl?: string;
}

export class AddOrganizationMemberDto {
  @IsEmail()
  email: string;

  /** Members can only be granted ADMIN or MANAGER; OWNER is reserved for the creator. */
  @IsIn(['ADMIN', 'MANAGER'])
  role: 'ADMIN' | 'MANAGER';
}

export class CreatePayoutMethodDto {
  @IsIn(['BANK', 'MOBILE_MONEY'])
  type: 'BANK' | 'MOBILE_MONEY';

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  accountName: string;

  @IsString()
  @MinLength(4)
  @MaxLength(40)
  accountNumber: string;

  /** Bank name, or the mobile-money network/operator name. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankName?: string;
}
