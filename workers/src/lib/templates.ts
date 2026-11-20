/**
 * KINDORA transactional email templates.
 *
 * Every interpolated string that can originate from user input MUST go
 * through escapeHtml(). The single exception is weeklyReport()'s
 * rowsHtmlSummary argument, which is pre-built HTML produced by our own
 * aggregation code (never user content).
 */

export interface EmailTemplate {
  subject: string;
  html: string;
}

const BRAND = 'KINDORA';
const EMERALD = '#059669';
const EMERALD_DARK = '#047857';
const INK = '#0f172a';
const BODY_TEXT = '#334155';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const PAGE_BG = '#f4f7f6';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraph(text: string, opts?: { extra?: string }): string {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:${BODY_TEXT};${opts?.extra ?? ''}">${escapeHtml(text)}</p>`;
}

function button(url: string, label: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="background:${EMERALD};border-radius:8px;">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

function keyValueCard(rows: { label: string; value: string }[]): string {
  const cells = rows
    .map(
      (row) =>
        `<tr>` +
        `<td style="padding:8px 14px;font-size:13px;color:${MUTED};white-space:nowrap;">${escapeHtml(row.label)}</td>` +
        `<td style="padding:8px 14px;font-size:13px;font-weight:600;color:${INK};text-align:right;">${escapeHtml(row.value)}</td>` +
        `</tr>`,
    )
    .join('');
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ` +
    `style="margin:0 0 20px;background:#f8fafc;border:1px solid ${BORDER};border-radius:8px;font-family:Arial,Helvetica,sans-serif;">` +
    cells +
    `</table>`
  );
}

/**
 * Shared responsive shell: emerald header bar with the KINDORA wordmark,
 * a titled body block, and the standard footer note.
 */
export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background:${EMERALD};padding:18px 32px;">
              <span style="font-size:20px;font-weight:700;letter-spacing:3px;color:#ffffff;">${BRAND}</span>
              <span style="display:block;font-size:11px;color:rgba(255,255,255,0.85);margin-top:2px;">Generosity, made transparent.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 32px 34px;">
              <h1 style="margin:0 0 18px;font-size:19px;line-height:1.4;color:${INK};">${escapeHtml(title)}</h1>
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background:#f8fafc;border-top:1px solid ${BORDER};">
              <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">
                You receive this because of activity on ${BRAND}. Support:
                <a href="mailto:hello@kindora.com" style="color:${EMERALD_DARK};text-decoration:underline;">hello@kindora.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function verifyEmail(name: string, link: string): EmailTemplate {
  return {
    subject: 'Verify your KINDORA email address',
    html: layout(
      'Confirm your email',
      paragraph(`Hi ${name || 'there'}, welcome to KINDORA! Please confirm your email address to activate your account.`) +
        button(link, 'Verify email address') +
        paragraph('This link expires shortly. If you did not create a KINDORA account, you can safely ignore this email.'),
    ),
  };
}

export function passwordReset(name: string, link: string): EmailTemplate {
  return {
    subject: 'Reset your KINDORA password',
    html: layout(
      'Password reset requested',
      paragraph(`Hi ${name || 'there'}, we received a request to reset the password for your KINDORA account.`) +
        button(link, 'Choose a new password') +
        paragraph('If you did not request this, ignore this email — your password stays unchanged and no one else can use this link without access to your inbox.'),
    ),
  };
}

export function donationReceipt(
  donorName: string,
  campaignTitle: string,
  amountFormatted: string,
  receiptNumber: string,
  campaignUrl: string,
): EmailTemplate {
  return {
    subject: `Your KINDORA donation receipt — ${receiptNumber}`,
    html: layout(
      'Thank you for your donation',
      paragraph(`Hi ${donorName || 'friend'}, your donation has been received. This email is your official receipt.`) +
        keyValueCard([
          { label: 'Amount', value: amountFormatted },
          { label: 'Campaign', value: campaignTitle },
          { label: 'Receipt', value: receiptNumber },
        ]) +
        button(campaignUrl, 'View campaign') +
        paragraph('Every donation on KINDORA is tracked to the campaigns it funds. Thank you for giving.'),
    ),
  };
}

export function donationOrganizer(
  organizerName: string,
  campaignTitle: string,
  donorDisplay: string,
  amountFormatted: string,
  publicRef: string,
): EmailTemplate {
  return {
    subject: `New donation on "${campaignTitle}"`,
    html: layout(
      'A new donation arrived',
      paragraph(`Hi ${organizerName || 'organizer'}, good news — your campaign just received a new donation.`) +
        keyValueCard([
          { label: 'Campaign', value: campaignTitle },
          { label: 'From', value: donorDisplay },
          { label: 'Amount', value: amountFormatted },
          { label: 'Reference', value: publicRef },
        ]) +
        paragraph('Funds remain transparent on the campaign page and are withdrawable once the minimum threshold is met.'),
    ),
  };
}

export function campaignApproved(organizerName: string, campaignTitle: string, campaignUrl: string): EmailTemplate {
  return {
    subject: `Your campaign "${campaignTitle}" is now live`,
    html: layout(
      'Your campaign is live',
      paragraph(`Hi ${organizerName || 'organizer'}, your campaign "${campaignTitle}" passed review and is now accepting donations.`) +
        button(campaignUrl, 'View your campaign') +
        paragraph('Share the link with your community to build momentum early — campaigns that get a donation in the first 48 hours raise significantly more.'),
    ),
  };
}

export function campaignUpdateNotice(
  donorName: string,
  campaignTitle: string,
  updateTitle: string,
  campaignUrl: string,
): EmailTemplate {
  return {
    subject: `New update on "${campaignTitle}"`,
    html: layout(
      'An update was posted',
      paragraph(`Hi ${donorName || 'friend'}, the organizer of "${campaignTitle}" — a campaign you supported — posted a new update.`) +
        keyValueCard([{ label: 'Update', value: updateTitle }]) +
        button(campaignUrl, 'Read the update') +
        paragraph('You receive campaign updates because of your donations. Manage notification preferences from your KINDORA dashboard.'),
    ),
  };
}

export function campaignEndingSoon(campaignTitle: string, daysLeft: number, campaignUrl: string): EmailTemplate {
  const days = Math.max(0, Math.floor(daysLeft));
  const when = days === 0 ? 'ends today' : `ends in ${days} day${days === 1 ? '' : 's'}`;
  return {
    subject: `"${campaignTitle}" ${when}`,
    html: layout(
      'Your campaign deadline is approaching',
      paragraph(`Hi organizer, your campaign "${campaignTitle}" ${when}.`) +
        paragraph('A final push — share an update or post the link once more — can make a real difference in the last days of a campaign.') +
        button(campaignUrl, 'Open campaign') +
        paragraph('You can adjust the deadline from the organizer dashboard if you need more time.'),
    ),
  };
}

export function refundProcessed(amountFormatted: string, publicRef: string): EmailTemplate {
  return {
    subject: `Refund processed for donation ${publicRef}`,
    html: layout(
      'Your refund has been processed',
      paragraph(`The refund for donation ${publicRef} has been processed.`) +
        keyValueCard([
          { label: 'Refunded amount', value: amountFormatted },
          { label: 'Reference', value: publicRef },
        ]) +
        paragraph('Depending on your bank or payment provider, the funds typically appear within 5–10 business days. Reply to this email if you do not see them.'),
    ),
  };
}

export function recurringDueReminder(
  donorName: string,
  campaignTitle: string,
  amountFormatted: string,
  donateUrl: string,
): EmailTemplate {
  return {
    subject: `Your recurring donation to "${campaignTitle}" is due`,
    html: layout(
      'Recurring donation due',
      paragraph(`Hi ${donorName || 'there'}, your recurring donation to "${campaignTitle}" (${amountFormatted}) is due.`) +
        button(donateUrl, 'Renew this donation') +
        paragraph('Note: at the moment KINDORA does not automatically charge your payment method — automatic charging requires provider authorization that has not been captured for this subscription. Use the button above to complete this cycle; you can cancel the schedule any time from your dashboard.'),
    ),
  };
}

/**
 * Recurring charge failure notice to the DONOR. attemptNumber/maxAttempts
 * drive the retry messaging; paused swaps the copy for the "schedule paused
 * after repeated failures" state.
 */
export function recurringChargeFailed(
  donorName: string,
  campaignTitle: string,
  amountFormatted: string,
  reason: string,
  attemptNumber: number,
  maxAttempts: number,
  donateUrl: string,
  paused: boolean,
): EmailTemplate {
  const retryParagraph = paused
    ? paragraph(`After ${attemptNumber} failed attempts this recurring donation has been paused. Recurring giving stays paused until you update your payment method — complete a new donation on KINDORA to save a working authorization, then resume the schedule from your dashboard.`)
    : paragraph(`We will retry this charge automatically on the next scheduled run (attempt ${attemptNumber} so far). After ${maxAttempts} failed attempts the schedule is paused automatically, so nothing is charged without your knowledge.`);
  return {
    subject: paused
      ? 'Your recurring KINDORA donation was paused'
      : 'Your recurring KINDORA donation failed',
    html: layout(
      paused ? 'Recurring donation paused' : 'Recurring donation payment failed',
      paragraph(`Hi ${donorName || 'there'}, your recurring donation of ${amountFormatted} to "${campaignTitle}" could not be processed.`) +
        keyValueCard([
          { label: 'Amount', value: amountFormatted },
          { label: 'Campaign', value: campaignTitle },
          { label: 'Reason', value: reason },
        ]) +
        retryParagraph +
        button(donateUrl, 'Update payment method') +
        paragraph('No money was collected for this failed attempt. Failed attempts never count towards the campaign total.'),
    ),
  };
}

/** Recurring charge failure notice to the campaign ORGANIZER. */
export function recurringChargeFailedOrganizer(
  organizerName: string,
  campaignTitle: string,
  amountFormatted: string,
  donorDisplay: string,
  reason: string,
): EmailTemplate {
  return {
    subject: `A recurring donation to "${campaignTitle}" failed`,
    html: layout(
      'A recurring donation failed',
      paragraph(`Hi ${organizerName || 'organizer'}, a recurring donation of ${amountFormatted} from ${donorDisplay} to "${campaignTitle}" could not be processed.`) +
        keyValueCard([
          { label: 'Amount', value: amountFormatted },
          { label: 'From', value: donorDisplay },
          { label: 'Reason', value: reason },
        ]) +
        paragraph('No funds were collected — failed charges never count towards the campaign total. The donor has been notified and will be retried automatically; after repeated failures the schedule pauses until they update their payment method.'),
    ),
  };
}

/**
 * Weekly ops report for admins. rowsHtmlSummary is PRE-BUILT HTML (our own
 * aggregation output, see src/index.ts weeklyRowsHtml) — deliberately not
 * escaped here. totalsText is plain text and is escaped.
 */
export function weeklyReport(rowsHtmlSummary: string, totalsText: string): EmailTemplate {
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;border:1px solid ${BORDER};border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
  <tr style="background:${EMERALD};color:#ffffff;">
    <th align="left" style="padding:10px 14px;font-weight:600;">Day (UTC)</th>
    <th align="right" style="padding:10px 14px;font-weight:600;">Donations</th>
    <th align="right" style="padding:10px 14px;font-weight:600;">Amount</th>
  </tr>
  ${rowsHtmlSummary}
</table>`;
  return {
    subject: 'KINDORA weekly report',
    html: layout(
      'Last 7 days on KINDORA',
      paragraph('Here is the platform activity for the last 7 days (UTC):') +
        table +
        paragraph(totalsText, { extra: 'font-weight:600;' }) +
        paragraph('Report generated automatically by the KINDORA workers service.'),
    ),
  };
}
