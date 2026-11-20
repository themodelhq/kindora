import webpush from 'web-push';

import { logInfo, logWarn } from './logger';
import { prisma } from './prisma';

export interface PushSubscriptionLike {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

let vapidConfigured = false;

function ensureVapid(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT?.trim() || 'mailto:hello@kindora.com',
      publicKey,
      privateKey,
    );
    vapidConfigured = true;
  }
  return true;
}

/**
 * Sends one web push message. Push is best-effort: delivery errors are
 * logged (never thrown) so one bad subscription cannot fail a whole
 * notifications fanout. Subscriptions rejected with HTTP 404/410 are gone —
 * the PushSubscription row is deleted so we stop trying forever.
 */
export async function sendPush(
  subscription: PushSubscriptionLike,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!ensureVapid()) {
    logWarn('[push] VAPID keys not configured — skipping push delivery');
    return false;
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24 },
    );
    return true;
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => undefined);
      logInfo(`[push] removed dead subscription ${subscription.id} (HTTP ${statusCode})`);
      return false;
    }
    logWarn(`[push] delivery failed for subscription ${subscription.id}: ${(err as Error).message}`);
    return false;
  }
}

export interface SendToUserInput {
  userId: string;
  title: string;
  body?: string;
  /** Arbitrary payload carried to the service worker (click url, ids...). */
  data?: Record<string, unknown>;
}

/**
 * Delivers one notification to every registered push subscription of a user.
 * Never throws — push delivery is best-effort by design; the caller logs the
 * returned delivery count.
 */
export async function sendToUser(userId: string, title: string, body?: string, data?: Record<string, unknown>): Promise<number> {
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) {
    logInfo(`[push] no subscriptions for user ${userId}`);
    return 0;
  }
  const payload = { title, body: body ?? '', ...(data ?? {}) };
  let delivered = 0;
  for (const subscription of subscriptions) {
    const ok = await sendPush(subscription, payload);
    if (ok) delivered += 1;
  }
  logInfo(`[push] delivered ${delivered}/${subscriptions.length} for user ${userId}`);
  return delivered;
}
