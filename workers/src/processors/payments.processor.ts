/**
 * PAYMENTS queue processor — `payments` queue.
 *
 *   payments.reconcile — flags stale PENDING donations (created more than
 *       30 minutes ago, provider != MANUAL) and emails an ops digest to
 *       ADMIN_EMAILS. Provider APIs are NOT called here: live status
 *       verification is executed by the backend verifyStatus flow (webhook
 *       + status endpoint). This job only logs the list, reports, and leaves
 *       the money state machine untouched. Read-only + digest email = safe
 *       under BullMQ retries (worst case: a duplicate digest email).
 *   webhook-retry — passthrough: webhook intake is synchronous in the
 *       backend (WebhookEvent rows); this job is acknowledged with a warning.
 *   recurring.charge-due — legacy scheduled-charge job (older producers);
 *       creates the PENDING cycle donation + advances the schedule in one
 *       transaction. Retained for backwards compatibility with jobs already
 *       sitting in the queue; new recurring cycles are produced by
 *       src/cron/recurring-donations.ts instead.
 */
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { randomBytes } from 'node:crypto';

import dayjs from '../lib/dayjs';
import { adminEmails } from '../lib/env';
import { escapeHtml, layout } from '../lib/templates';
import { logInfo, logWarn } from '../lib/logger';
import { sendEmail } from '../lib/mailer';
import { prisma } from '../lib/prisma';
import { enqueue, QUEUES } from '../lib/queues';

import type { JobHandler } from './email.processor';

const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
const STALE_BATCH = 200;
const DIGEST_MAX_LISTED = 25;

/** Unambiguous-alphabet public reference, same convention as the backend. */
function newPublicRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return `KDO-${out}`;
}

export function nextChargeFrom(from: Date, frequency: string): Date {
  const months = frequency === 'YEARLY' ? 12 : frequency === 'QUARTERLY' ? 3 : 1;
  return dayjs.utc(from).add(months, 'month').toDate();
}

async function handleReconcile(_job: Job): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const stale = await prisma.donation.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff }, provider: { notIn: ['MANUAL'] } },
    take: STALE_BATCH,
    orderBy: { createdAt: 'asc' },
    select: { id: true, publicRef: true, provider: true, createdAt: true, currency: true, amount: true },
  });

  if (stale.length === 0) {
    logInfo('[payments] reconcile: no stale PENDING donations older than 30 min');
    return;
  }

  logInfo(
    `[payments] reconcile: ${stale.length} stale PENDING donation(s) older than 30 min (provider != MANUAL): ` +
      stale.map((d) => `${d.publicRef}[${d.provider}]`).join(', '),
  );

  // Digest email to admins. No FraudSignal, no provider call, no state
  // change — verification is the backend verifyStatus flow's job.
  const recipients = adminEmails();
  if (recipients.length === 0) {
    logWarn('[payments] reconcile found stale donations but ADMIN_EMAILS is empty — digest skipped');
    return;
  }

  const listItems = stale
    .slice(0, DIGEST_MAX_LISTED)
    .map(
      (d) =>
        `<li style="margin:0 0 6px;">${escapeHtml(d.publicRef)} — ${escapeHtml(d.provider)} — ` +
        `created ${escapeHtml(d.createdAt.toISOString())}</li>`,
    )
    .join('');
  const truncated =
    stale.length > DIGEST_MAX_LISTED
      ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">…and ${stale.length - DIGEST_MAX_LISTED} more.</p>`
      : '';
  const html = layout(
    'Payments reconciliation digest',
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#334155;">` +
      `${stale.length} donation(s) have been PENDING for more than 30 minutes on a live provider. ` +
      `No provider API was called — run the backend verifyStatus flow or inspect these references:</p>` +
      `<ul style="margin:0 0 16px;padding-left:20px;font-size:13px;color:#334155;">${listItems}</ul>` +
      truncated +
      `<p style="margin:0;font-size:13px;color:#64748b;">Generated automatically by the payments.reconcile job.</p>`,
  );
  for (const to of recipients) {
    await sendEmail({
      to,
      subject: `KINDORA reconcile: ${stale.length} stale PENDING donation(s)`,
      html,
      template: 'reconcile-digest',
    }).catch((err) => logWarn(`[payments] digest email failed to ${to}: ${(err as Error).message}`));
  }
}

async function handleWebhookRetry(job: Job): Promise<void> {
  // Passthrough — the backend processes webhook events synchronously and
  // records every attempt in WebhookEvent; retrying from a worker would race
  // with the backend's signature verification and idempotent application.
  logWarn(
    `[payments] webhook-retry#${job.id ?? '-'} passthrough — webhook processing lives in the backend; ` +
      `payload=${JSON.stringify(job.data).slice(0, 300)}`,
  );
}

async function handleRecurringChargeDue(job: Job): Promise<void> {
  const { recurringDonationId, dueAt } = job.data as {
    recurringDonationId?: string;
    dueAt?: string;
  };
  if (!recurringDonationId) return;
  const rd = await prisma.recurringDonation.findUnique({ where: { id: recurringDonationId } });
  if (!rd) {
    logInfo(`[payments] recurring ${recurringDonationId} not found — skipping`);
    return;
  }
  if (rd.status !== 'ACTIVE') {
    logInfo(`[payments] recurring ${recurringDonationId} is ${rd.status} — skipping`);
    return;
  }
  // Idempotency across retries: the producer enqueues the due date it
  // observed; if the schedule has already advanced past it, this invocation
  // has nothing to do.
  const dueDate = dueAt ? new Date(dueAt) : rd.nextChargeAt;
  if (rd.lastChargeAt && rd.lastChargeAt.getTime() >= dueDate.getTime()) {
    logInfo(`[payments] recurring ${recurringDonationId} already charged for ${dueAt ?? 'this cycle'} — skipping`);
    return;
  }

  const now = new Date();
  const donation = await prisma.$transaction(async (tx) => {
    const created = await tx.donation.create({
      data: {
        publicRef: newPublicRef(),
        campaignId: rd.campaignId,
        donorUserId: rd.donorUserId,
        amount: rd.amount,
        currency: rd.currency,
        tipAmount: 0n,
        status: 'PENDING',
        provider: rd.provider,
        recurringDonationId: rd.id,
        metadata: {
          recurring: true,
          frequency: rd.frequency,
          dueAt: dueDate.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.recurringDonation.update({
      where: { id: rd.id },
      data: {
        nextChargeAt: nextChargeFrom(dueDate, rd.frequency),
        chargeCount: { increment: 1 },
        lastChargeAt: now,
        lastDonationId: created.id,
      },
    });
    return created;
  });

  await enqueue(QUEUES.EMAIL, 'email.recurring-due', {
    donationId: donation.id,
    donorUserId: rd.donorUserId,
  }).catch((err) => logWarn(`[payments] recurring-due email enqueue failed: ${(err as Error).message}`));
  logInfo(
    `[payments] recurring charge for ${rd.id}: created donation ${donation.publicRef}, ` +
      `next charge ${nextChargeFrom(dueDate, rd.frequency).toISOString()}`,
  );
}

export const PAYMENTS_HANDLERS: Record<string, JobHandler> = {
  'payments.reconcile': handleReconcile,
  'webhook-retry': handleWebhookRetry,
  'recurring.charge-due': handleRecurringChargeDue,
};
