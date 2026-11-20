/**
 * EMAIL queue processor — `email` queue.
 *
 * Job → behaviour:
 *   email.receipt            (alias) donor receipt for a SUCCEEDED donation
 *   email.donation-receipt   donor receipt — backend producer name
 *   email.donation-organizer organizer "new donation" notice
 *   email.verify-email       account email verification link
 *   email.password-reset     password reset link
 *   email.campaign-approved  organizer notice after admin approval
 *   email.campaign-update    fanout to all distinct donor emails of a
 *                            campaign (respects NotificationPreference
 *                            .emailUpdates === false; guests have no
 *                            preference row and are treated as opted-in)
 *   email.campaign-reminder  organizer deadline reminder
 *   email.refund-processed   donor refund confirmation
 *   email.weekly-report      weekly platform report to ADMIN_EMAILS
 *   email.recurring-due      recurring donation due notice
 *   email.recurring-receipt  recurring charge success receipt (mandated subject,
 *                            deduped via a durable IdempotencyKey per donation)
 *   email.recurring-failed   recurring charge failure + retry info (donor)
 *   email.recurring-failed-organizer  recurring charge failure (organizer)
 *
 * Handlers deliberately do not try/catch: errors propagate to the worker
 * wrapper in src/index.ts, which logs and rethrows so BullMQ retries with
 * exponential backoff (attempts: 5).
 */
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { frontendUrl } from '../lib/env';
import { formatMoney, majorValue } from '../lib/format';
import { logInfo, logWarn } from '../lib/logger';
import { sendEmail } from '../lib/mailer';
import { prisma } from '../lib/prisma';
import {
  campaignApproved,
  campaignEndingSoon,
  campaignUpdateNotice,
  donationOrganizer,
  donationReceipt,
  passwordReset,
  recurringChargeFailed,
  recurringChargeFailedOrganizer,
  recurringDueReminder,
  refundProcessed,
  verifyEmail,
} from '../lib/templates';
import { computeWeeklySummary, sendWeeklyReportEmail } from '../lib/weekly-report';

export type JobHandler = (job: Job) => Promise<void>;

/** Keep in sync with FAILURE_PAUSE_THRESHOLD in src/cron/recurring-donations.ts. */
const RECURRING_PAUSE_AFTER_FAILURES = 3;
const IDEMPOTENCY_TTL_DAYS = 30;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function handleDonationReceipt(job: Job): Promise<void> {
  const { donationId } = job.data as { donationId: string; donorUserId?: string };
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      publicRef: true,
      amount: true,
      tipAmount: true,
      currency: true,
      receiptNumber: true,
      isAnonymous: true,
      donorUserId: true,
      donor: { select: { id: true, email: true, firstName: true } },
      guestEmail: true,
      guestName: true,
      campaign: { select: { slug: true, title: true } },
    },
  });
  if (!donation) return; // row gone — nothing to do
  const to = donation.donor?.email ?? donation.guestEmail;
  if (!to) {
    logWarn(`[email] donation-receipt for ${donationId}: no recipient email — skipping`);
    return;
  }
  const donorName = donation.isAnonymous
    ? 'friend'
    : (donation.donor?.firstName ?? donation.guestName ?? 'friend');
  const amountFormatted = formatMoney(donation.amount + donation.tipAmount, donation.currency);
  const receiptNumber = donation.receiptNumber ?? donation.publicRef;
  const campaignUrl = `${frontendUrl()}/campaigns/${donation.campaign.slug}`;
  const tpl = donationReceipt(donorName, donation.campaign.title, amountFormatted, receiptNumber, campaignUrl);

  // Idempotency guard: the subject embeds the donation-unique receipt number,
  // so a previously SENT EmailLog with the exact same template+subject means
  // this receipt has already gone out (BullMQ redelivery / double enqueue).
  const alreadySent = await prisma.emailLog.findFirst({
    where: { template: 'donation-receipt', subject: tpl.subject, status: 'SENT' },
    select: { id: true },
  });
  if (alreadySent) {
    logInfo(`[email] donation-receipt for ${donationId} already sent (receipt ${receiptNumber}) — skipping duplicate`);
    return;
  }

  await sendEmail({
    to,
    userId: donation.donorUserId ?? null,
    subject: tpl.subject,
    html: tpl.html,
    template: 'donation-receipt',
  });
}

