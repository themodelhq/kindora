import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatarUrl?: string;
}

export class UpdateNotificationPrefsDto {
  @IsOptional()
  @IsBoolean()
  emailDonations?: boolean;

  @IsOptional()
  @IsBoolean()
  emailUpdates?: boolean;

  @IsOptional()
  @IsBoolean()
  emailMarketing?: boolean;

  @IsOptional()
  @IsBoolean()
  emailSecurity?: boolean;

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword: string;

  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain a digit' })
  newPassword: string;
}

export class SubmitKycDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  idType?: string;

  /** Only the last 4 digits of the ID number are ever stored. */
  @IsOptional()
  @IsString()
  @Length(4, 4)
  idNumberLast4?: string;

  /** Storage key (document/<userId>/...) uploaded by THIS account — validated server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  idDocumentUrl?: string;

  /** Storage key (document/<userId>/...) uploaded by THIS account — validated server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  selfieUrl?: string;

  /** Storage key (document/<userId>/...) uploaded by THIS account — validated server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  addressDocumentUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  country?: string;

  @IsOptional()
  @IsIn(['BASIC', 'VERIFIED', 'ENHANCED'])
  level?: 'BASIC' | 'VERIFIED' | 'ENHANCED';
}

export class PushSubscriptionDto {
  @IsString()
  @MaxLength(1000)
  endpoint: string;

  @IsString()
  @MaxLength(500)
  p256dh: string;

  @IsString()
  @MaxLength(500)
  auth: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  userAgent?: string;
}
