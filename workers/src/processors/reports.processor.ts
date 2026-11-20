/**
 * REPORTS queue processor — `reports` queue.
 *
 *   report.generate {kind: 'weekly'} — aggregate the last 7 UTC days of
 *       PlatformStatDaily into an HTML table and mail ADMIN_EMAILS.
 *       Skips (does not fail) when ADMIN_EMAILS is unset.
 *   report.weekly — legacy alias for kind:'weekly' (kept so previously
 *       queued jobs and older producers still resolve).
 */
import type { Job } from 'bullmq';

import { logInfo, logWarn } from '../lib/logger';
import { computeWeeklySummary, sendWeeklyReportEmail } from '../lib/weekly-report';

import type { JobHandler } from './email.processor';

async function handleGenerateReport(job: Job): Promise<void> {
  const kind = ((job.data as { kind?: string }).kind ?? 'weekly').toLowerCase();
  if (kind !== 'weekly') {
    logWarn(`[reports] report.generate kind="${kind}" is not implemented — acknowledging and dropping`);
    return;
  }
  const summary = await computeWeeklySummary();
  const sent = await sendWeeklyReportEmail(summary);
  logInfo(`[reports] report.generate weekly done — emailed ${sent} admin(s)`);
}

export const REPORTS_HANDLERS: Record<string, JobHandler> = {
  'report.generate': handleGenerateReport,
  'report.weekly': handleGenerateReport,
};
