/**
 * Cron: recurring donation CHARGE executor (Render Cron Job → `npm run cron:recurring-donations`).
 *
 * Self-contained script (Prisma + Redis SET NX PX lock, released on exit).
 * A recurring donation must result in a REAL provider-side payment attempt —
 * creating a PENDING row and advancing the schedule without charging anyone
 * is forbidden. The pipeline per run:
 *
 *   1. VERIFY pass — resolves non-terminal charges from earlier runs: PENDING
 *      donations bound to a schedule with a persisted providerReference are
 *      verified via Paystack GET /transaction/verify/<reference> and applied
 *      (success → full success semantics; failed → failure path; still
 *      pending → left untouched for the next run).
 *   2. CHARGE pass — ACTIVE schedules due (nextChargeAt <= now) WITH a stored
 *      authorization, batch 100 oldest-first. Per schedule a durable lock is
 *      taken via IdempotencyKey
 *        `recurring-charge:<scheduleId>:<nextChargeAt.toISOString()>`
 *      (unique violation = this cycle was already attempted — skip).
 *      - PAYSTACK: REAL off-session charge via POST
 *        /transaction/charge_authorization with the stored authorization.
 *        succeeded → success path; failed → failure path; non-terminal →
 *        PENDING donation recorded, schedule NOT advanced, next run's verify
 *        pass resolves it (the cycle key stays, so no duplicate charge).
 *      - FLUTTERWAVE/STRIPE/PAYPAL: off-session charging is NOT supported for
 *        these providers in this codebase — the donor gets a "Recurring
 *        donation needs attention" notification (once per month) and the
 *        schedule is skipped WITHOUT advancing. Success is never faked.
 *   3. NO-AUTH pass — ACTIVE due schedules without providerAuthRef get a
 *      once-per-month donor notification (anti-spam marker in
 *      lastFailureReason) asking them to complete a donation on the site to
 *      save an authorization. No donation rows are created for these.
 *
 * Success path — ONE interactive prisma.$transaction, mirroring the backend
 * applySuccess semantics exactly:
 *   (a) Donation row SUCCEEDED (publicRef = provider reference, receipt
 *       RCP-<ref-suffix>, totalCharged = amount, providerAuthRef copied);
 *   (b) double-entry ledger posted with RAW prisma calls identical to backend
 *       semantics: DEBIT 1100:CLEARING:<cur> (ASSET) / CREDIT
 *       2000:CAMPAIGN:<campaignId>:<cur> (LIABILITY, campaignId). The
 *       LedgerTransaction reference `donation:<donationId>` is UNIQUE, which
 *       makes the posting exactly-once; accounts are find-first-or-create
 *       with P2002 tolerance;
 *   (c) schedule advance ONLY here: chargeCount+1, lastChargeAt, lastDonationId,
 *       nextChargeAt = now + frequency (dayjs add), failureCount reset to 0;
 *   (d) campaign raisedAmount + donorCount increments (denormalised, same tx);
 *   (e) raised >= targetAmount → status COMPLETED + completedAt.
 *   Post-commit: recurring receipt email + DONATION_RECEIPT notification to
 *   the donor (failures logged, never propagated — money already moved).
 *   If the transaction fails, the idempotency key is deleted ONLY when no
 *   donation row was persisted for the attempt (existing pattern of deleting
 *   on transaction failure) so the next run retries.
 *
 * Failure path (provider definitively declined): FAILED donation row with the
 * provider message + attempt reference. Failed charges never count as
 * donations — no ledger posting, no campaign counters, schedule NOT advanced
 * (nextChargeAt/chargeCount untouched). failureCount/lastFailureAt/
 * lastFailureReason are updated; donor AND organizer are notified via
 * Notification + email (failure + retry info). After 3 failed attempts the
 * schedule is PAUSED until the donor updates their payment method. The cycle
 * idempotency key is released so the next run can retry the same cycle —
 * that is how failureCount climbs to the pause threshold.
 *
 * Transient errors (fetch throw, HTTP 5xx, unparseable provider body,
 * rejected credentials): NOTHING is written (no donation row, no schedule
 * change), a CRITICAL line is logged, the idempotency key is released (no
 * donation row exists for it) and the next run retries. The run exits 1 when
 * any schedule was deferred so orchestration surfaces the failure.
 *
 * PROVIDER_MODE=mock: charges succeed deterministically WITHOUT network
 * (providerFeeMinor 0) so tests exercise the full success pipeline.
 *
 * Legacy note: PENDING donations created by the old pending-only cron have no
 * providerReference and are deliberately NOT touched here (the backend
 * verifyStatus flow + payments.reconcile digest own them).
 *
 * All money is BigInt minor units — floats never touch balances. Secrets are
 * never logged.
 */
