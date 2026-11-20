import { isDemoMode } from '@/lib/demo/adapter';
import { ApiError, api } from '@/lib/http';
import type { BadgeProps } from '@/components/ui/badge';
import type { ConfirmUploadResponse, StoredFile, UploadRegistration } from '@/types/api';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

export interface FileStatusView {
  label: string;
  variant: BadgeVariant;
}

/**
 * Client-side half of the hardened storage contract:
 *  1. POST /storage/uploads            -> presigned POST policy (postUrl+fields) + registry record
 *  2. POST {postUrl} (FormData)        -> object storage itself; fields first, then the file
 *                                         under the field name 'file' (the policy enforces the
 *                                         size ceiling via content-length-range)
 *  3. POST /storage/confirm {key}      -> server verifies size/content-type and moves the file
 *                                         into the scan lifecycle (SCANNING)
 *  4. GET /storage/mine                -> poll registry for scan verdicts
 *
 * The old PUT-to-uploadUrl flow is gone: presigned POST policies are the only
 * supported upload mechanism.
 */
export async function uploadWithPresignedPost(
  registration: UploadRegistration,
  file: File,
): Promise<ConfirmUploadResponse> {
  if (isDemoMode()) throw new ApiError('Uploads are not available in demo mode', 0);
  if (file.size <= 0) throw new ApiError('The selected file is empty.', 0);
  if (file.size > registration.maxBytes) {
    throw new ApiError(
      `The file exceeds the ${Math.max(1, Math.round(registration.maxBytes / (1024 * 1024)))} MB upload limit.`,
      0,
    );
  }

  // Field order matters for presigned POST policies: every policy field must
  // come before the file itself.
  const form = new FormData();
  for (const [name, value] of Object.entries(registration.fields ?? {})) {
    form.append(name, String(value));
  }
  form.append('file', file, file.name);

  let response: Response;
  try {
    response = await fetch(registration.postUrl, { method: 'POST', body: form });
  } catch {
    throw new ApiError('Could not reach file storage. Check your connection and try again.', 0);
  }
  if (!response.ok) {
    throw new ApiError('File storage rejected the upload. The file may be too large or of an unsupported type.', response.status);
  }

  // Ownership + size/type verification happens here; the file enters scanning.
  return api<ConfirmUploadResponse>('POST', '/storage/confirm', { key: registration.key });
}

/**
 * Friendly label + badge variant for a registry file's scan lifecycle state:
 * QUARANTINED/SCANNING show as "Processing…", APPROVED as success,
 * REJECTED/FAILED as destructive (with a malware-specific label when the
 * scan verdict is INFESTED).
 */
export function storedFileStatusView(file: Pick<StoredFile, 'status' | 'scanVerdict'>): FileStatusView {
  switch (file.status) {
    case 'APPROVED':
      return { label: file.scanVerdict === 'CLEAN' ? 'Approved · clean scan' : 'Approved', variant: 'success' };
    case 'SCANNING':
      return { label: 'Processing…', variant: 'warning' };
    case 'REJECTED':
      return {
        label: file.scanVerdict === 'INFESTED' ? 'Blocked (malware scan)' : 'Rejected',
        variant: 'destructive',
      };
    case 'FAILED':
      return { label: 'Failed', variant: 'destructive' };
    case 'QUARANTINED':
    default:
      return { label: 'Awaiting review', variant: 'warning' };
  }
}

/** Content types accepted by POST /storage/uploads for the given kind. */
export const UPLOAD_ACCEPT: Record<'campaign-image' | 'document' | 'avatar', string> = {
  'campaign-image': 'image/jpeg,image/png,image/webp',
  document: 'image/jpeg,image/png,image/webp,application/pdf',
  avatar: 'image/jpeg,image/png,image/webp',
};
