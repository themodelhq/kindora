import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

export const QUEUES = {
  EMAIL: 'email',
  PUSH: 'push',
  ANALYTICS: 'analytics',
  MEDIA: 'media',
  FRAUD: 'fraud',
  PAYMENTS: 'payments',
  PAYOUTS: 'payouts',
  REPORTS: 'reports',
  NOTIFICATIONS: 'notifications',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Backend-side queue producer. Jobs are consumed by the separate
 * kindora-worker service (see /workers). Without REDIS_URL the producer
 * degrades gracefully: it logs the intent and returns (local dev without
 * Redis still works; production deployments always configure Redis).
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private connection: Redis | null = null;

  private getConnection(): Redis | null {
    const url = process.env.REDIS_URL ?? '';
    if (!url) return null;
    if (!this.connection) {
      this.connection = new Redis(url, { maxRetriesPerRequest: null });
    }
    return this.connection;
  }

  private getQueue(name: QueueName): Queue | null {
    const connection = this.getConnection();
    if (!connection) return null;
    if (!this.queues.has(name)) {
      this.queues.set(
        name,
        new Queue(name, {
          connection,
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: { count: 1000 },
            removeOnFail: { count: 5000 },
          },
        }),
      );
    }
    return this.queues.get(name)!;
  }

  async enqueue(queue: QueueName, job: string, data: Record<string, unknown>, opts?: { delayMs?: number; jobId?: string }) {
    const q = this.getQueue(queue);
    if (!q) {
      this.logger.warn(`[inline-drop] ${queue}.${job} (REDIS_URL not configured) data=${JSON.stringify(data).slice(0, 300)}`);
      return null;
    }
    try {
      return await q.add(job, data, {
        delay: opts?.delayMs,
        jobId: opts?.jobId,
      });
    } catch (err) {
      this.logger.error(`enqueue failed ${queue}.${job}: ${(err as Error).message}`);
      return null;
    }
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    if (this.connection) await this.connection.quit().catch(() => this.connection?.disconnect());
  }
}
