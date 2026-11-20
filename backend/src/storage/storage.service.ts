import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileVisibility, Prisma, ScanVerdict, StoredFileKind, StoredFileStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';
import { randomToken } from '../common/utils/crypto.util';
import { PresignDto, ProcessMediaDto, UploadDto, UploadKind } from './dto/storage.dto';
import type { Actor } from './storage.types';

const PRESIGN_TTL_SECONDS = 900;
const UPLOAD_TTL_SECONDS = 600;
const DOCUMENT_TTL_SECONDS = 300;
const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB (overridable via STORAGE_MAX_UPLOAD_MB)

const ALLOWED_UPLOAD_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const UPLOAD_EXTENSION_WHITELIST: Record<UploadKind, string[]> = {
  'campaign-image': ['jpg', 'jpeg', 'png', 'webp'],
  document: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
  avatar: ['jpg', 'jpeg', 'png', 'webp'],
};

const CONTENT_TYPE_WHITELIST: Record<PresignDto['kind'], string[]> = {
  'campaign-media': ['image/jpeg', 'image/png', 'image/webp'],
  avatar: ['image/jpeg', 'image/png', 'image/webp'],
  identity: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  'expense-evidence': ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
};

const EXTENSION_WHITELIST: Record<PresignDto['kind'], string[]> = {
  'campaign-media': ['jpg', 'jpeg', 'png', 'webp'],
  avatar: ['jpg', 'jpeg', 'png', 'webp'],
  identity: ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
  'expense-evidence': ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
};

/** Private kinds never receive public URLs and need scan/authorization gates. */
const PRIVATE_KINDS = new Set(['document', 'identity', 'expense-evidence']);
/** Sensitive categories fail safe (stay quarantined) when no scanner is available. */
const SENSITIVE_KINDS = new Set(['document', 'identity']);

const KIND_TO_MODEL: Record<string, StoredFileKind> = {
  'campaign-image': 'CAMPAIGN_IMAGE',
  'campaign-media': 'CAMPAIGN_MEDIA',
  avatar: 'AVATAR',
  document: 'DOCUMENT',
  identity: 'IDENTITY',
  'expense-evidence': 'EXPENSE_EVIDENCE',
  'payout-evidence': 'PAYOUT_EVIDENCE',
};

