import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class PresignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @IsString()
  @MaxLength(100)
  contentType: string;

  @IsIn(['campaign-media', 'avatar', 'identity', 'expense-evidence', 'payout-evidence'])
  kind: 'campaign-media' | 'avatar' | 'identity' | 'expense-evidence';
}

/**
 * Worker hand-off. The client-supplied `url` was removed (SSRF vector and a
 * trust bypass): the worker always reads from object storage by key, and the
 * key must belong to the caller or the caller's organization.
 */
export class ProcessMediaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  key: string;

  @IsIn(['campaign-media', 'avatar', 'identity', 'expense-evidence', 'payout-evidence', 'campaign-image', 'document'])
  kind: string;
}

export type UploadKind = 'campaign-image' | 'document' | 'avatar';

export class UploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName: string;

  @IsString()
  @MaxLength(100)
  contentType: string;

  @IsIn(['campaign-image', 'document', 'avatar'])
  kind: UploadKind;

  /** Optional campaign link so ownership and quota checks can resolve. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  campaignId?: string;
}

export class ConfirmUploadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  key: string;
}