async function handleDonationOrganizer(job: Job): Promise<void> {
  const { donationId } = job.data as { donationId: string };
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      publicRef: true,
      amount: true,
      currency: true,
      isAnonymous: true,
      donor: { select: { firstName: true, lastName: true } },
      guestName: true,
      campaign: { select: { title: true, createdBy: { select: { id: true, email: true, firstName: true } } } },
    },
  });
  if (!donation) return;
  const organizer = donation.campaign.createdBy;
  if (!organizer?.email) {
    logWarn(`[email] donation-organizer for ${donationId}: organizer has no email — skipping`);
    return;
  }
  const donorDisplay = donation.isAnonymous
    ? 'Anonymous donor'
    : donation.donor
      ? `${donation.donor.firstName} ${donation.donor.lastName.charAt(0).toUpperCase()}.`
      : (donation.guestName ?? 'Anonymous donor');
  const amountFormatted = formatMoney(donation.amount, donation.currency);
  const tpl = donationOrganizer(
    organizer.firstName,
    donation.campaign.title,
    donorDisplay,
    amountFormatted,
    donation.publicRef,
  );
  await sendEmail({
    to: organizer.email,
    userId: organizer.id,
    subject: tpl.subject,
    html: tpl.html,
    template: 'donation-organizer',
  });
}

async function handleVerifyEmail(job: Job): Promise<void> {
  const { email, userId, token, name } = job.data as {
    email: string;
    userId?: string;
    token: string;
    name?: string;
  };
  let firstName = name?.trim() || '';
  if (!firstName && userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true } });
    firstName = user?.firstName ?? '';
  }
  const link = `${frontendUrl()}/auth/verify?token=${encodeURIComponent(token)}`;
  const tpl = verifyEmail(firstName, link);
  await sendEmail({ to: email, userId: userId ?? null, subject: tpl.subject, html: tpl.html, template: 'verify-email' });
}

async function handlePasswordReset(job: Job): Promise<void> {
  const { email, userId, token } = job.data as { email: string; userId?: string; token: string };
  let firstName = '';
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true } });
    firstName = user?.firstName ?? '';
  }
  const link = `${frontendUrl()}/auth/reset?token=${encodeURIComponent(token)}`;
  const tpl = passwordReset(firstName, link);
  await sendEmail({ to: email, userId: userId ?? null, subject: tpl.subject, html: tpl.html, template: 'password-reset' });
}

async function handleCampaignApproved(job: Job): Promise<void> {
  const { campaignId } = job.data as { campaignId: string };
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { slug: true, title: true, createdBy: { select: { id: true, email: true, firstName: true } } },
  });
  if (!campaign?.createdBy?.email) return;
  const campaignUrl = `${frontendUrl()}/campaigns/${campaign.slug}`;
  const tpl = campaignApproved(campaign.createdBy.firstName, campaign.title, campaignUrl);
  await sendEmail({
    to: campaign.createdBy.email,
    userId: campaign.createdBy.id,
    subject: tpl.subject,
    html: tpl.html,
    template: 'campaign-approved',
  });
}

