/**
 * MEDIA queue processor — `media` queue.
 *
 *   media.process-image {fileId, key, kind}
 *       REAL image pipeline: download the object from S3-compatible storage
 *       (STORAGE_* env, forcePathStyle), validate/decode with sharp, then
 *       produce an optimized WebP main image (max width 1600, quality 82,
 *       withoutEnlargement) and a 480px thumbnail (JPEG quality 78, PNG when
 *       the source had alpha) with EXIF/metadata stripped. Outputs are
 *       uploaded under keys derived from the original (`-1600.webp` /
 *       `-thumb.jpg` inserted at the extension) and the StoredFile row gets
 *       the processing result recorded in `scanNote` as JSON
 *       {"processed":true,"variants":[...],...}. APPROVAL IS NOT DONE HERE —
 *       that is the scan flow's job; concerns stay separate.
 *
 *       Failure semantics (never silently ack):
 *         - sharp decode error (permanent — same bytes always fail):
 *           StoredFile → REJECTED + scanNote "unprocessable image", ack OK.
 *         - missing source object (permanent): StoredFile → FAILED + note,
 *           ack OK.
 *         - S3/network/other transient errors: rethrow so BullMQ retries per
 *           the default policy; the row is left untouched.
 *
 *   media.scan-file {fileId, key, kind}
 *       The malware-scan lifecycle (fail-safe by design):
 *         - MALWARE_SCAN_ENDPOINT configured: the object bytes are POSTed to
 *           the scanner (e.g. a ClamAV REST bridge); response {clean:boolean}
 *           or {verdict} maps to CLEAN/INFESTED. CLEAN → APPROVED; INFESTED →
 *           REJECTED + CRITICAL log. Scanner call failures rethrow (transient,
 *           retried by BullMQ); an unparseable 2xx verdict → UNAVAILABLE and
 *           the file stays quarantined (never auto-approve on a broken scan).
 *         - No scanner configured: PUBLIC kinds (CAMPAIGN_IMAGE,
 *           CAMPAIGN_MEDIA, AVATAR) get verdict SKIPPED + APPROVED — safe
 *           because public images are also strictly validated/re-encoded by
 *           process-image; SENSITIVE kinds (DOCUMENT, IDENTITY,
 *           EXPENSE_EVIDENCE) get verdict UNAVAILABLE and stay QUARANTINED —
 *           sensitive documents are never auto-approved without a scanner.
 *
 * Handlers deliberately do not try/catch transient errors: they propagate to
 * the worker wrapper in src/index.ts, which logs and rethrows so BullMQ
 * retries with exponential backoff (attempts: 5).
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Job } from 'bullmq';
import sharp from 'sharp';

import { malwareScanEndpoint, storageSettings } from '../lib/env';
import { logError, logInfo, logWarn } from '../lib/logger';
import { prisma } from '../lib/prisma';

import type { JobHandler } from './email.processor';

const MAIN_MAX_WIDTH = 1600;
const MAIN_QUALITY = 82;
const THUMB_WIDTH = 480;
const THUMB_QUALITY = 78;
const SCAN_TIMEOUT_MS = 60 * 1000;

/** Kinds that are safe to approve without a scanner (public images). */
const PUBLIC_KINDS = new Set(['CAMPAIGN_IMAGE', 'CAMPAIGN_MEDIA', 'AVATAR']);

interface MediaJobData {
  fileId?: string;
  key?: string;
  kind?: string;
}

// ---------------------------------------------------------------------------
// S3-compatible storage helpers
// ---------------------------------------------------------------------------

let s3Client: S3Client | null = null;

function getS3(storage: NonNullable<ReturnType<typeof storageSettings>>): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: storage.forcePathStyle,
      credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
    });
  }
  return s3Client;
}

async function downloadObject(storage: NonNullable<ReturnType<typeof storageSettings>>, key: string): Promise<Buffer> {
  const s3 = getS3(storage);
  const result = await s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error(`empty object body for ${key}`);
  return Buffer.from(bytes);
}

