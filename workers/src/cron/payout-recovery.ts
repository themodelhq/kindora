/**
 * Cron: payout recovery sweep (Render Cron Job → `npm run cron:payout-recovery`).
 *
 * v1.0.7 §4.4/§12 — asks the backend to drive the durable payout outbox:
 * due submissions, pending verifications and stale unknown escalation. ALL
 * financial logic lives in the backend; this script is a token-authenticated
 * trigger with Redis-set lock protection for overlapping cron schedules.
 *
 * Exit codes: 0 ok (or not configured), 1 ingest failure after retries.
 */
import { backendUrl, workerIngestToken } from '../lib/env';
import { logError, logInfo, logWarn } from '../lib/logger';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';

const NAME = 'payout-recovery';
const LOCK_TTL_MS = 5 * 60 * 1000;

async function work(): Promise<string> {
  const token = workerIngestToken();
  if (!token) {
    logWarn('[payout-recovery] WORKER_INGEST_TOKEN is not configured — the backend in-process sweeper owns recovery');
    return 'not configured (backend sweeper owns recovery)';
  }
  const res = await fetch(`${backendUrl()}/api/v1/internal/payouts/recovery-sweep`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-token': token },
    body: '{}',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`recovery-sweep failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  logInfo(`[payout-recovery] backend responded: ${text.slice(0, 300)}`);
  return 'recovery sweep dispatched';
}

async function main(): Promise<void> {
  const locked = await acquireLock(NAME, LOCK_TTL_MS).catch(() => null);
  if (locked === null) {
    logWarn(`[payout-recovery] another instance holds the lock — exiting`);
    process.exit(0);
  }
  try {
    const message = await work();
    logInfo(`[payout-recovery] done: ${message}`);
  } catch (err) {
    logError('[payout-recovery] failed', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    if (locked !== null) await releaseLock(NAME, locked).catch(() => undefined);
    await closeRedis().catch(() => undefined);
  }
}

void main();