import { LedgerTxnType, Prisma } from '@prisma/client';
import type { PaymentProvider } from '@prisma/client';

import dayjs from '../lib/dayjs';
import { frontendUrl, isProviderMock, paystackSecretKey } from '../lib/env';
import { formatMoney } from '../lib/format';
import { logError, logInfo, logWarn } from '../lib/logger';
import { disconnectPrisma, prisma } from '../lib/prisma';
import { acquireLock, closeRedis, releaseLock } from '../lib/redis';
import { enqueue, QUEUES } from '../lib/queues';

const NAME = 'recurring-donations';
const LOCK_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TAKE = 100;
const NO_AUTH_TAKE = 50;
const VERIFY_TAKE = 50;
const KEY_TTL_DAYS = 7;
const NOTICE_TTL_DAYS = 40;
const LOCK_SCOPE = 'recurring-donation-charge';
const FAILURE_PAUSE_THRESHOLD = 3;
const CHARGE_TIMEOUT_MS = 30 * 1000;
const PAYSTACK_API_BASE = 'https://api.paystack.co';

/** Aggregate include for a due schedule: donor + campaign + organizer. */
const SCHEDULE_INCLUDE = {
  donor: { select: { id: true, email: true, firstName: true } },
  campaign: {
    select: {
      id: true,
      title: true,
      slug: true,
      targetAmount: true,
      raisedAmount: true,
      createdById: true,
      createdBy: { select: { id: true, email: true, firstName: true } },
    },
  },
} satisfies Prisma.RecurringDonationInclude;

type DueSchedule = Prisma.RecurringDonationGetPayload<{ include: typeof SCHEDULE_INCLUDE }>;

/**
 * Provider outcome of one charge/verify call:
 *  - succeeded / failed / pending: a DEFINITIVE provider answer (money state
 *    may change accordingly);
 *  - deferred: no reliable answer (network, 5xx, unparseable body, rejected
 *    credentials) — nothing may be written, retry on the next run.
 */
type ProviderOutcome = {
  kind: 'succeeded' | 'failed' | 'pending';
  message: string | null;
  feesMinor: bigint | null;
};
type ProviderResult = { kind: 'deferred'; reason: string } | ProviderOutcome;

function nextChargeFrom(from: Date, frequency: string): Date {
  const months = frequency === 'YEARLY' ? 12 : frequency === 'QUARTERLY' ? 3 : 1;
  return dayjs.utc(from).add(months, 'month').toDate();
}

/** Durable per-cycle idempotency lock key (embeds the observed due date). */
function cycleLockKey(scheduleId: string, nextChargeAt: Date): string {
  return `recurring-charge:${scheduleId}:${nextChargeAt.toISOString()}`;
}

/** Provider-side attempt reference, `KDO-RCUR-<scheduleId-short>-<yyyymmddhhmmss>`. */
function chargeReference(scheduleId: string, at: Date): string {
  return `KDO-RCUR-${scheduleId.slice(0, 8)}-${dayjs.utc(at).format('YYYYMMDDHHmmss')}`;
}

/** Receipt number derived from the attempt reference, `RCP-<ref-suffix>`. */
function receiptFromReference(reference: string): string {
  const body = reference.startsWith('KDO-RCUR-')
    ? reference.slice('KDO-RCUR-'.length)
    : reference.slice(-12);
  return `RCP-${body.toUpperCase()}`;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function paystackConfigured(): boolean {
  return Boolean(paystackSecretKey());
}

function donorDisplay(donor: { firstName: string }): string {
  return donor.firstName?.trim() || 'A recurring donor';
}

// ---------------------------------------------------------------------------
// Paystack HTTP client (off-session charges + verification)
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function feesMinorOf(data: Record<string, unknown> | null): bigint | null {
  const fees = data?.fees;
  if (typeof fees === 'number' && Number.isFinite(fees) && fees >= 0) {
    return BigInt(Math.round(fees));
  }
  return null;
}

/**
 * Maps a Paystack HTTP answer onto a ProviderResult. Anything that is not a
 * reliable provider answer (5xx, rejected credentials, unparseable body) is
 * deferred — a charge must never be guessed from a broken response.
 */
async function parsePaystackResponse(res: Response, reference: string): Promise<ProviderResult> {
  if (res.status >= 500) {
    return { kind: 'deferred', reason: `Paystack HTTP ${res.status} for ${reference}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'deferred',
      reason: `Paystack rejected the API credentials (HTTP ${res.status}) — check PAYSTACK_SECRET_KEY`,
    };
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = asRecord(JSON.parse(await res.text())) ?? {};
  } catch {
    return { kind: 'deferred', reason: `unparseable Paystack response body for ${reference}` };
  }
  const message = asString(envelope.message);
  if (envelope.status !== true) {
    // Business-level refusal (e.g. dead authorization code) — a definitive
    // provider answer, distinct from transient infrastructure errors.
    return { kind: 'failed', message: message ?? 'Payment provider refused the charge', feesMinor: null };
  }
  const data = asRecord(envelope.data);
  const dataStatus = asString(data?.status);
  if (dataStatus === 'success') {
    return { kind: 'succeeded', message, feesMinor: feesMinorOf(data) };
  }
  if (dataStatus === 'failed') {
    return {
      kind: 'failed',
      message: asString(data?.gateway_response) ?? message ?? 'Payment failed',
      feesMinor: null,
    };
  }
  // 'ongoing' / 'abandoned' / anything non-terminal — leave pending; the next
  // run's verify pass resolves it via GET /transaction/verify/<reference>.
  return { kind: 'pending', message, feesMinor: null };
}

async function paystackChargeAuthorization(input: {
  authorizationCode: string;
  email: string;
  amountMinor: bigint;
  currency: string;
  reference: string;
}): Promise<ProviderResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${PAYSTACK_API_BASE}/transaction/charge_authorization`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecretKey() ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          authorization_code: input.authorizationCode,
          email: input.email,
          // Minor units as a JSON number (Paystack API contract); BigInt is
          // only converted at this API edge, never for internal balances.
          amount: Number(input.amountMinor),
          currency: input.currency,
          reference: input.reference,
        }),
      },
      CHARGE_TIMEOUT_MS,
    );
  } catch (err) {
    return { kind: 'deferred', reason: `charge_authorization network error: ${(err as Error).message}` };
  }
  return parsePaystackResponse(res, input.reference);
}