async function handleCampaignUpdateEmail(job: Job): Promise<void> {
  const { campaignId, updateId, updateTitle, campaignTitle } = job.data as {
    campaignId: string;
    updateId?: string;
    updateTitle: string;
    campaignTitle?: string;
  };
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { slug: true, title: true },
  });
  if (!campaign) return;
  const title = campaignTitle ?? campaign.title;
  const campaignUrl = `${frontendUrl()}/campaigns/${campaign.slug}`;

  // Registered donors: distinct SUCCEEDED donors, excluding those who turned
  // campaign-update emails off (NotificationPreference.emailUpdates === false).
  const donorRows = await prisma.donation.findMany({
    where: { campaignId, status: 'SUCCEEDED', donorUserId: { not: null } },
    distinct: ['donorUserId'],
    take: 500,
    select: { donorUserId: true, donor: { select: { id: true, email: true, firstName: true } } },
  });
  const optedOut = new Set(
    (
      await prisma.notificationPreference.findMany({
        where: { userId: { in: donorRows.map((d) => d.donorUserId ?? '') }, emailUpdates: false },
        select: { userId: true },
      })
    ).map((p) => p.userId),
  );

  // Guest donors have no NotificationPreference row — treated as opted-in.
  const guestRows = await prisma.donation.findMany({
    where: { campaignId, status: 'SUCCEEDED', guestEmail: { not: null } },
    distinct: ['guestEmail'],
    take: 500,
    select: { guestEmail: true },
  });

  const seen = new Set<string>();
  const recipients: { email: string; userId: string | null; firstName: string }[] = [];
  for (const row of donorRows) {
    const donor = row.donor;
    if (!donor?.email || optedOut.has(donor.id)) continue;
    const key = donor.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ email: donor.email, userId: donor.id, firstName: donor.firstName });
  }
  for (const row of guestRows) {
    if (!row.guestEmail) continue;
    const key = row.guestEmail.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ email: row.guestEmail, userId: null, firstName: '' });
  }

  let sent = 0;
  for (const recipient of recipients) {
    const tpl = campaignUpdateNotice(recipient.firstName, title, updateTitle, campaignUrl);
    await sendEmail({
      to: recipient.email,
      userId: recipient.userId,
      subject: tpl.subject,
      html: tpl.html,
      template: 'campaign-update',
    });
    sent += 1;
  }
  logInfo(
    `[email] campaign-update "${updateTitle}" mailed to ${sent} recipient(s)` +
      (optedOut.size > 0 ? ` (${optedOut.size} opted out via preferences)` : '') +
      (updateId ? ` [update ${updateId}]` : ''),
  );
}

async function handleCampaignReminder(job: Job): Promise<void> {
  const { campaignSlug, campaignTitle, daysLeft, organizerUserId } = job.data as {
    campaignId: string;
    campaignSlug?: string;
    campaignTitle: string;
    daysLeft: number;
    organizerUserId?: string;
  };
  if (!organizerUserId) return;
  const organizer = await prisma.user.findUnique({
    where: { id: organizerUserId },
    select: { id: true, email: true },
  });
  if (!organizer?.email) return;
  const campaignUrl = `${frontendUrl()}/campaigns/${campaignSlug ?? ''}`;
  const tpl = campaignEndingSoon(campaignTitle, daysLeft, campaignUrl);
  await sendEmail({
    to: organizer.email,
    userId: organizer.id,
    subject: tpl.subject,
    html: tpl.html,
    template: 'campaign-reminder',
  });
}

async function handleRefundProcessed(job: Job): Promise<void> {
  const { donationId } = job.data as { donationId: string };
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      publicRef: true,
      amount: true,
      currency: true,
      donorUserId: true,
      donor: { select: { id: true, email: true } },
      guestEmail: true,
    },
  });
  if (!donation) return;
  const to = donation.donor?.email ?? donation.guestEmail;
  if (!to) return;
  const tpl = refundProcessed(formatMoney(donation.amount, donation.currency), donation.publicRef);
  await sendEmail({
    to,
    userId: donation.donorUserId ?? null,
    subject: tpl.subject,
    html: tpl.html,
    template: 'refund-processed',
  });
}