function sanitizeFileName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;
  private cachedConfig: { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string } | null =
    null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Object storage is optional per deployment: absent config => explicit 503. */
  private config() {
    const endpoint = process.env.STORAGE_ENDPOINT ?? '';
    const bucket = process.env.STORAGE_BUCKET ?? '';
    const accessKey = process.env.STORAGE_ACCESS_KEY ?? '';
    if (!endpoint || !bucket || !accessKey) {
      throw new ServiceUnavailableException('Object storage is not configured');
    }
    if (!this.cachedConfig) {
      this.cachedConfig = { endpoint, bucket, region: process.env.STORAGE_REGION ?? 'us-east-1', accessKey, secretKey: process.env.STORAGE_SECRET_KEY ?? '' };
    }
    return this.cachedConfig;
  }

  private maxUploadBytes(): number {
    const mb = parseInt(process.env.STORAGE_MAX_UPLOAD_MB ?? '15', 10);
    return (Number.isFinite(mb) && mb > 0 ? mb : 15) * 1024 * 1024;
  }

  private s3() {
    if (!this.client) {
      const cfg = this.config();
      this.client = new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
        forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
      });
    }
    return this.client;
  }

  /** Public URLs are only ever returned for PUBLIC kinds. */
  private publicUrl(key: string): string {
    const cfg = this.config();
    const publicBase = process.env.STORAGE_PUBLIC_BASE_URL ?? '';
    return publicBase ? `${publicBase.replace(/\/+$/, '')}/${key}` : `${cfg.endpoint.replace(/\/+$/, '')}/${cfg.bucket}/${key}`;
  }

  private visibilityFor(kind: string): FileVisibility {
    return PRIVATE_KINDS.has(kind) ? FileVisibility.PRIVATE : FileVisibility.PUBLIC;
  }

  /**
   * Issues a presigned POST policy for the /storage/uploads flow.
   *
   * Storage-side enforcement: the POST policy carries a content-length-range
   * condition so object storage itself REJECTS oversized objects — the size
   * ceiling no longer depends on client cooperation. Every accepted upload
   * intent is registered in the StoredFile registry (ownership + quarantine
   * status), and private kinds never receive a public URL.
   */
  async createUpload(dto: UploadDto, user: { id: string; role: string }) {
    const cfg = this.config();

    if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(dto.contentType)) {
      throw new BadRequestException(
        `Content type ${dto.contentType} is not allowed. Allowed: ${ALLOWED_UPLOAD_CONTENT_TYPES.join(', ')}`,
      );
    }
    const extension = dto.fileName.includes('.') ? dto.fileName.split('.').pop()!.toLowerCase() : '';
    if (!UPLOAD_EXTENSION_WHITELIST[dto.kind].includes(extension)) {
      throw new BadRequestException(`File extension .${extension || '?'} is not allowed for ${dto.kind} uploads`);
    }

    const maxBytes = this.maxUploadBytes();
    const visibility = this.visibilityFor(dto.kind);
    const key = `${dto.kind}/${user.id}/${randomToken(8)}-${sanitizeFileName(dto.fileName) || 'file'}`;

    // Ownership link for campaign-scoped uploads.
    let campaignId: string | null = null;
    if (dto.campaignId) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: dto.campaignId },
        select: { id: true, createdById: true, organizationId: true },
      });
      if (!campaign) throw new NotFoundException('Campaign not found');
      const member = campaign.organizationId
        ? await this.prisma.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId: campaign.organizationId, userId: user.id } },
          })
        : null;
      if (campaign.createdById !== user.id && !member && user.role !== 'ADMIN') {
        throw new ForbiddenException('You do not manage this campaign');
      }
      campaignId = campaign.id;
    }

    const file = await this.prisma.storedFile.create({
      data: {
        key,
        kind: KIND_TO_MODEL[dto.kind],
        visibility,
        status: StoredFileStatus.QUARANTINED,
        scanVerdict: ScanVerdict.PENDING,
        fileName: sanitizeFileName(dto.fileName) || 'file',
        contentType: dto.contentType,
        sizeBytes: BigInt(0),
        uploaderId: user.id,
        ...(campaignId ? { campaignId } : {}),
      },
    });

    const { url, fields } = await createPresignedPost(this.s3(), {
      Bucket: cfg.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        { 'Content-Type': dto.contentType },
      ],
      Expires: UPLOAD_TTL_SECONDS,
    });

    return {
      file: { id: file.id, key, kind: dto.kind, visibility, status: file.status },
      postUrl: url,
      fields,
      // Kept for backwards-compatible client helpers; modern clients use postUrl+fields.
      uploadUrl: url,
      // Public URL is returned ONLY for public kinds; private kinds are
      // accessed exclusively through authorized signed GETs.
      ...(visibility === 'PUBLIC' ? { publicUrl: this.publicUrl(key) } : {}),
      key,
      expiresIn: UPLOAD_TTL_SECONDS,
      maxBytes,
    };
  }

  /**
   * Called by the client after the object is uploaded. Verifies the stored
   * object at the storage boundary (size ceiling + content type), then moves
   * the file into the scan lifecycle:
   *   QUARANTINED -> SCANNING -> (worker) APPROVED | REJECTED | (no scanner:
   *   public kinds SKIPPED->APPROVED, sensitive kinds stay quarantined).
   */
  async confirmUpload(key: string, user: { id: string; role: string }) {
    const cfg = this.config();
    const normalized = key.replace(/^\/+/, '');
    const file = await this.prisma.storedFile.findUnique({ where: { key: normalized } });
    if (!file) throw new NotFoundException('Unknown upload — upload was never registered');
    if (file.uploaderId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the uploader can confirm this upload');
    }

    let head;
    try {
      head = await this.s3().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: normalized }));
    } catch {
      await this.prisma.storedFile.update({ where: { id: file.id }, data: { status: StoredFileStatus.FAILED, scanNote: 'object not found at storage' } });
      throw new BadRequestException('Object not found in storage — upload did not complete');
    }

    const maxBytes = this.maxUploadBytes();
    if ((head.ContentLength ?? 0) > maxBytes) {
      await this.prisma.storedFile.update({ where: { id: file.id }, data: { status: StoredFileStatus.REJECTED, scanNote: `exceeds ${maxBytes} bytes` } });
      throw new BadRequestException('File exceeds the maximum allowed size and was rejected');
    }
    if (head.ContentType && head.ContentType !== file.contentType) {
      await this.prisma.storedFile.update({ where: { id: file.id }, data: { status: StoredFileStatus.REJECTED, scanNote: `content type mismatch: ${head.ContentType}` } });
      throw new BadRequestException('Uploaded object content type does not match the registered type and was rejected');
    }

    await this.prisma.storedFile.update({
      where: { id: file.id },
      data: {
        sizeBytes: BigInt(head.ContentLength ?? 0),
        status: StoredFileStatus.SCANNING,
        scanVerdict: ScanVerdict.PENDING,
      },
    });
    await this.queue.enqueue('media', 'media.scan-file', { fileId: file.id, key: normalized, kind: file.kind });
    return { status: 'SCANNING', fileId: file.id, key: normalized };
  }

  /** Verdict handler used by the media worker. */
  async applyScanVerdict(fileId: string, verdict: 'CLEAN' | 'INFESTED' | 'SKIPPED' | 'UNAVAILABLE', note?: string) {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file) return;
    if (verdict === 'INFESTED') {
      await this.prisma.storedFile.update({
        where: { id: fileId },
        data: { status: StoredFileStatus.REJECTED, scanVerdict: ScanVerdict.INFESTED, scanNote: note, rejectedAt: new Date() },
      });
      this.logger.warn(`StoredFile ${file.key} REJECTED: malware scan flagged the object`);
      return;
    }
    if (verdict === 'UNAVAILABLE' && SENSITIVE_KINDS.has(file.kind.toString().toLowerCase())) {
      // Fail safe: sensitive documents are never auto-approved without a scanner.
      await this.prisma.storedFile.update({
        where: { id: fileId },
        data: { status: StoredFileStatus.QUARANTINED, scanVerdict: ScanVerdict.UNAVAILABLE, scanNote: note ?? 'scanner unavailable for sensitive category' },
      });
      return;
    }
    if (verdict === 'UNAVAILABLE' || verdict === 'SKIPPED') {
      await this.prisma.storedFile.update({
        where: { id: fileId },
        data: { status: StoredFileStatus.APPROVED, scanVerdict: verdict === 'SKIPPED' ? ScanVerdict.SKIPPED : ScanVerdict.SKIPPED, scanNote: note ?? 'no scanner configured for non-sensitive category', approvedAt: new Date() },
      });
      return;
    }
    await this.prisma.storedFile.update({
      where: { id: fileId },
      data: { status: StoredFileStatus.APPROVED, scanVerdict: ScanVerdict.CLEAN, scanNote: note, approvedAt: new Date() },
    });
  }

  /** True when the actor manages the campaign/file's organization or owns the file. */
  private async canAccess(file: { uploaderId: string; campaignId: string | null; organizationId: string | null; kycRecordId: string | null }, user: { id: string; role: string }): Promise<boolean> {
    if (user.role === 'ADMIN') return true;
    if (file.uploaderId === user.id) return true;
    if (file.campaignId) {
      const campaign = await this.prisma.campaign.findUnique({ where: { id: file.campaignId }, select: { createdById: true, organizationId: true } });
      if (campaign?.createdById === user.id) return true;
      if (campaign?.organizationId) {
        const m = await this.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: campaign.organizationId, userId: user.id } } });
        if (m) return true;
      }
    }
    if (file.organizationId) {
      const m = await this.prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: file.organizationId, userId: user.id } } });
      if (m) return true;
    }
    return false;
  }

  /**
   * Signed GET for PRIVATE documents (KYC evidence etc.) — the hardened
   * replacement for the old open endpoint. Rules:
   *  - the key must exist in the StoredFile registry (unknown keys are never
   *    served — a leaked/guessed storage key alone grants nothing);
   *  - only the owner, managers of the linked campaign/organization, or
   *    administrators may obtain a URL (403 otherwise, no information leak);
   *  - sensitive documents must have a scan verdict unless the caller is an
   *    admin (privileged review access is explicitly audited);
   *  - EVERY privileged access writes an immutable AuditLog record.
   */
  async getSignedUrlForUser(key: string, user: { id: string; role: string }) {
    const cfg = this.config();

    const normalized = key.replace(/^\/+/, '');
    if (!normalized.startsWith('document/') && !normalized.startsWith('documents/') && !normalized.startsWith('identity/') && !normalized.startsWith('expense-evidence/')) {
      throw new BadRequestException('Only private document keys can be fetched here');
    }
    if (normalized.includes('..')) throw new BadRequestException('Invalid key');

    const file = await this.prisma.storedFile.findUnique({ where: { key: normalized } });
    if (!file) {
      // Fail closed: untracked keys are never served, even to admins.
      throw new NotFoundException('Document not found');
    }

    const allowed = await this.canAccess(file, user);
    if (!allowed) throw new ForbiddenException('You do not have access to this document');

    const isSensitive = SENSITIVE_KINDS.has(file.kind.toString().toLowerCase());
    if (isSensitive && user.role !== 'ADMIN' && file.scanVerdict !== ScanVerdict.CLEAN) {
      throw new ForbiddenException('This document is pending security review and cannot be downloaded yet');
    }

    const url = await getSignedUrl(
      this.s3(),
      new GetObjectCommand({ Bucket: cfg.bucket, Key: normalized }),
      { expiresIn: DOCUMENT_TTL_SECONDS },
    );

    // Privileged access (admin or manager, not the owner) is audited.
    if (user.id !== file.uploaderId) {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'PRIVILEGED_DOCUMENT_ACCESS',
          entityType: 'STORED_FILE',
          entityId: file.id,
          metadata: {
            key: normalized,
            actorRole: user.role,
            ownerUserId: file.uploaderId,
            campaignId: file.campaignId,
            organizationId: file.organizationId,
            kycRecordId: file.kycRecordId,
            scanVerdict: file.scanVerdict,
          },
        },
      });
    }

    return { url, key: normalized, expiresIn: DOCUMENT_TTL_SECONDS, fileId: file.id, scanVerdict: file.scanVerdict };
  }

  /** Admin reviewer access by file id (used by KYC/verification workflows). Audited. */
  async adminSignUrl(fileId: string, admin: { id: string; role: string }) {
    const cfg = this.config();
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundException('Document not found');
    if (admin.role !== 'ADMIN') throw new ForbiddenException('Administrator role required');
    const url = await getSignedUrl(
      this.s3(),
      new GetObjectCommand({ Bucket: cfg.bucket, Key: file.key }),
      { expiresIn: DOCUMENT_TTL_SECONDS },
    );
    await this.prisma.auditLog.create({
      data: {
        actorUserId: admin.id,
        action: 'PRIVILEGED_DOCUMENT_ACCESS',
        entityType: 'STORED_FILE',
        entityId: file.id,
        metadata: {
          key: file.key,
          actorRole: 'ADMIN',
          ownerUserId: file.uploaderId,
          campaignId: file.campaignId,
          organizationId: file.organizationId,
          kycRecordId: file.kycRecordId,
          scanVerdict: file.scanVerdict,
          via: 'admin review workflow',
        },
      },
    });
    return { url, key: file.key, expiresIn: DOCUMENT_TTL_SECONDS, scanVerdict: file.scanVerdict };
  }

  /** Lists the actor's own files (registry view). */
  async listMine(userId: string, skip: number, limit: number) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.storedFile.count({ where: { uploaderId: userId } }),
      this.prisma.storedFile.findMany({
        where: { uploaderId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, key: true, kind: true, visibility: true, status: true, scanVerdict: true,
          fileName: true, contentType: true, sizeBytes: true, createdAt: true,
        },
      }),
    ]);
    return { total, items: items.map((i) => ({ ...i, sizeBytes: i.sizeBytes.toString() })) };
  }

  /**
   * Legacy presign flow (date-sharded keys) with the same guarantees as
   * createUpload: POST policy size enforcement, registry row, no public URL
   * for private kinds.
   */
  async presign(dto: PresignDto, user: { id: string; role: string }) {
    const cfg = this.config();

    const allowedTypes = CONTENT_TYPE_WHITELIST[dto.kind];
    if (!allowedTypes.includes(dto.contentType)) {
      throw new BadRequestException(`Content type ${dto.contentType} is not allowed for ${dto.kind} uploads`);
    }
    const extension = dto.filename.includes('.') ? dto.filename.split('.').pop()!.toLowerCase() : '';
    if (!EXTENSION_WHITELIST[dto.kind].includes(extension)) {
      throw new BadRequestException(`File extension .${extension || '?'} is not allowed for ${dto.kind} uploads`);
    }

    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const sanitized = sanitizeFileName(dto.filename);
    const key = `${dto.kind}/${user.id}/${randomToken(8)}-${sanitized || 'file'}`;
    const maxBytes = this.maxUploadBytes();
    const visibility = this.visibilityFor(dto.kind);

    const file = await this.prisma.storedFile.create({
      data: {
        key,
        kind: KIND_TO_MODEL[dto.kind],
        visibility,
        status: StoredFileStatus.QUARANTINED,
        scanVerdict: ScanVerdict.PENDING,
        fileName: sanitized || 'file',
        contentType: dto.contentType,
        sizeBytes: BigInt(0),
        uploaderId: user.id,
      },
    });

    const { url, fields } = await createPresignedPost(this.s3(), {
      Bucket: cfg.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        { 'Content-Type': dto.contentType },
      ],
      Expires: PRESIGN_TTL_SECONDS,
    });

    return {
      file: { id: file.id, key, kind: dto.kind, visibility, status: file.status },
      postUrl: url,
      fields,
      uploadUrl: url,
      ...(visibility === 'PUBLIC' ? { publicUrl: this.publicUrl(key) } : {}),
      key,
      expiresIn: PRESIGN_TTL_SECONDS,
      maxBytes,
    };
  }

  /**
   * Hand a registered object to the media worker. Restricted to the
   * uploader's own keys (or admin); the client-supplied `url` field was
   * removed — the worker reads only from object storage by key.
   */
  async process(dto: ProcessMediaDto, user: { id: string; role: string }) {
    const normalized = dto.key.replace(/^\/+/, '');
    const file = await this.prisma.storedFile.findUnique({ where: { key: normalized } });
    if (!file) throw new NotFoundException('Unknown key — upload was never registered');
    const allowed = await this.canAccess(file, user);
    if (!allowed) throw new ForbiddenException('You can only process your own uploads');
    await this.queue.enqueue('media', 'media.process-image', { fileId: file.id, key: normalized, kind: dto.kind });
    return { queued: true, fileId: file.id };
  }
}
