/**
 * Shared weekly-report aggregation + delivery.
 *
 * Used by three entry points that must behave identically:
 *   - reports processor   (queue job `report.generate {kind:'weekly'}`)
 *   - email processor     (queue job `email.weekly-report`)
 *   - weekly-reports cron (self-contained script, src/cron/weekly-reports.ts)
 */
import dayjs from './dayjs';
import { adminEmails } from './env';
import { formatMoney } from './format';
import { logWarn } from './logger';
import { sendEmail } from './mailer';
import { prisma } from './prisma';
import { weeklyReport, escapeHtml } from './templates';

export interface WeeklySummary {
  rows: { date: string; donationCount: number; donationAmount: bigint; currency: string }[];
  totalDonations: number;
  totalAmountMinor: bigint;
  currency: string;
  newUsers: number;
  newCampaigns: number;
}

/** Aggregates the last 7 UTC days from PlatformStatDaily (+ user/campaign counts). */
export async function computeWeeklySummary(): Promise<WeeklySummary> {
  const since = dayjs.utc().subtract(7, 'day').startOf('day').toDate();
  const [stats, newUsers, newCampaigns] = await Promise.all([
    prisma.platformStatDaily.findMany({ where: { date: { gte: since } }, orderBy: { date: 'asc' } }),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.campaign.count({ where: { createdAt: { gte: since } } }),
  ]);
  const totalDonations = stats.reduce((acc, s) => acc + s.donationCount, 0);
  const totalAmountMinor = stats.reduce<bigint>((acc, s) => acc + s.donationAmount, 0n);
  const currency = stats[0]?.currency ?? (process.env.DEFAULT_CURRENCY ?? 'NGN');
  return {
    rows: stats.map((s) => ({
      date: dayjs.utc(s.date).format('YYYY-MM-DD'),
      donationCount: s.donationCount,
      donationAmount: s.donationAmount,
      currency: s.currency,
    })),
    totalDonations,
    totalAmountMinor,
    currency,
    newUsers,
    newCampaigns,
  };
}

/** rowsHtmlSummary passed to weeklyReport() is our own HTML, not user content. */
export function weeklyRowsHtml(summary: WeeklySummary): string {
  if (summary.rows.length === 0) {
    return `<tr><td colspan="3" style="padding:10px 14px;color:#64748b;">No activity recorded yet.</td></tr>`;
  }
  return summary.rows
    .map(
      (row) =>
        `<tr style="border-top:1px solid #e2e8f0;">` +
        `<td style="padding:10px 14px;color:#0f172a;">${escapeHtml(row.date)}</td>` +
        `<td style="padding:10px 14px;text-align:right;color:#0f172a;">${row.donationCount}</td>` +
        `<td style="padding:10px 14px;text-align:right;color:#0f172a;">${escapeHtml(formatMoney(row.donationAmount, row.currency))}</td>` +
        `</tr>`,
    )
    .join('');
}

/**
 * Emails the weekly report to every address in ADMIN_EMAILS.
 * Returns the number of recipients; 0 means "skipped" (ADMIN_EMAILS empty —
 * log a warning, do not fail the job).
 */
export async function sendWeeklyReportEmail(summary: WeeklySummary): Promise<number> {
  const recipients = adminEmails();
  if (recipients.length === 0) {
    logWarn('[reports] ADMIN_EMAILS is empty — no weekly report recipients, skipping');
    return 0;
  }
  const totalsText =
    `${summary.totalDonations} donation${summary.totalDonations === 1 ? '' : 's'} · ` +
    `${formatMoney(summary.totalAmountMinor, summary.currency)} raised · ` +
    `${summary.newUsers} new user${summary.newUsers === 1 ? '' : 's'} · ` +
    `${summary.newCampaigns} new campaign${summary.newCampaigns === 1 ? '' : 's'}`;
  const tpl = weeklyReport(weeklyRowsHtml(summary), totalsText);
  for (const to of recipients) {
    await sendEmail({ to, subject: tpl.subject, html: tpl.html, template: 'weekly-report' });
  }
  return recipients.length;
}