async function paystackVerifyTransaction(reference: string): Promise<ProviderResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${PAYSTACK_API_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${paystackSecretKey() ?? ''}` } },
      CHARGE_TIMEOUT_MS,
    );
  } catch (err) {
    return { kind: 'deferred', reason: `verify network error: ${(err as Error).message}` };
  }
  return parsePaystackResponse(res, reference);
}

// ---------------------------------------------------------------------------
// Ledger helpers — RAW prisma calls, identical to backend LedgerService
// ---------------------------------------------------------------------------

async function ensureLedgerAccount(
  tx: Prisma.TransactionClient,
  input: { code: string; name: string; type: 'ASSET' | 'LIABILITY'; currency: string; campaignId?: string },
) {
  const existing = await tx.ledgerAccount.findUnique({ where: { code: input.code } });
  if (existing) return existing;
  try {
    return await tx.ledgerAccount.create({
      data: {
        code: input.code,
        name: input.name,
        type: input.type,
        currency: input.currency,
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      },
    });
  } catch (err) {
    // Two concurrent first postings for the same account race the unique
    // constraint; the loser must reuse the winner's account instead of
    // rolling back a money movement at the charge moment.
    if (isUniqueViolation(err)) {
      const account = await tx.ledgerAccount.findUnique({ where: { code: input.code } });
      if (account) return account;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Money state transitions
// ---------------------------------------------------------------------------

/**
 * Applies a SUCCESSFUL charge in ONE interactive transaction:
 * donation row (create, or PENDING→SUCCEEDED for verified attempts) +
 * double-entry ledger + schedule advance + campaign counters + completion.
 * The unique LedgerTransaction reference `donation:<donationId>` makes the
 * posting exactly-once. Post-commit side effects are best-effort.
 */
async function recordChargeSuccess(
  schedule: DueSchedule,
  pendingDonationId: string | null,
  reference: string,
  feesMinor: bigint | null,
  dueIso: string,
): Promise<void> {
  const now = new Date();
  const provider: PaymentProvider = isProviderMock() ? schedule.provider : 'PAYSTACK';

  const applied = await prisma.$transaction(async (tx) => {
    // (a) Donation row — created fresh at charge time, or flipped
    // PENDING -> SUCCEEDED (conditional update) when resolving a pending
    // attempt from an earlier run so a racing webhook can never double-apply.
    let donationId: string;
    let donationAmount: bigint;
    if (pendingDonationId) {
      const pending = await tx.donation.findUnique({
        where: { id: pendingDonationId },
        select: { id: true, status: true, amount: true, tipAmount: true, currency: true },
      });
      if (!pending || pending.status !== 'PENDING') return null;
      const updated = await tx.donation.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: {
          status: 'SUCCEEDED',
          succeededAt: now,
          totalCharged: pending.amount + pending.tipAmount,
          chargeCurrency: pending.currency,
          receiptNumber: receiptFromReference(reference),
          ...(feesMinor != null ? { providerFeeMinor: feesMinor } : {}),
        },
      });
      if (updated.count === 0) return null;
      donationId = pending.id;
      donationAmount = pending.amount;
    } else {
      const created = await tx.donation.create({
        data: {
          publicRef: reference,
          campaignId: schedule.campaignId,
          donorUserId: schedule.donorUserId,
          amount: schedule.amount,
          currency: schedule.currency,
          tipAmount: 0n,
          status: 'SUCCEEDED',
          provider,
          providerReference: reference,
          providerAuthRef: schedule.providerAuthRef,
          totalCharged: schedule.amount,
          chargeCurrency: schedule.currency,
          receiptNumber: receiptFromReference(reference),
          succeededAt: now,
          recurringDonationId: schedule.id,
          ...(feesMinor != null ? { providerFeeMinor: feesMinor } : {}),
          metadata: {
            recurring: true,
            frequency: schedule.frequency,
            dueAt: dueIso,
            source: 'cron-recurring-charge',
          } as Prisma.InputJsonValue,
        },
        select: { id: true, amount: true },
      });
      donationId = created.id;
      donationAmount = created.amount;
    }

    // (b) Double-entry ledger. The LedgerTransaction reference is unique —
    // a P2002 there means another writer already resolved this donation.
    const clearing = await ensureLedgerAccount(tx, {
      code: `1100:CLEARING:${schedule.currency}`,
      name: `Provider clearing (${schedule.currency})`,
      type: 'ASSET',
      currency: schedule.currency,
    });
    const payable = await ensureLedgerAccount(tx, {
      code: `2000:CAMPAIGN:${schedule.campaignId}:${schedule.currency}`,
      name: 'Campaign payable',
      type: 'LIABILITY',
      currency: schedule.currency,
      campaignId: schedule.campaignId,
    });
    const ledgerTxn = await tx.ledgerTransaction
      .create({
        data: {
          reference: `donation:${donationId}`,
          type: LedgerTxnType.DONATION,
          description: `Donation ${reference} via ${provider}`,
          metadata: { donationId, publicRef: reference, tip: '0', recurring: true } as Prisma.InputJsonValue,
        },
      })
      .catch((err) => {
        if (isUniqueViolation(err)) return null;
        throw err;
      });
    if (!ledgerTxn) return null;
    if (donationAmount > 0n) {
      await tx.ledgerEntry.create({
        data: {
          transactionId: ledgerTxn.id,
          accountId: clearing.id,
          direction: 'DEBIT',
          amount: donationAmount,
          currency: schedule.currency,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          transactionId: ledgerTxn.id,
          accountId: payable.id,
          direction: 'CREDIT',
          amount: donationAmount,
          currency: schedule.currency,
        },
      });
    }

    // (c) Schedule advance — ONLY here, only while still ACTIVE.
    if (schedule.status === 'ACTIVE') {
      await tx.recurringDonation.update({
        where: { id: schedule.id },
        data: {
          chargeCount: { increment: 1 },
          lastChargeAt: now,
          lastDonationId: donationId,
          nextChargeAt: nextChargeFrom(now, schedule.frequency),
          failureCount: 0,
        },
      });
    }

    // (d) + (e) Denormalised campaign counters + completion, same tx.
    const campaign = await tx.campaign.findUnique({
      where: { id: schedule.campaignId },
      select: { raisedAmount: true, targetAmount: true },
    });
    if (campaign) {
      const data: Prisma.CampaignUpdateInput = {
        raisedAmount: { increment: donationAmount },
        donorCount: { increment: 1 },
        ...(campaign.raisedAmount + donationAmount >= campaign.targetAmount
          ? { status: 'COMPLETED', completedAt: now }
          : {}),
      };
      await tx.campaign.update({ where: { id: schedule.campaignId }, data });
    }

    return { donationId, donationAmount };
  });

  if (!applied) {
    logInfo(
      `[cron:${NAME}] schedule ${schedule.id}: donation for ${reference} already resolved elsewhere — treating as duplicate`,
    );
    return;
  }

  logInfo(
    `[cron:${NAME}] schedule ${schedule.id} cycle ${schedule.chargeCount + 1}: charge ${reference} SUCCEEDED ` +
      `(${formatMoney(applied.donationAmount, schedule.currency)}${isProviderMock() ? ', mock' : ''}); ` +
      `next charge ${nextChargeFrom(now, schedule.frequency).toISOString()}`,
  );

  // Post-commit side effects — failures logged, never propagated (the money
  // has already moved; the next run must not re-charge this cycle).
  try {
    if (schedule.donorUserId) {
      await enqueue(
        QUEUES.EMAIL,
        'email.recurring-receipt',
        { donationId: applied.donationId, donorUserId: schedule.donorUserId },
        { jobId: `recurring-receipt:${applied.donationId}` },
      );
      await prisma.notification.create({
        data: {
          userId: schedule.donorUserId,
          type: 'DONATION_RECEIPT',
          title: 'Thank you for giving',
          body: `Your recurring donation to "${schedule.campaign.title}" was processed. Receipt ${receiptFromReference(reference)}`,
          data: { donationId: applied.donationId, scheduleId: schedule.id, recurring: true } as Prisma.InputJsonValue,
        },
      });
    }
  } catch (err) {
    logWarn(`[cron:${NAME}] post-success side effects failed for ${reference}: ${(err as Error).message}`);
  }
}

/**
 * Records a FAILED charge attempt: FAILED donation row (audit only — failed
 * charges never count as donations), failure bookkeeping on the schedule and
 * donor + organizer notifications. nextChargeAt/chargeCount are intentionally
 * NOT touched; after FAILURE_PAUSE_THRESHOLD failures the schedule is PAUSED.
 */
async function recordChargeFailure(
  schedule: DueSchedule,
  pendingDonationId: string | null,
  reference: string,
  reason: string,
  dueIso: string,
  lockKey: string,
): Promise<void> {
  const now = new Date();
  const trimmed = reason.slice(0, 500);
  const provider: PaymentProvider = isProviderMock() ? schedule.provider : 'PAYSTACK';

  const outcome = await prisma.$transaction(async (tx) => {
    let donationId: string;
    if (pendingDonationId) {
      const updated = await tx.donation.updateMany({
        where: { id: pendingDonationId, status: 'PENDING' },
        data: { status: 'FAILED', failureReason: trimmed },
      });
      if (updated.count === 0) return null;
      donationId = pendingDonationId;
    } else {
      const created = await tx.donation.create({
        data: {
          publicRef: reference,
          campaignId: schedule.campaignId,
          donorUserId: schedule.donorUserId,
          amount: schedule.amount,
          currency: schedule.currency,
          tipAmount: 0n,
          status: 'FAILED',
          provider,
          providerReference: reference,
          failureReason: trimmed,
          recurringDonationId: schedule.id,
          metadata: {
            recurring: true,
            frequency: schedule.frequency,
            dueAt: dueIso,
            source: 'cron-recurring-charge',
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      donationId = created.id;
    }

    const current = await tx.recurringDonation.findUnique({
      where: { id: schedule.id },
      select: { failureCount: true },
    });
    const failureCount = (current?.failureCount ?? schedule.failureCount) + 1;
    const paused = failureCount >= FAILURE_PAUSE_THRESHOLD;
    const data: Prisma.RecurringDonationUpdateInput = {
      failureCount,
      lastFailureAt: now,
      lastFailureReason: trimmed,
      ...(paused ? { status: 'PAUSED' } : {}),
    };
    await tx.recurringDonation.update({ where: { id: schedule.id }, data });
    return { donationId, failureCount, paused };
  });

  if (!outcome) {
    logInfo(
      `[cron:${NAME}] schedule ${schedule.id}: donation for ${reference} already resolved elsewhere — treating as duplicate`,
    );
    return;
  }

  // The attempt is complete (FAILED audit row exists). Release the cycle lock
  // so the next run can retry the SAME cycle — that is how failureCount
  // climbs to the pause threshold.
  await prisma.idempotencyKey.delete({ where: { key: lockKey } }).catch(() => undefined);

  logWarn(
    `[cron:${NAME}] schedule ${schedule.id} cycle ${schedule.chargeCount + 1}: charge ${reference} FAILED ` +
      `(${trimmed}) — attempt ${outcome.failureCount}` +
      (outcome.paused ? ' → schedule PAUSED until the payment method is updated' : ' (will retry next run)'),
  );

  // Notify donor + organizer (Notification + email). Failures logged, never
  // propagated — the money state is already settled.
  try {
    const donateUrl = `${frontendUrl()}/donate/${schedule.campaign.slug}`;
    const amountFormatted = formatMoney(schedule.amount, schedule.currency);
    if (schedule.donorUserId) {
      await prisma.notification.create({
        data: {
          userId: schedule.donorUserId,
          type: 'RECURRING_PAYMENT_FAILED',
          title: outcome.paused ? 'Recurring giving paused' : 'Recurring donation failed',
          body: outcome.paused
            ? `Your recurring donation of ${amountFormatted} to "${schedule.campaign.title}" failed ${outcome.failureCount} times (${trimmed}). Recurring giving is paused until you update your payment method.`
            : `Your recurring donation of ${amountFormatted} to "${schedule.campaign.title}" could not be processed (${trimmed}). We will retry automatically on the next charge date.`,
          data: {
            donationId: outcome.donationId,
            scheduleId: schedule.id,
            reason: trimmed,
            url: donateUrl,
          } as Prisma.InputJsonValue,
        },
      });
      await enqueue(QUEUES.EMAIL, 'email.recurring-failed', {
        donationId: outcome.donationId,
        donorUserId: schedule.donorUserId,
        paused: outcome.paused,
        attemptNumber: outcome.failureCount,
      });
    }
    if (schedule.campaign.createdBy?.email) {
      await prisma.notification.create({
        data: {
          userId: schedule.campaign.createdById,
          type: 'RECURRING_PAYMENT_FAILED',
          title: 'Recurring donation failed',
          body:
            `A recurring donation of ${amountFormatted} from ${donorDisplay(schedule.donor)} to ` +
            `"${schedule.campaign.title}" failed (${trimmed}). No funds were collected; the donor has been notified.`,
          data: {
            donationId: outcome.donationId,
            campaignId: schedule.campaignId,
            reason: trimmed,
          } as Prisma.InputJsonValue,
        },
      });
      await enqueue(QUEUES.EMAIL, 'email.recurring-failed-organizer', { donationId: outcome.donationId });
    }
  } catch (err) {
    logWarn(`[cron:${NAME}] failure notifications failed for ${reference}: ${(err as Error).message}`);
  }
}

/**
 * Records a NON-TERMINAL charge (provider said pending/ongoing): a PENDING
 * donation row with the attempt reference is persisted so the next run's
 * verify pass can resolve it. The schedule is NOT advanced and the cycle
 * idempotency key is kept — no duplicate charge can fire for this cycle.
 */
async function recordPendingCharge(schedule: DueSchedule, reference: string, dueIso: string): Promise<void> {
  await prisma.donation.create({
    data: {
      publicRef: reference,
      campaignId: schedule.campaignId,
      donorUserId: schedule.donorUserId,
      amount: schedule.amount,
      currency: schedule.currency,
      tipAmount: 0n,
      status: 'PENDING',
      provider: 'PAYSTACK',
      providerReference: reference,
      recurringDonationId: schedule.id,
      metadata: {
        recurring: true,
        frequency: schedule.frequency,
        dueAt: dueIso,
        source: 'cron-recurring-charge',
        pendingVerification: true,
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  logInfo(
    `[cron:${NAME}] schedule ${schedule.id}: charge ${reference} not terminal yet — donation left PENDING, ` +
      `schedule NOT advanced; the next run verifies via GET /transaction/verify`,
  );
}

/**
 * Releases a cycle lock after an unexpected failure — ONLY when no donation
 * row was persisted for the attempt reference (a persisted row means the
 * cycle has a record and must not be re-charged blindly).
 */
async function releaseCycleLock(lockKey: string, reference: string | null): Promise<void> {
  if (reference) {
    const existing = await prisma.donation.findFirst({
      where: { providerReference: reference },
      select: { id: true },
    });
    if (existing) return;
  }
  await prisma.idempotencyKey.delete({ where: { key: lockKey } }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Pipeline passes
// ---------------------------------------------------------------------------

/** Pass 1 — resolve non-terminal charges from earlier runs via verification. */
async function verifyPendingCharges(
  handledThisRun: Set<string>,
): Promise<{ resolvedSuccess: number; resolvedFailed: number; stillPending: number; deferred: number }> {
  const counters = { resolvedSuccess: 0, resolvedFailed: 0, stillPending: 0, deferred: 0 };
  if (isProviderMock()) {
    // Mock charges always succeed synchronously — there is nothing to verify.
    return counters;
  }
  if (!paystackConfigured()) {
    logWarn(`[cron:${NAME}] verify pass skipped — PROVIDER_MODE=live without PAYSTACK_SECRET_KEY`);
    return counters;
  }

  const pendingRows = await prisma.donation.findMany({
    where: {
      status: 'PENDING',
      provider: 'PAYSTACK',
      providerReference: { not: null },
      recurringDonationId: { not: null },
    },
    select: { id: true, publicRef: true, providerReference: true, recurringDonationId: true },
    take: VERIFY_TAKE,
    orderBy: { createdAt: 'asc' },
  });
  if (pendingRows.length === 0) return counters;

  const scheduleIds = [
    ...new Set(pendingRows.map((row) => row.recurringDonationId).filter((id): id is string => Boolean(id))),
  ];
  const schedules = await prisma.recurringDonation.findMany({
    where: { id: { in: scheduleIds } },
    include: SCHEDULE_INCLUDE,
  });
  const scheduleById = new Map(schedules.map((schedule) => [schedule.id, schedule]));

  for (const row of pendingRows) {
    const schedule = row.recurringDonationId ? scheduleById.get(row.recurringDonationId) : undefined;
    const reference = row.providerReference;
    // Legacy pending rows without a persisted attempt reference cannot be
    // verified — the backend verifyStatus flow owns them.
    if (!schedule || !reference) continue;

    const result = await paystackVerifyTransaction(reference);
    if (result.kind === 'deferred') {
      counters.deferred += 1;
      logError(
        `CRITICAL: [cron:${NAME}] verify deferred for donation ${row.publicRef} (${reference}): ${result.reason} — stays PENDING`,
      );
      continue;
    }
    if (result.kind === 'pending') {
      counters.stillPending += 1;
      logInfo(
        `[cron:${NAME}] donation ${row.publicRef} (${reference}) is still non-terminal at the provider — leaving PENDING`,
      );
      continue;
    }

    // This schedule's cycle resolves this run — do not charge it again in the
    // same pass (failed resolutions wait for the next run to retry).
    handledThisRun.add(schedule.id);
    if (result.kind === 'succeeded') {
      await recordChargeSuccess(schedule, row.id, reference, result.feesMinor, schedule.nextChargeAt.toISOString());
      counters.resolvedSuccess += 1;
    } else {
      await recordChargeFailure(
        schedule,
        row.id,
        reference,
        result.message ?? 'Payment failed',
        schedule.nextChargeAt.toISOString(),
        cycleLockKey(schedule.id, schedule.nextChargeAt),
      );
      counters.resolvedFailed += 1;
    }
  }
  return counters;
}

/** Pass 2 — REAL charges for due schedules with a stored authorization. */
async function chargeDueSchedules(now: Date, handledThisRun: Set<string>) {
  const due = await prisma.recurringDonation.findMany({
    where: { status: 'ACTIVE', nextChargeAt: { lte: now }, providerAuthRef: { not: null } },
    take: TAKE,
    orderBy: { nextChargeAt: 'asc' },
    include: SCHEDULE_INCLUDE,
  });

  const counters = {
    succeeded: 0,
    failed: 0,
    pendingRecorded: 0,
    unsupported: 0,
    unsupportedNotified: 0,
    skippedLocked: 0,
    deferred: 0,
  };

  for (const schedule of due) {
    if (handledThisRun.has(schedule.id)) continue;
    if (!schedule.providerAuthRef) continue; // query filters on presence — defensive only

    if (schedule.provider !== 'PAYSTACK') {
      // FLUTTERWAVE / STRIPE / PAYPAL with a stored authorization: off-session
      // charging is NOT supported for these providers in this codebase. Never
      // fake success — warn, notify the donor (once per month), and skip
      // WITHOUT advancing the schedule (it stays due). Handled BEFORE the
      // cycle lock so the warning + notice re-fire on every run.
      counters.unsupported += 1;
      logWarn(
        `[cron:${NAME}] schedule ${schedule.id} (provider=${schedule.provider}) has a stored authorization but ` +
          `automatic ${schedule.provider} charges are not supported yet — needs authorization migration; ` +
          `skipping without advancing`,
      );
      const noticeKey = `recurring-unsupported-notice:${schedule.id}:${dayjs.utc(now).format('YYYY-MM')}`;
      const claimed = await prisma.idempotencyKey
        .create({
          data: { key: noticeKey, scope: LOCK_SCOPE, expiresAt: new Date(Date.now() + NOTICE_TTL_DAYS * DAY_MS) },
        })
        .then(() => true)
        .catch((err) => {
          if (isUniqueViolation(err)) return false;
          throw err;
        });
      if (claimed) {
        await prisma.notification.create({
          data: {
            userId: schedule.donorUserId,
            type: 'RECURRING_NEEDS_ATTENTION',
            title: 'Recurring donation needs attention',
            body:
              `Automatic charges with your saved ${schedule.provider} authorization are not supported yet. ` +
              `Please update your payment method so your recurring donation to "${schedule.campaign.title}" can continue.`,
            data: {
              scheduleId: schedule.id,
              provider: schedule.provider,
              url: `${frontendUrl()}/donate/${schedule.campaign.slug}`,
            } as Prisma.InputJsonValue,
          },
        });
        counters.unsupportedNotified += 1;
      }
      continue;
    }

    const dueIso = schedule.nextChargeAt.toISOString();
    const lockKey = cycleLockKey(schedule.id, schedule.nextChargeAt);

    // Durable per-record lock: key embeds the observed nextChargeAt, so the
    // next cycle (after the schedule advances) gets a fresh key.
    try {
      await prisma.idempotencyKey.create({
        data: {
          key: lockKey,
          scope: LOCK_SCOPE,
          expiresAt: new Date(Date.now() + KEY_TTL_DAYS * DAY_MS),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        counters.skippedLocked += 1;
        continue;
      }
      throw err;
    }

    const reference = chargeReference(schedule.id, now);

    try {
      if (isProviderMock()) {
        // PROVIDER_MODE=mock — deterministic success without network so tests
        // exercise the full success pipeline (providerFeeMinor 0).
        await recordChargeSuccess(schedule, null, reference, 0n, dueIso);
        counters.succeeded += 1;
        continue;
      }

      if (!paystackConfigured()) {
        counters.deferred += 1;
        logError(
          `CRITICAL: [cron:${NAME}] schedule ${schedule.id} is due but PAYSTACK_SECRET_KEY is not set ` +
            `(PROVIDER_MODE=live) — charge deferred to the next run`,
        );
        await releaseCycleLock(lockKey, null);
        continue;
      }

      const result = await paystackChargeAuthorization({
        authorizationCode: schedule.providerAuthRef,
        email: schedule.donor.email,
        amountMinor: schedule.amount,
        currency: schedule.currency,
        reference,
      });

      if (result.kind === 'deferred') {
        counters.deferred += 1;
        logError(
          `CRITICAL: [cron:${NAME}] charge deferred for schedule ${schedule.id} (${reference}): ${result.reason} — ` +
            `no rows written, will retry next run`,
        );
        await releaseCycleLock(lockKey, null);
        continue;
      }
      if (result.kind === 'succeeded') {
        await recordChargeSuccess(schedule, null, reference, result.feesMinor, dueIso);
        counters.succeeded += 1;
        continue;
      }
      if (result.kind === 'pending') {
        await recordPendingCharge(schedule, reference, dueIso);
        counters.pendingRecorded += 1;
        continue;
      }
      await recordChargeFailure(
        schedule,
        null,
        reference,
        result.message ?? 'Payment failed',
        dueIso,
        lockKey,
      );
      counters.failed += 1;
    } catch (err) {
      // Persistence failure around a provider call — release the cycle lock
      // ONLY if no donation row was persisted for this attempt (existing
      // pattern of deleting on transaction failure) so the next run retries
      // instead of waiting for key expiry.
      counters.deferred += 1;
      logError(
        `CRITICAL: [cron:${NAME}] charge pipeline error for schedule ${schedule.id} (${reference})`,
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
      await releaseCycleLock(lockKey, reference).catch(() => undefined);
    }
  }
  return counters;
}

/** Pass 3 — due schedules WITHOUT a stored authorization (no failed rows). */
async function notifyMissingAuthorizations(now: Date): Promise<{ notified: number; alreadyNotified: number }> {
  const due = await prisma.recurringDonation.findMany({
    where: { status: 'ACTIVE', nextChargeAt: { lte: now }, providerAuthRef: null },
    select: {
      id: true,
      donorUserId: true,
      lastFailureReason: true,
      campaign: { select: { title: true, slug: true } },
    },
    take: NO_AUTH_TAKE,
    orderBy: { nextChargeAt: 'asc' },
  });

  let notified = 0;
  let alreadyNotified = 0;
  // lastFailureReason doubles as the anti-spam marker: one notice per month
  // per schedule instead of one per cron run.
  const marker = `no-auth-notice:${dayjs.utc(now).format('YYYY-MM')}`;

  for (const schedule of due) {
    if (schedule.lastFailureReason === marker) {
      alreadyNotified += 1;
      continue;
    }
    const url = `${frontendUrl()}/donate/${schedule.campaign.slug}`;
    await prisma.notification.create({
      data: {
        userId: schedule.donorUserId,
        type: 'RECURRING_NEEDS_ATTENTION',
        title: 'Recurring donation needs attention',
        body:
          `Your recurring donation to "${schedule.campaign.title}" has no saved payment authorization, ` +
          `so it cannot be charged automatically. Complete a donation on the site to save your payment method ` +
          `and resume automatic charges.`,
        data: { scheduleId: schedule.id, url } as Prisma.InputJsonValue,
      },
    });
    await prisma.recurringDonation.update({
      where: { id: schedule.id },
      data: { lastFailureReason: marker },
    });
    notified += 1;
  }
  return { notified, alreadyNotified };
}

async function work(): Promise<string> {
  const now = new Date();
  const handledThisRun = new Set<string>();

  const verify = await verifyPendingCharges(handledThisRun);
  const charge = await chargeDueSchedules(now, handledThisRun);
  const noAuth = await notifyMissingAuthorizations(now);

  const summary =
    `verified: ${verify.resolvedSuccess} succeeded, ${verify.resolvedFailed} failed, ` +
    `${verify.stillPending} still pending, ${verify.deferred} deferred; ` +
    `charged: ${charge.succeeded} succeeded, ${charge.failed} failed, ${charge.pendingRecorded} pending, ` +
    `${charge.deferred} deferred; unsupported provider: ${charge.unsupported} skipped ` +
    `(${charge.unsupportedNotified} notified); no auth: ${noAuth.notified} notified, ` +
    `${noAuth.alreadyNotified} already; ${charge.skippedLocked} cycle lock(s) held`;

  if (verify.deferred + charge.deferred > 0) {
    throw new Error(
      `recurring-donations deferred ${verify.deferred + charge.deferred} action(s) after transient ` +
        `provider errors (will retry next run) — ${summary}`,
    );
  }
  return summary;
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
