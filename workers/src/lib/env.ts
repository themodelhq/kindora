/**
 * Common environment helpers shared by the queue consumers (src/index.ts)
 * and the standalone cron scripts (src/cron/*).
 */

export function frontendUrl(): string {
  return (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

export function backendUrl(): string {
  return (process.env.BACKEND_URL ?? 'http://localhost:10000').replace(/\/+$/, '');
}

/** ADMIN_EMAILS is a comma-separated list; empty entries are dropped. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * PROVIDER_MODE: "mock" = deterministic in-process providers (dev/tests —
 * no network); anything else (typically "live") talks to real provider APIs.
 * Defaults to mock so a missing env never triggers real charges.
 */
export function isProviderMock(): boolean {
  return (process.env.PROVIDER_MODE ?? 'mock').trim().toLowerCase() === 'mock';
}

/**
 * WORKER_INGEST_TOKEN — shared secret for the backend internal payout
 * endpoints (v1.0.7 §12). The worker NEVER mutates financial state itself:
 * it calls the backend /internal/payouts endpoints with this token. Without
 * a token the payout jobs fail safe (the backend's in-process sweeper still
 * drives the durable outbox).
 */
export function workerIngestToken(): string | null {
  const token = process.env.WORKER_INGEST_TOKEN?.trim();
  return token ? token : null;
}

/** Trimmed Paystack secret, or null when unset. NEVER log the value. */
export function paystackSecretKey(): string | null {
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
  return secret ? secret : null;
}

/**
 * HTTP malware-scan service (e.g. a ClamAV REST bridge), or null when no
 * scanner is configured — the media scan flow then fails safe (public media
 * is approved via the re-encoding pipeline, sensitive documents stay
 * quarantined).
 */
export function malwareScanEndpoint(): string | null {
  const endpoint = process.env.MALWARE_SCAN_ENDPOINT?.trim();
  return endpoint ? endpoint.replace(/\/+$/, '') : null;
}

/** Object-storage settings, or null when the STORAGE_* env is incomplete. */
export interface StorageSettings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export function storageSettings(): StorageSettings | null {
  const endpoint = process.env.STORAGE_ENDPOINT?.trim();
  const bucket = process.env.STORAGE_BUCKET?.trim();
  const accessKey = process.env.STORAGE_ACCESS_KEY?.trim();
  const secretKey = process.env.STORAGE_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint,
    bucket,
    region: process.env.STORAGE_REGION?.trim() || 'us-east-1',
    accessKey,
    secretKey,
    forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true').trim().toLowerCase() !== 'false',
  };
}