async function handleRecurringDue(job: Job): Promise<void> {
  const { donationId, donorUserId } = job.data as { donationId: string; donorUserId: string };
  const [donation, donor] = await Promise.all([
    prisma.donation.findUnique({
      where: { id: donationId },
      select: { amount: true, currency: true, campaign: { select: { slug: true, title: true } } },
    }),
    prisma.user.findUnique({ where: { id: donorUserId }, select: { id: true, email: true, firstName: true } }),
  ]);
  if (!donation || !donor?.email) return;
  const amountMajor = majorValue(donation.amount, donation.currency);
  const donateUrl = `${frontendUrl()}/donate/${donation.campaign.slug}?amount=${amountMajor}`;
  const tpl = recurringDueReminder(
    donor.firstName,
    donation.campaign.title,
    formatMoney(donation.amount, donation.currency),
    donateUrl,
  );
  await sendEmail({
    to: donor.email,
    userId: donor.id,
    subject: tpl.subject,
    html: tpl.html,
    template: 'recurring-due',
  });
}

/**
 * email.recurring-receipt — recurring charge success receipt. The subject is
 * mandated copy ("Your monthly KINDORA donation was processed") and is
 * donation-agnostic, so exactly-once delivery is enforced with a durable
 * IdempotencyKey per donation taken BEFORE sending (released again on send
 * failure so BullMQ retries can proceed; the tiny crash window in between is
 * the standard at-least-once email trade-off).
 */
async function handleRecurringReceipt(job: Job): Promise<void> {
  const { donationId } = job.data as { donationId: string; donorUserId?: string };
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      status: true,
      amount: true,
      tipAmount: true,
      currency: true,
      receiptNumber: true,
      publicRef: true,
      isAnonymous: true,
      donorUserId: true,
      donor: { select: { id: true, email: true, firstName: true } },
      guestEmail: true,
      guestName: true,
      campaign: { select: { slug: true, title: true } },
    },
  });
  if (!donation || donation.status !== 'SUCCEEDED') return;
  const to = donation.donor?.email ?? donation.guestEmail;
  if (!to) {
    logWarn(`[email] recurring-receipt for ${donationId}: no recipient email — skipping`);
    return;
  }
  const key = `email.recurring-receipt:${donationId}`;
  try {
    await prisma.idempotencyKey.create({
      data: {
        key,
        scope: 'email.recurring-receipt',
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      logInfo(`[email] recurring-receipt for ${donationId} already sent — skipping duplicate`);
      return;
    }
    throw err;
  }
  const donorName = donation.isAnonymous
    ? 'friend'
    : (donation.donor?.firstName ?? donation.guestName ?? 'friend');
  const amountFormatted = formatMoney(donation.amount + donation.tipAmount, donation.currency);
  const campaignUrl = `${frontendUrl()}/campaigns/${donation.campaign.slug}`;
  // Generic receipt template body with the mandated recurring-charge subject.
  const tpl = donationReceipt(
    donorName,
    donation.campaign.title,
    amountFormatted,
    donation.receiptNumber ?? donation.publicRef,
    campaignUrl,
  );
  try {
    await sendEmail({
      to,
      userId: donation.donorUserId ?? null,
      subject: 'Your monthly KINDORA donation was processed',
      html: tpl.html,
      template: 'recurring-receipt',
    });
  } catch (err) {
    await prisma.idempotencyKey.delete({ where: { key } }).catch(() => undefined);
    throw err;
  }
}

/** email.recurring-failed — donor notice with failure + retry/pause info. */
async function handleRecurringFailed(job: Job): Promise<void> {
  const { donationId, paused, attemptNumber } = job.data as {
    donationId: string;
    donorUserId?: string;
    paused?: boolean;
    attemptNumber?: number;
  };
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      status: true,
      publicRef: true,
      failureReason: true,
      amount: true,
      currency: true,
      donorUserId: true,
      donor: { select: { id: true, email: true, firstName: true } },
      campaign: { select: { slug: true, title: true } },
    },
  });
  if (!donation || donation.status !== 'FAILED' || !donation.donor?.email) return;
  const donateUrl = `${frontendUrl()}/donate/${donation.campaign.slug}`;
  const tpl = recurringChargeFailed(
    donation.donor.firstName,
    donation.campaign.title,
    formatMoney(donation.amount, donation.currency),
    donation.failureReason ?? 'Payment declined',
    attemptNumber ?? 1,
    RECURRING_PAUSE_AFTER_FAILURES,
    donateUrl,
    paused ?? false,
  );
  // Subject embeds the donation-unique reference → duplicate-safe guard.
  const alreadySent = await prisma.emailLog.findFirst({
    where: { template: 'recurring-failed', subject: tpl.subject, status: 'SENT' },
    select: { id: true },
  });
  if (alreadySent) return;
  await sendEmail({
    to: donation.donor.email,
    userId: donation.donorUserId ?? null,
    subject: tpl.subject,
    html: tpl.html,
    template: 'recurring-failed',
  });
}

