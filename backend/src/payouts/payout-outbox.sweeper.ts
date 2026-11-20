import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PayoutInitiationService } from './payout-initiation.service';
import { PayoutSecurityMetricsService } from './payout-metrics.service';

/**
 * v1.0.7 §4.4 — in-process outbox sweeper.
 *
 * The outbox intent is durable in PostgreSQL: even with Redis down and no
 * worker service running, committed initiation intents can never silently
 * disappear. This sweeper runs INSIDE the API process on a fixed interval
 * and drives:
 *  - due outbox submissions (claimed conditionally — safe with N instances);
 *  - verification passes for accepted transfers;
 *  - escalation of stale unknown/submission-pending attempts.
 *
 * The BullMQ `payouts` queue + worker service accelerate the same work; this
 * sweeper is the crash-recovery floor. Concurrency safety comes from the
 * durable conditional claim in PayoutInitiationService.submitOutbox, NOT from
 * the timer — two sweeper instances can never duplicate a submission.
 */
@Injectable()
export class PayoutOutboxSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayoutOutboxSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private paused = false;

  constructor(
    private readonly initiation: PayoutInitiationService,
    private readonly metrics: PayoutSecurityMetricsService,
  ) {}

  onModuleInit(): void {
    const seconds = Number(process.env.PAYOUT_OUTBOX_SWEEP_SECONDS ?? 30);
    if (!Number.isFinite(seconds) || seconds < 5 || this.paused) return; // disabled explicitly in tests / while paused
    this.timer = setInterval(() => {
      void this.sweep();
    }, seconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Payout outbox sweeper online (every ${seconds}s)`);
  }

  private async sweep(): Promise<void> {
    if (this.running) return; // never overlap
    this.running = true;
    try {
      const result = await this.initiation.recoverySweep();
      if (result.claimed || result.escalated) {
        this.logger.log(`Outbox sweep: submitted=${result.claimed} escalated=${result.escalated} verificationQueued=${result.verified}`);
        // v1.0.9 §7 — rolling observability summary (counts only).
        this.metrics.logSummary('outbox-sweep');
      }
    } catch (err) {
      this.logger.warn(`Outbox sweep error: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * v1.0.12 §10 — deterministic scheduling barrier.
   *
   * Stops the background timer and waits for any in-flight sweep to finish,
   * so the caller (e.g. the integration suites' own submitOutbox invocation)
   * is the ONLY possible submission worker while paused. This closes the one
   * remaining nondeterminism in the payout-lockdown §3.1/§3.2 scenario: a
   * background sweep landing between the intent commit and the test's guard
   * claim would submit first and flip the expected LOOKUP_PENDING deferral
   * into ALREADY_SUBMITTED. Production behavior is unchanged — this is a
   * scoped, always-restored (try/finally in the caller) scheduling pause,
   * not a behavioral flag, and a no-op when the sweeper is disabled by env.
   */
  async pauseScheduling(): Promise<void> {
    this.paused = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Awaitility-style bounded wait for an already-started sweep to finish
    // (sweeps are short; the deadline only guards against pathological hangs).
    const deadline = Date.now() + 20_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Restores the background timer after pauseScheduling() (no-op otherwise). */
  resumeScheduling(): void {
    if (!this.paused) return;
    this.paused = false;
    this.onModuleInit();
  }
}
