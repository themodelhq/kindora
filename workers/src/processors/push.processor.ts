/**
 * PUSH queue processor — `push` queue.
 *
 *   push.send {userId, title, body?, data?} → deliver to every registered
 *   PushSubscription of the user (dead 404/410 subscriptions are removed).
 */
import type { Job } from 'bullmq';

import { logInfo } from '../lib/logger';
import { sendToUser } from '../lib/push';

import type { JobHandler } from './email.processor';

async function handlePushSend(job: Job): Promise<void> {
  const { userId, title, body, data, url } = job.data as {
    userId?: string;
    title?: string;
    body?: string;
    data?: Record<string, unknown>;
    url?: string;
  };
  if (!userId || !title) {
    logInfo(`[push] push.send#${job.id ?? '-'} missing userId/title — nothing to deliver`);
    return;
  }
  // Producers may put the click target either in `url` or inside `data`.
  const payloadData: Record<string, unknown> = { ...(data ?? {}) };
  if (url && !payloadData['url']) payloadData['url'] = url;
  await sendToUser(userId, title, body, payloadData);
}

export const PUSH_HANDLERS: Record<string, JobHandler> = {
  'push.send': handlePushSend,
};