async function uploadObject(
  storage: NonNullable<ReturnType<typeof storageSettings>>,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const s3 = getS3(storage);
  await s3.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: body, ContentType: contentType }));
}

/** Permanent S3 errors: retrying can never succeed. */
function isPermanentS3Error(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  return name === 'NoSuchKey' || name === 'NotFound';
}

/**
 * Output key: insert the variant suffix at the extension position
 * (`dir/photo.jpg` → `dir/photo-1600.webp` / `dir/photo-thumb.jpg`).
 */
function deriveKey(key: string, suffix: string, extension: string): string {
  const dot = key.lastIndexOf('.');
  const base = dot > 0 ? key.slice(0, dot) : key;
  return `${base}${suffix}.${extension}`;
}

/**
 * Merges a scan/processing patch into an existing scanNote. Old notes that
 * are JSON objects are preserved (process-image writes variant info there
 * first, then the scan flow appends its verdict); plain-text notes move under
 * `note` so nothing is lost.
 */
function mergeScanNote(existing: string | null, patch: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      } else {
        base = { note: existing };
      }
    } catch {
      base = { note: existing };
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

async function loadStoredFile(data: MediaJobData) {
  if (data.fileId) {
    return prisma.storedFile.findUnique({ where: { id: data.fileId } });
  }
  if (data.key) {
    return prisma.storedFile.findUnique({ where: { key: data.key } });
  }
  return null;
}

// ---------------------------------------------------------------------------
// media.process-image
// ---------------------------------------------------------------------------

async function handleProcessImage(job: Job): Promise<void> {
  const data = job.data as MediaJobData;
  const file = await loadStoredFile(data);
  if (!file) {
    logInfo(`[media] process-image#${job.id ?? '-'}: StoredFile not found (fileId=${data.fileId ?? '-'} key=${data.key ?? '-'}) — nothing to do`);
    return;
  }

  const kind = (data.kind ?? file.kind) as string;
  if (!['CAMPAIGN_IMAGE', 'CAMPAIGN_MEDIA', 'AVATAR'].includes(kind)) {
    logInfo(`[media] process-image ${file.key}: skip non-image kind=${kind} (scan-file owns its lifecycle)`);
    return;
  }
  if (!file.contentType.toLowerCase().startsWith('image/')) {
    // e.g. a video uploaded under CAMPAIGN_MEDIA — not processable as an image,
    // but NOT unprocessable garbage: skip (scan-file still runs its lifecycle).
    logInfo(`[media] process-image ${file.key}: skip non-image contentType=${file.contentType}`);
    return;
  }

  const storage = storageSettings();
  if (!storage) {
    // Processing did not happen — never ack as success. Configuration is a
    // transient defect from BullMQ's point of view (fixable without changes
    // to the bytes), so rethrow for the standard retry policy.
    throw new Error(`[media] STORAGE_* env not configured — cannot process ${file.key}`);
  }

  let source: Buffer;
  try {
    source = await downloadObject(storage, file.key);
  } catch (err) {
    if (isPermanentS3Error(err)) {
      await prisma.storedFile.update({
        where: { id: file.id },
        data: { status: 'FAILED', scanNote: mergeScanNote(file.scanNote, { error: 'source object missing' }) },
      });
      logError(`[media] process-image ${file.key}: source object missing in storage — marked FAILED`);
      return; // permanent — ack
    }
    throw err; // transient S3/network error — BullMQ retries
  }

  // sharp pipeline — deterministic for the same bytes, so any failure here is
  // permanent: REJECTED + "unprocessable image", acked (no retry storm).
  let webp: Buffer;
  let thumb: Buffer;
  let thumbExtension: 'jpg' | 'png';
  let originalBytes: number;
  let webpBytes: number;
  let thumbBytes: number;
  try {
    const metadata = await sharp(source).metadata(); // validates decode
    const hasAlpha = Boolean(metadata.hasAlpha);
    originalBytes = source.byteLength;

    const main = sharp(source)
      .rotate() // bakes EXIF orientation into pixels; metadata stays stripped
      .resize({ width: MAIN_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: MAIN_QUALITY });
    webp = await main.toBuffer();
    webpBytes = webp.byteLength;

    // Thumbnail: JPEG by default; alpha sources keep transparency via PNG.
    const thumbPipeline = sharp(source)
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true });
    thumb = hasAlpha
      ? await thumbPipeline.clone().png().toBuffer()
      : await thumbPipeline.clone().jpeg({ quality: THUMB_QUALITY }).toBuffer();
    thumbExtension = hasAlpha ? 'png' : 'jpg';
    thumbBytes = thumb.byteLength;
  } catch (err) {
    await prisma.storedFile.update({
      where: { id: file.id },
      data: { status: 'REJECTED', rejectedAt: new Date(), scanNote: 'unprocessable image' },
    });
    logWarn(
      `[media] process-image ${file.key}: sharp cannot decode/process this upload — REJECTED ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return; // permanent — ack
  }

  const webpKey = deriveKey(file.key, '-1600', 'webp');
  const thumbKey = deriveKey(file.key, '-thumb', thumbExtension);
  await uploadObject(storage, webpKey, webp, 'image/webp');
  await uploadObject(storage, thumbKey, thumb, thumbExtension === 'png' ? 'image/png' : 'image/jpeg');

  // Processing result only — approval stays with the scan flow. Merged into
  // any existing scanNote so a verdict recorded earlier is preserved.
  await prisma.storedFile.update({
    where: { id: file.id },
    data: {
      scanNote: mergeScanNote(file.scanNote, {
        processed: true,
        variants: [webpKey, thumbKey],
        originalBytes,
        webpBytes,
        thumbBytes,
      }),
    },
  });
  logInfo(
    `[media] process-image ${file.key}: ${originalBytes}B → webp ${webpBytes}B (${webpKey}), ` +
      `thumb ${thumbBytes}B (${thumbKey})`,
  );
}

// ---------------------------------------------------------------------------
// media.scan-file
// ---------------------------------------------------------------------------

type ScanOutcome = 'CLEAN' | 'INFESTED' | 'UNKNOWN';

/** POST the object bytes to the configured HTTP virus-scan service. */
async function callMalwareScanner(bytes: Uint8Array, fileName: string): Promise<ScanOutcome> {
  const endpoint = malwareScanEndpoint();
  if (!endpoint) throw new Error('MALWARE_SCAN_ENDPOINT is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Scan-Filename': encodeURIComponent(fileName),
      },
      body: bytes,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`scanner responded HTTP ${res.status} — will retry`);
  }
  const payload = (await res.json().catch(() => null)) as { clean?: unknown; verdict?: unknown } | null;
  if (!payload) return 'UNKNOWN';
  if (payload.clean === true) return 'CLEAN';
  if (payload.clean === false) return 'INFESTED';
  const verdict = typeof payload.verdict === 'string' ? payload.verdict.trim().toUpperCase() : '';
  if (verdict === 'CLEAN' || verdict === 'OK') return 'CLEAN';
  if (verdict === 'INFESTED' || verdict === 'INFECTED') return 'INFESTED';
  return 'UNKNOWN';
}

async function handleScanFile(job: Job): Promise<void> {
  const data = job.data as MediaJobData;
  const file = await loadStoredFile(data);
  if (!file) {
    logInfo(`[media] scan-file#${job.id ?? '-'}: StoredFile not found (fileId=${data.fileId ?? '-'} key=${data.key ?? '-'}) — nothing to do`);
    return;
  }
  const kind = (data.kind ?? file.kind) as string;
  const now = new Date();

  const scannerEndpoint = malwareScanEndpoint();
  if (scannerEndpoint) {
    const storage = storageSettings();
    if (!storage) {
      // A scanner without storage credentials can never read the bytes —
      // fail safe and leave the object quarantined.
      await prisma.storedFile.update({
        where: { id: file.id },
        data: {
          status: 'QUARANTINED',
          scanVerdict: 'UNAVAILABLE',
          scannedAt: now,
          scanNote: mergeScanNote(file.scanNote, { scan: 'unavailable', reason: 'storage not configured for scanner' }),
        },
      });
      logWarn(`[media] scan-file ${file.key}: scanner configured but STORAGE_* missing — UNAVAILABLE, stays quarantined`);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = await downloadObject(storage, file.key);
    } catch (err) {
      if (isPermanentS3Error(err)) {
        await prisma.storedFile.update({
          where: { id: file.id },
          data: {
            status: 'FAILED',
            scanVerdict: 'UNAVAILABLE',
            scannedAt: now,
            scanNote: mergeScanNote(file.scanNote, { scan: 'failed', reason: 'source object missing' }),
          },
        });
        logError(`[media] scan-file ${file.key}: source object missing — marked FAILED`);
        return;
      }
      throw err; // transient — BullMQ retries
    }

    let outcome: ScanOutcome;
    try {
      outcome = await callMalwareScanner(bytes, file.fileName);
    } catch (err) {
      throw err; // scanner transport error is transient — BullMQ retries
    }

    if (outcome === 'UNKNOWN') {
      // Scanner spoke but did not produce a usable verdict — fail safe:
      // never approve on a broken scan, leave quarantined for operators.
      await prisma.storedFile.update({
        where: { id: file.id },
        data: {
          status: 'QUARANTINED',
          scanVerdict: 'UNAVAILABLE',
          scannedAt: now,
          scanNote: mergeScanNote(file.scanNote, { scan: 'unavailable', reason: 'scanner verdict unparseable' }),
        },
      });
      logWarn(`[media] scan-file ${file.key}: scanner verdict unparseable — UNAVAILABLE, stays quarantined`);
      return;
    }

    if (outcome === 'INFESTED') {
      await prisma.storedFile.update({
        where: { id: file.id },
        data: {
          status: 'REJECTED',
          scanVerdict: 'INFESTED',
          scannedAt: now,
          rejectedAt: now,
          scanNote: mergeScanNote(file.scanNote, { scan: 'infested', scanner: scannerEndpoint }),
        },
      });
      logError(`CRITICAL: [media] scan-file ${file.key} (kind=${kind}) is INFESTED per the malware scanner — REJECTED and quarantined from public access`);
      return;
    }

    await prisma.storedFile.update({
      where: { id: file.id },
      data: {
        status: 'APPROVED',
        scanVerdict: 'CLEAN',
        scannedAt: now,
        approvedAt: now,
        scanNote: mergeScanNote(file.scanNote, { scan: 'clean', scanner: scannerEndpoint }),
      },
    });
    logInfo(`[media] scan-file ${file.key}: scanner verdict CLEAN — APPROVED`);
    return;
  }

  // No scanner configured — graceful fail-safe.
  if (PUBLIC_KINDS.has(kind)) {
    await prisma.storedFile.update({
      where: { id: file.id },
      data: {
        status: 'APPROVED',
        scanVerdict: 'SKIPPED',
        scannedAt: now,
        approvedAt: now,
        scanNote: mergeScanNote(file.scanNote, {
          scan: 'skipped',
          reason: 'no malware scanner configured; public media (also re-encoded by process-image)',
        }),
      },
    });
    logInfo(`[media] scan-file ${file.key} (kind=${kind}): no scanner — public media SKIPPED → APPROVED`);
    return;
  }

  await prisma.storedFile.update({
    where: { id: file.id },
    data: {
      status: 'QUARANTINED',
      scanVerdict: 'UNAVAILABLE',
      scannedAt: now,
      scanNote: mergeScanNote(file.scanNote, {
        scan: 'unavailable',
        reason: 'no malware scanner configured; sensitive document stays quarantined',
      }),
    },
  });
  logWarn(`[media] scan-file ${file.key} (kind=${kind}): no scanner configured — sensitive file stays QUARANTINED (fail safe)`);
}

export const MEDIA_HANDLERS: Record<string, JobHandler> = {
  'media.process-image': handleProcessImage,
  'media.scan-file': handleScanFile,
};
