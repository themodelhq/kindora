import { Queue } from 'bullmq';

import { getRedis } from './redis';

/** Must stay in sync with backend/src/common/queue.service.ts. */
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

/** Mirrors the backend producer defaults so job behaviour is identical either way. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 3000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

const queues = new Map<QueueName, Queue>();

/** Producer-side queue accessor (used for cross-queue fanout + cron scripts). */
export function getQueue(name: QueueName): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: getRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, queue);
  }
  return queue;
}

export async function enqueue(
  queue: QueueName,
  job: string,
  data: Record<string, unknown>,
  opts?: { delayMs?: number; jobId?: string },
): Promise<void> {
  await getQueue(queue).add(job, data, { delay: opts?.delayMs, jobId: opts?.jobId });
}

export async function closeQueues(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((q) => q.close().catch(() => undefined)));
}
