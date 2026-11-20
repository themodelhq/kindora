import { Body, Controller, Get, Headers, HttpCode, Injectable, Module, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { ConfigService } from '@nestjs/config';
import { ManualReviewService } from '../payouts/manual-review.service';
import { PayoutInitiationService } from '../payouts/payout-initiation.service';
import { PayoutSecurityMetricsService } from '../payouts/payout-metrics.service';
import { PayoutVerificationService } from '../payouts/payout-verification.service';
import { PayoutsModule } from '../payouts/payouts.module';

/**
 * v1.0.7 §12 — internal worker ingest endpoints.
 *
 * The kindora-worker service consumes the `payouts` BullMQ queue and calls
 * these endpoints so that EVERY financial state mutation stays inside the
 * backend services (single owner of the state machine). The worker holds no
 * financial logic of its own: it is a reliable trigger with bounded retries,
 * exponential backoff and a dead-letter trail.
 *
 * Security: requests require the `x-worker-token` shared secret
 * (WORKER_INGEST_TOKEN). When the token is not configured the endpoints
 * return 503 — fail closed, never open. Tokens are compared in constant time.
 */
@Injectable()
export class WorkerAuthGuard {
  constructor(private readonly config: ConfigService) {}

  assert(headers: Record<string, string | undefined>): void {
    const expected = this.config.get<string>('workerIngestToken') ?? '';
    const provided = headers['x-worker-token'] ?? '';
    if (!expected) {
      // Fail closed: without a configured token the ingest surface is closed.
      throw new ServiceUnavailableException(
        'Worker ingest is not configured (WORKER_INGEST_TOKEN missing) — payouts are handled by the in-process sweeper',
      );
    }
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new UnauthorizedException('Invalid worker token');
    }
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

@Public()
@Controller('internal/payouts')
export class InternalPayoutsController {
  constructor(
    private readonly guard: WorkerAuthGuard,
    private readonly initiation: PayoutInitiationService,
    private readonly verification: PayoutVerificationService,
    private readonly manualReview: ManualReviewService,
    private readonly metrics: PayoutSecurityMetricsService,
  ) {}

  @HttpCode(200)
  @Post('outbox/submit')
  async submitOutbox(@Body() body: { attemptId?: string }, @Headers() headers: Record<string, string | undefined>) {
    this.guard.assert(headers);
    const attemptId = body?.attemptId;
    if (!attemptId) throw new ServiceUnavailableException('attemptId is required');
    const summary = await this.initiation.submitOutbox(attemptId);
    return { ok: true, ...summary };
  }

  @HttpCode(200)
  @Post('attempts/verify')
  async verifyAttempt(@Body() body: { attemptId?: string; correlationId?: string }, @Headers() headers: Record<string, string | undefined>) {
    this.guard.assert(headers);
    if (!body?.attemptId) throw new ServiceUnavailableException('attemptId is required');
    const result = await this.verification.verifyAttempt(body.attemptId, { source: 'API_VERIFY', correlationId: body.correlationId });
    return { ok: true, ...result };
  }

  @HttpCode(200)
  @Post('recovery-sweep')
  async recoverySweep(@Headers() headers: Record<string, string | undefined>) {
    this.guard.assert(headers);
    const result = await this.initiation.recoverySweep();
    return { ok: true, ...result };
  }

  @HttpCode(200)
  @Post('escalate-unknowns')
  async escalateUnknowns(@Headers() headers: Record<string, string | undefined>) {
    this.guard.assert(headers);
    const escalated = await this.manualReview.escalateStaleUnknowns();
    return { ok: true, escalated };
  }

  @Get('health')
  health() {
    // Unauthenticated liveness for the worker deployment (no financial data).
    return { ok: true, service: 'internal-payouts' };
  }

  /**
   * v1.0.9 §7 — payout security observability counters (worker-token
   * protected). Counts only: ambiguous/error lookups, expired-lease reclaims,
   * lookup retries, blocked settlements/submissions, duplicate-submission
   * preventions. No secrets, no identifiers, no provider payloads.
   */
  @Get('security-metrics')
  securityMetrics(@Headers() headers: Record<string, string | undefined>) {
    this.guard.assert(headers);
    return { ok: true, metrics: this.metrics.snapshot() };
  }
}

@Module({
  // PayoutsModule exports PayoutInitiationService, PayoutVerificationService and
  // ManualReviewService — the internal controller owns no financial logic itself.
  imports: [PayoutsModule],
  providers: [WorkerAuthGuard, InternalPayoutsController],
  controllers: [InternalPayoutsController],
  exports: [WorkerAuthGuard],
})
export class InternalPayoutsModule {}
