/**
 * PAYOUTS queue processor — `payouts` queue (v1.0.7 §12).
 *
 * The worker is a RELIABLE TRIGGER only: every financial state mutation
 * happens inside the backend services (single owner of the payout state
 * machine). Each handler POSTs to the backend internal payout endpoints
 * with the WORKER_INGEST_TOKEN shared secret and lets BullMQ retry with
 * exponential backoff when the backend is unreachable (attempts: 5,
 * delay: 3000 — the producer defaults).
 *
 *   payouts.submit-outbox   { attemptId }  — drive a committed initiation intent
 *   payouts.verify-attempt  { attemptId }  — authoritative provider verification
 *   payouts.recovery        {}             — outbox sweep + escalation + re-verify
 *
 * Guarantees:
 *  - Idempotent end to end: the backend claims the outbox row durably
 *    (conditional UPDATE), so a duplicate queue message can never produce a
 *    duplicate provider transfer.
 *  - A failed verification request NEVER becomes a failed payout: the backend
 *    classifies transport failures as UNKNOWN and keeps the reservation.
 *  - Without WORKER_INGEST_TOKEN every job is acknowledged with a warning —
 *    the backend's in-process outbox sweeper is the crash-recovery floor.
 */
import type { Job } from 'bullmq';

import { backendUrl, workerIngestToken } from '../lib/env';
import { logError, logInfo, logWarn } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { QUEUES, enqueue } from '../lib/queues';

import type { JobHandler } from './email.processor';

const INGEST_TIMEOUT_MS = 30_000;

async function ingest(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const token = workerIngestToken();
  if (!token) {
    // Fail safe: no token configured — the in-process backend sweeper owns
    // the work. Acknowledge so the job does not retry forever.
    throw new IngestNotConfiguredError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${backendUrl()}/api/v1/internal/payouts/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-token': token },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

class IngestNotConfiguredError extends Error {
  constructor() {
    super('WORKER_INGEST_TOKEN is not configured — payout jobs are handled by the backend sweeper');
    this.name = 'IngestNotConfiguredError';
  }
}

const submitOutbox: JobHandler = async (job: Job) => {
  const { attemptId } = job.data as { attemptId?: string };
  if (!attemptId) return; // malformed job — acknowledge
  try {
    const result = await ingest('outbox/submit', { attemptId });
    if (!result.ok) {
      // The backend rejected or errored — rethrow so BullMQ retries. The
      // backend never partially mutates state (single transaction per outcome).
      throw new Error(`submit-outbox failed: HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`);
    }
  } catch (err) {
    if (err instanceof IngestNotConfiguredError) {
      logWarn(`[payouts] ${err.message}`);
      return;
    }
    throw err;
  }
};

const verifyAttempt: JobHandler = async (job: Job) => {
  const { attemptId, correlationId } = job.data as { attemptId?: string; correlationId?: string };
  if (!attemptId) return;
  try {
    const result = await ingest('attempts/verify', { attemptId, correlationId });
    if (!result.ok) {
      throw new Error(`verify-attempt failed: HTTP ${result.status} ${JSON.stringify(result.data).slice(0, 200)}`);
    }
  } catch (err) {
    if (err instanceof IngestNotConfiguredError) {
      logWarn(`[payouts] ${err.message}`);
      return;
    }
    throw err;
  }
};

const recovery: JobHandler = async () => {
  try {
    const result = await ingest('recovery-sweep', {});
    if (!result.ok) {
      throw new Error(`recovery-sweep failed: HTTP ${result.status}`);
    }
    logInfo(`[payouts] recovery sweep: ${JSON.stringify(result.data).slice(0, 300)}`);
  } catch (err) {
    if (err instanceof IngestNotConfiguredError) {
      logWarn(`[payouts] ${err.message}`);
      return;
    }
    throw err;
  }
};

export const PAYOUTS_HANDLERS: Record<string, JobHandler> = {
  'payouts.submit-outbox': submitOutbox,
  'payouts.verify-attempt': verifyAttempt,
  'payouts.recovery': recovery,
};

/** Interval producer: enqueues a recovery pass every 5 minutes (idempotent). */
export function scheduleRecovery(): void {
  const fiveMinutes = 5 * 60_000;
  const loop = async (): Promise<void> => {
    try {
      await enqueue(QUEUES.PAYOUTS, 'payouts.recovery', {}, { jobId: `recovery:${Date.now()}` });
    } catch (err) {
      logError('[payouts] failed to enqueue recovery job', err instanceof Error ? err.message : String(err));
    }
  };
  void loop();
  const timer = setInterval(() => void loop(), fiveMinutes);
  timer.unref?.();
  void prisma; // prisma is not used here; imported for parity with other processors
}
