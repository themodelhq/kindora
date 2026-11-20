import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { logInfo, logWarn } from './logger';
import { prisma } from './prisma';

let transporter: Transporter | null = null;

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  /** Logical template name recorded in EmailLog (e.g. "donation-receipt"). */
  template: string;
  /** Optional recipient user id, kept on EmailLog for correlation. */
  userId?: string | null;
}

function buildTransporter(): Transporter | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 587) || 587;
  const secure = (process.env.SMTP_SECURE ?? '').toLowerCase() === 'true' || port === 465;
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
}

/** Transport is created lazily so a missing SMTP config never crashes boot. */
export function getTransporter(): Transporter | null {
  if (!transporter) transporter = buildTransporter();
  return transporter;
}

export function fromAddress(): string {
  const name = process.env.EMAIL_FROM_NAME?.trim() || 'KINDORA';
  const address = process.env.EMAIL_FROM_ADDRESS?.trim() || 'no-reply@kindora.com';
  return `"${name}" <${address}>`;
}

/**
 * Sends one email over SMTP — or logs the skip when SMTP is not configured —
 * and ALWAYS records the outcome in EmailLog.
 *
 * SMTP failures are rethrown so the calling BullMQ job retries with backoff;
 * every attempt appends its own EmailLog row (acceptable dedupe trade-off).
 */
export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const transport = getTransporter();
  if (!transport) {
    logWarn(`[mailer] SMTP_HOST not configured — skipping "${email.template}" to ${email.to}`);
    await prisma.emailLog.create({
      data: {
        to: email.to,
        template: email.template,
        subject: email.subject,
        status: 'SKIPPED_NO_SMTP',
        userId: email.userId ?? null,
      },
    });
    return;
  }

  try {
    const info = await transport.sendMail({
      from: fromAddress(),
      to: email.to,
      subject: email.subject,
      html: email.html,
    });
    await prisma.emailLog.create({
      data: {
        to: email.to,
        template: email.template,
        subject: email.subject,
        status: 'SENT',
        providerMessageId: info?.messageId ?? null,
        sentAt: new Date(),
        userId: email.userId ?? null,
      },
    });
    logInfo(`[mailer] sent "${email.template}" to ${email.to} (${info?.messageId ?? 'no-id'})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[mailer] send failed for "${email.template}" to ${email.to}: ${message}`);
    await prisma.emailLog.create({
      data: {
        to: email.to,
        template: email.template,
        subject: email.subject,
        status: 'FAILED',
        error: message.slice(0, 500),
        userId: email.userId ?? null,
      },
    });
    throw err;
  }
}
