import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { StorageService } from './storage.service';
import { ConfirmUploadDto, PresignDto, ProcessMediaDto, UploadDto } from './dto/storage.dto';

/**
 * Storage endpoints. Ownership is enforced per resource inside the service:
 * uploads are registered with an owner, private documents require the owner/
 * manager/admin role AND a registry match, privileged access is audited, and
 * storage-level POST policies enforce the upload size ceiling.
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  /**
   * Authenticated presigned POST upload. Returns the policy (postUrl+fields),
   * the registry record, and a maxBytes ceiling that object storage itself
   * enforces via content-length-range. Unconfigured deployments return 503.
   */
  @Post('uploads')
  async uploads(@Body() dto: UploadDto, @CurrentUser() user: AuthenticatedUser) {
    return this.storage.createUpload(dto, user);
  }

  /**
   * Client calls this after completing the direct upload. Verifies the object
   * at the storage boundary (size, content type) and moves the file into the
   * scan lifecycle.
   */
  @Post('confirm')
  async confirm(@Body() dto: ConfirmUploadDto, @CurrentUser() user: AuthenticatedUser) {
    return this.storage.confirmUpload(dto.key, user);
  }

  /** Registry view of the caller's own uploads and their scan status. */
  @Get('mine')
  async mine(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.storage.listMine(user.id, pagination.skip, pagination.limit);
  }

  /**
   * Signed GET (300s) for PRIVATE document objects. Ownership enforced,
   * unknown keys fail closed, sensitive categories gate on scan verdicts,
   * every privileged access is written to the audit log.
   * Express 5 wildcard: the key path arrives as an ARRAY of segments
   * (path-to-regexp v8) — join it back before validating.
   */
  @Get('documents/*splat')
  async document(@Param('splat') keyPath: string | string[], @CurrentUser() user: AuthenticatedUser) {
    const key = Array.isArray(keyPath) ? keyPath.join('/') : keyPath;
    return this.storage.getSignedUrlForUser(key, user);
  }

  /** Legacy presign (media/identity/expense kinds) — same guarantees as uploads. */
  @Post('presign')
  async presign(@Body() dto: PresignDto, @CurrentUser() user: AuthenticatedUser) {
    return this.storage.presign(dto, user);
  }

  /** Restricted worker hand-off: own keys only; no client-supplied URLs. */
  @Post('process')
  async process(@Body() dto: ProcessMediaDto, @CurrentUser() user: AuthenticatedUser) {
    return this.storage.process(dto, user);
  }
}
