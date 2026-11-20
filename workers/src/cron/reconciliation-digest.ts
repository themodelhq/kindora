/**
 * Cron: reconciliation digest (Render Cron Job → `npm run cron:reconciliation-digest`).
 *
 * Self-contained script (Prisma + Redis SET NX PX lock, released on exit).
 * Collects two operational counts and emails a digest to ADMIN_EMAILS:
 *   - WebhookEvent rows with status FAILED created in the last 24h, and
 *   - stale PENDING donations (created more than 30 minutes ago on a live
 *     provider — provider != MANUAL).
 * No provider APIs are called and no state changes: verification of live
 * provider status is the backend verifyStatus flow's responsibility. When
 * there is nothing to report the script logs an all-clear and sends nothing.
 */
import { escapeHtml, layout } from '../lib/templates';
import { logError, logInfo, logWarn } from '../lib/logger';
import { sendEmail } from '../lib/mailer';
import { disconnectPrisma, prisma } from '../lib/prisma';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';
import { adminEmails } from '../lib/env';

const NAME = 'reconciliation-digest';
const LOCK_TTL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;
const LIST_LIMIT = 20;

async function work(): Promise<string> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const staleCutoff = new Date(Date.now() - STALE_AFTER_MS);

  const [failedWebhooks, failedWebhookCount, staleDonations, staleCount] = await Promise.all([
    prisma.webhookEvent.findMany({
      where: { status: 'FAILED', createdAt: { gte: since24h } },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      select: { provider: true, eventType: true, reference: true, error: true, createdAt: true },
    }),
    prisma.webhookEvent.count({ where: { status: 'FAILED', createdAt: { gte: since24h } } }),
    prisma.donation.findMany({
      where: { status: 'PENDING', createdAt: { lt: staleCutoff }, provider: { notIn: ['MANUAL'] } },
      orderBy: { createdAt: 'asc' },
      take: LIST_LIMIT,
      select: { publicRef: true, provider: true, createdAt: true },
    }),
    prisma.donation.count({
      where: { status: 'PENDING', createdAt: { lt: staleCutoff }, provider: { notIn: ['MANUAL'] } },
    }),
  ]);

  if (failedWebhookCount === 0 && staleCount === 0) {
    logInfo(`[cron:${NAME}] all clear — 0 failed webhook events (24h), 0 stale PENDING donations`);
    return 'all clear (nothing emailed)';
  }

  const recipients = adminEmails();
  if (recipients.length === 0) {
    logWarn(
      `[cron:${NAME}] ${failedWebhookCount} failed webhook(s) and ${staleCount} stale PENDING donation(s) found ` +
        `but ADMIN_EMAILS is empty — digest skipped`,
    );
    return `found ${failedWebhookCount} failed webhook(s), ${staleCount} stale donation(s); ADMIN_EMAILS empty`;
  }

  const webhookItems =
    failedWebhooks
      .map(
        (w) =>
          `<li style="margin:0 0 6px;">${escapeHtml(w.provider)} · ${escapeHtml(w.eventType ?? 'unknown')} · ` +
          `${escapeHtml(w.reference ?? 'no reference')} · ${escapeHtml(w.createdAt.toISOString())}` +
          `${w.error ? ` — ${escapeHtml(w.error.slice(0, 160))}` : ''}</li>`,
      )
      .join('') || `<li style="margin:0 0 6px;">none</li>`;
  const staleItems =
    staleDonations
      .map(
        (d) =>
          `<li style="margin:0 0 6px;">${escapeHtml(d.publicRef)} · ${escapeHtml(d.provider)} · ` +
          `pending since ${escapeHtml(d.createdAt.toISOString())}</li>`,
      )
      .join('') || `<li style="margin:0 0 6px;">none</li>`;

  const html = layout(
    'Payments reconciliation digest',
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#334155;">` +
      `Last 24 hours: <strong>${failedWebhookCount}</strong> FAILED webhook event(s) and ` +
      `<strong>${staleCount}</strong> stale PENDING donation(s) older than 30 minutes. ` +
      `No provider API was called — verify via the backend verifyStatus flow.</p>` +
      `<p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#0f172a;">Failed webhook events (latest ${LIST_LIMIT})</p>` +
      `<ul style="margin:0 0 16px;padding-left:20px;font-size:13px;color:#334155;">${webhookItems}</ul>` +
      `<p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#0f172a;">Stale PENDING donations (oldest ${LIST_LIMIT})</p>` +
      `<ul style="margin:0 0 16px;padding-left:20px;font-size:13px;color:#334155;">${staleItems}</ul>` +
      `<p style="margin:0;font-size:13px;color:#64748b;">Generated automatically by the reconciliation-digest cron.</p>`,
  );

  let emailed = 0;
  for (const to of recipients) {
    await sendEmail({
      to,
      subject: `KINDORA reconciliation digest: ${failedWebhookCount} failed webhook(s), ${staleCount} stale donation(s)`,
      html,
      template: 'reconciliation-digest',
    });
    emailed += 1;
  }

  return `digest emailed to ${emailed} admin(s) — ${failedWebhookCount} failed webhook(s), ${staleCount} stale PENDING donation(s)`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let owner: string | null = null;
  let exitCode = 0;
  try {
    owner = await acquireLock(`cron:${NAME}`, LOCK_TTL_MS);
    if (!owner) {
      logInfo(`[cron:${NAME}] lock held by another instance — exiting 0`);
    } else {
      const summary = await work();
      logInfo(`[cron:${NAME}] done in ${Date.now() - startedAt}ms — ${summary}`);
    }
  } catch (err) {
    exitCode = 1;
    logError(
      `[cron:${NAME}] failed after ${Date.now() - startedAt}ms`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
  } finally {
    if (owner) {
      await releaseLock(`cron:${NAME}`, owner).catch((err) =>
        logError(`[cron:${NAME}] lock release failed: ${(err as Error).message}`),
      );
    }
    await disconnectPrisma().catch(() => undefined);
    await closeRedis().catch(() => undefined);
  }
  process.exit(exitCode);
}

process.on('unhandledRejection', (reason) => logError(`[cron:${NAME}] unhandled rejection`, reason));
process.on('uncaughtException', (err) => {
  logError(`[cron:${NAME}] uncaught exception — exiting 1`, err.message);
  process.exit(1);
});

void main();