/** email.recurring-failed-organizer — organizer notice for a failed cycle. */
async function handleRecurringFailedOrganizer(job: Job): Promise<void> {
  const { donationId } = job.data as { donationId: string };
  const donation = await prisma.donation.findUnique({
    where: { id: donationId },
    select: {
      status: true,
      publicRef: true,
      failureReason: true,
      amount: true,
      currency: true,
      isAnonymous: true,
      donor: { select: { firstName: true, lastName: true } },
      campaign: { select: { title: true, createdBy: { select: { id: true, email: true, firstName: true } } } },
    },
  });
  if (!donation || donation.status !== 'FAILED') return;
  const organizer = donation.campaign.createdBy;
  if (!organizer?.email) return;
  const donorDisplay = donation.isAnonymous
    ? 'Anonymous donor'
    : donation.donor
      ? `${donation.donor.firstName} ${donation.donor.lastName.charAt(0).toUpperCase()}.`
      : 'A recurring donor';
  const tpl = recurringChargeFailedOrganizer(
    organizer.firstName,
    donation.campaign.title,
    formatMoney(donation.amount, donation.currency),
    donorDisplay,
    donation.failureReason ?? 'Payment declined',
  );
  // Subject embeds the donation-unique reference → duplicate-safe guard.
  const alreadySent = await prisma.emailLog.findFirst({
    where: { template: 'recurring-failed-organizer', subject: tpl.subject, status: 'SENT' },
    select: { id: true },
  });
  if (alreadySent) return;
  await sendEmail({
    to: organizer.email,
    userId: organizer.id,
    subject: tpl.subject,
    html: tpl.html,
    template: 'recurring-failed-organizer',
  });
}

/** email.weekly-report — passthrough to the shared weekly report pipeline. */
async function handleWeeklyReportEmail(_job: Job): Promise<void> {
  const summary = await computeWeeklySummary();
  const sent = await sendWeeklyReportEmail(summary);
  logInfo(`[email] weekly-report sent to ${sent} admin(s)`);
}

export const EMAIL_HANDLERS: Record<string, JobHandler> = {
  'email.receipt': handleDonationReceipt,
  'email.donation-receipt': handleDonationReceipt,
  'email.donation-organizer': handleDonationOrganizer,
  'email.verify-email': handleVerifyEmail,
  'email.password-reset': handlePasswordReset,
  'email.campaign-approved': handleCampaignApproved,
  'email.campaign-update': handleCampaignUpdateEmail,
  'email.campaign-reminder': handleCampaignReminder,
  'email.refund-processed': handleRefundProcessed,
  'email.weekly-report': handleWeeklyReportEmail,
  'email.recurring-due': handleRecurringDue,
  'email.recurring-receipt': handleRecurringReceipt,
  'email.recurring-failed': handleRecurringFailed,
  'email.recurring-failed-organizer': handleRecurringFailedOrganizer,
};
