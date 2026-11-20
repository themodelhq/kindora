/**
 * KINDORA background worker — consumes every BullMQ queue the backend
 * produces. Deployed as ONE Render Background Worker (`npm run start:prod`).
 *
 * Queue → job matrix:
 *   email          email.receipt | email.donation-receipt, email.donation-organizer,
 *                  email.verify-email, email.password-reset, email.campaign-approved,
 *                  email.campaign-update, email.campaign-reminder, email.refund-processed,
 *                  email.weekly-report, email.recurring-due
 *   push           push.send
 *   notifications  notifications.campaign-update
 *   analytics      analytics.record-donation, analytics.recompute-day
 *   media          media.process-image (sharp WebP/JPEG variant pipeline),
 *                  media.scan-file (malware scan lifecycle, fail-safe)
 *   fraud          fraud.score-donation
 *   payments       payments.reconcile, webhook-retry (passthrough), recurring.charge-due
 *   payouts        payouts.submit-outbox, payouts.verify-attempt, payouts.recovery (v1.0.7)
 *   reports        report.generate {kind:'weekly'}, report.weekly (alias)
 *
 * Behaviour contract:
 *  - REDIS_URL is REQUIRED; the process exits 1 without it.
 *  - Unknown job names are acknowledged and dropped (never crash the consumer).
 *  - Handler errors are logged and rethrown so BullMQ retries with exponential
 *    backoff (attempts: 5, delay: 3000 — mirrors the backend producer defaults).
 *  - When the LAST attempt fails (worker 'failed' with attemptsMade >= attempts)
 *    a CRITICAL line is logged for log-based alerting.
 *  - SIGTERM/SIGINT drain all workers before exiting 0.
 */
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import { ANALYTICS_HANDLERS } from './processors/analytics.processor';
import { EMAIL_HANDLERS, type JobHandler } from './processors/email.processor';
import { FRAUD_HANDLERS } from './processors/fraud.processor';
import { MEDIA_HANDLERS } from './processors/media.processor';
import { NOTIFICATIONS_HANDLERS } from './processors/notifications.processor';
import { PAYOUTS_HANDLERS, scheduleRecovery } from './processors/payouts.processor';
import { PAYMENTS_HANDLERS } from './processors/payments.processor';
import { PUSH_HANDLERS } from './processors/push.processor';
import { REPORTS_HANDLERS } from './processors/reports.processor';
import { disconnectPrisma } from './lib/prisma';
import { closeQueues, QUEUES, type QueueName } from './lib/queues';
import { closeRedis, getRedis, requireRedisUrl } from './lib/redis';
import { logError, logInfo, logWarn } from './lib/logger';

const SHUTDOWN_TIMEOUT_MS = 20_000;

/**
 * Wraps a handler map into a BullMQ processor: unknown job names are
 * acknowledged and dropped; known jobs run in a try/catch that logs and
 * RETHROWS so BullMQ applies its retry/backoff policy.
 */
function processorFor(queueName: QueueName, handlers: Record<string, JobHandler>) {
  return async (job: Job): Promise<void> => {
    const handler = handlers[job.name];
    if (!handler) {
      // Unknown job names are ack'd and dropped — a mismatched producer
      // must never crash the consumer.
      logWarn(`[${queueName}] no handler for job "${job.name}" — acknowledging`);
      return;
    }
    try {
      await handler(job);
    } catch (err) {
      logError(
        `[${queueName}] job ${job.name}#${job.id ?? '-'} failed (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? '?'})`,
        err instanceof Error ? err.message : err,
      );
      throw err; // BullMQ retries with exponential backoff
    }
  };
}

const WORKER_SPECS: { name: QueueName; concurrency: number; handlers: Record<string, JobHandler> }[] = [
  { name: QUEUES.EMAIL, concurrency: 5, handlers: EMAIL_HANDLERS },
  { name: QUEUES.PUSH, concurrency: 10, handlers: PUSH_HANDLERS },
  { name: QUEUES.NOTIFICATIONS, concurrency: 5, handlers: NOTIFICATIONS_HANDLERS },
  { name: QUEUES.ANALYTICS, concurrency: 5, handlers: ANALYTICS_HANDLERS },
  { name: QUEUES.MEDIA, concurrency: 2, handlers: MEDIA_HANDLERS },
  { name: QUEUES.FRAUD, concurrency: 5, handlers: FRAUD_HANDLERS },
  { name: QUEUES.PAYMENTS, concurrency: 3, handlers: PAYMENTS_HANDLERS },
  { name: QUEUES.PAYOUTS, concurrency: 2, handlers: PAYOUTS_HANDLERS },
  { name: QUEUES.REPORTS, concurrency: 2, handlers: REPORTS_HANDLERS },
];

const workers: Worker[] = [];
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`[worker] ${signal} received — draining ${workers.length} worker(s)...`);
  const forceTimer = setTimeout(() => {
    logWarn('[worker] shutdown timeout — forcing exit 0');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();
  try {
    await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
    await closeQueues();
    await disconnectPrisma();
    await closeRedis();
    logInfo('[worker] clean shutdown complete');
    process.exit(0);
  } catch (err) {
    logError('[worker] error during shutdown', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  logInfo('[worker] booting KINDORA background worker...');

  // Redis is mandatory for queue consumers — exits 1 with a clear message
  // when REDIS_URL is missing.
  requireRedisUrl();
  const redis = getRedis();
  try {
    await redis.ping();
  } catch (err) {
    logError(`FATAL: cannot reach Redis (${process.env.REDIS_URL}): ${(err as Error).message}`);
    process.exit(1);
  }
  logInfo('[worker] redis connection verified');

  for (const spec of WORKER_SPECS) {
    const worker = new Worker(spec.name, processorFor(spec.name, spec.handlers), {
      connection: redis,
      concurrency: spec.concurrency,
    });
    worker.on('error', (err) => logError(`[worker:${spec.name}] worker error`, err.message));
    worker.on('failed', (job, err) => {
      const attempts = job?.opts.attempts ?? 5;
      const attemptsMade = job?.attemptsMade ?? 0;
      if (job && attemptsMade >= attempts) {
        // Final failure after all retries — escalate for alerting.
        logError(
          `CRITICAL: [worker:${spec.name}] job ${job.name}#${job.id ?? '?'} permanently failed after ${attemptsMade}/${attempts} attempts — manual intervention required`,
          err.message,
        );
      } else {
        logError(
          `[worker:${spec.name}] job ${job?.name ?? '?'}#${job?.id ?? '?'} failed (attempt ${attemptsMade}/${attempts}, will retry)`,
          err.message,
        );
      }
    });
    worker.on('completed', (job) => logInfo(`[worker:${spec.name}] ${job.name}#${job.id ?? '?'} completed`));
    workers.push(worker);
  }

  logInfo(`[worker] online — queues: ${workers.map((w) => w.name).join(', ')}`);
  // v1.0.7 — payout outbox/verification recovery producer (idempotent pass).
  scheduleRecovery();

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logError('[worker] unhandled rejection', reason));
  process.on('uncaughtException', (err) => {
    logError('[worker] uncaught exception — exiting 1', err.message);
    process.exit(1);
  });
}

void main().catch((err) => {
  logError('FATAL: worker boot failed', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
