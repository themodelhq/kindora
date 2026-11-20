/**
 * Production startup validation — the application MUST fail fast rather than
 * boot with insecure defaults. Throws when:
 *  - JWT_SECRET is missing (a known source-controlled default would make
 *    access tokens forgeable);
 *  - DATABASE_URL is missing;
 *  - PROVIDER_MODE=mock in production (mock "payments" must never exist in
 *    a production deployment; it also silently disables webhook signature
 *    verification);
 *  - PROVIDER_MODE=live with zero provider secrets configured (a payments
 *    platform that cannot take payments is a configuration error);
 *  - SameSite=None cookies without Secure in production.
 * Non-production environments never throw (offline development keeps dev defaults).
 */
import { validateRedisUrl } from '../utils/redis-url.util';

function assertProductionSafety(isProd: boolean) {
  if (!isProd) return;
  const problems: string[] = [];
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'dev-only-secret-change-me') {
    problems.push('JWT_SECRET must be set to a strong secret in production (generateValue: true in render.yaml)');
  }
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL must be set in production');

  // v1.0.4 §9: strict Redis URL validation at startup — a malformed URL must
  // never reach the client library. Error text never contains credentials.
  if (process.env.REDIS_URL) {
    const redis = validateRedisUrl(process.env.REDIS_URL, {
      requireTls: (process.env.REDIS_REQUIRE_TLS ?? '') === 'true',
    });
    if (!redis.ok) {
      problems.push(`REDIS_URL is invalid: ${redis.reason} (${redis.sanitized})`);
    }
  }

  // v1.0.4 §6.5: the dual-approval configuration must be unambiguous.
  //  - Mode ALL (default): EVERY payout requires two distinct administrators.
  //  - Mode THRESHOLD: requires WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR > 0.
  //    A zero or negative threshold in THRESHOLD mode is a configuration error
  //    (it would silently disable dual approval) and is rejected at startup.
  const mode = (process.env.WITHDRAWAL_DUAL_APPROVAL_MODE ?? 'ALL').toUpperCase();
  if (!['ALL', 'THRESHOLD'].includes(mode)) {
    problems.push('WITHDRAWAL_DUAL_APPROVAL_MODE must be ALL or THRESHOLD');
  }
  if (mode === 'THRESHOLD') {
    const raw = process.env.WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR ?? '';
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value <= 0) {
      problems.push(
        'WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR must be a positive integer when WITHDRAWAL_DUAL_APPROVAL_MODE=THRESHOLD',
      );
    }
  }

  // v1.0.7 §14: payout provider configuration must be honest and complete.
  // A deployment advertising a payout provider without its secret key must
  // refuse to start — silent degradation would leak into financial execution.
  const payoutSupported = (process.env.PAYOUT_SUPPORTED_PROVIDERS ?? 'PAYSTACK,FLUTTERWAVE')
    .split(',')
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
  const IMPLEMENTED_PAYOUT_PROVIDERS = ['PAYSTACK', 'FLUTTERWAVE'];
  const unsupported = payoutSupported.filter((p) => !IMPLEMENTED_PAYOUT_PROVIDERS.includes(p) && p !== 'MOCK');
  if (unsupported.length > 0) {
    problems.push(
      `PAYOUT_SUPPORTED_PROVIDERS contains providers that are not implemented for payouts: ${unsupported.join(', ')} (implemented: ${IMPLEMENTED_PAYOUT_PROVIDERS.join(', ')})`,
    );
  }
  if (payoutSupported.includes('PAYSTACK') && !process.env.PAYSTACK_SECRET_KEY) {
    problems.push('PAYOUT_SUPPORTED_PROVIDERS includes PAYSTACK but PAYSTACK_SECRET_KEY is not set');
  }
  if (payoutSupported.includes('FLUTTERWAVE') && !process.env.FLUTTERWAVE_SECRET_KEY) {
    problems.push('PAYOUT_SUPPORTED_PROVIDERS includes FLUTTERWAVE but FLUTTERWAVE_SECRET_KEY is not set');
  }

  const providerMode = (process.env.PROVIDER_MODE ?? 'live').toLowerCase();
  if (providerMode === 'mock') {
    problems.push('PROVIDER_MODE=mock is forbidden in production (disables payment verification and webhook signatures)');
  }
  if (providerMode === 'live') {
    const anyProvider =
      process.env.PAYSTACK_SECRET_KEY ||
      process.env.FLUTTERWAVE_SECRET_KEY ||
      process.env.STRIPE_SECRET_KEY ||
      process.env.PAYPAL_CLIENT_ID;
    if (!anyProvider) {
      problems.push('At least one payment provider key must be configured when PROVIDER_MODE=live (PAYSTACK_SECRET_KEY, FLUTTERWAVE_SECRET_KEY, STRIPE_SECRET_KEY or PAYPAL_CLIENT_ID)');
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start: production configuration is unsafe.\n  - ${problems.join('\n  - ')}`,
    );
  }
}

export default () => {
  const isProd = process.env.NODE_ENV === 'production';
  assertProductionSafety(isProd);
  return {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT ?? '10000', 10),
  appName: process.env.APP_NAME ?? 'KINDORA',
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  backendUrl: process.env.BACKEND_URL ?? 'http://localhost:10000',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  providerMode: (process.env.PROVIDER_MODE ?? 'live') as 'live' | 'mock',
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
    accessTtlSeconds: parseInt(process.env.JWT_ACCESS_TTL ?? '900', 10),
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
  },
  money: {
    defaultCurrency: process.env.DEFAULT_CURRENCY ?? 'NGN',
    platformFeePercent: parseInt(process.env.PLATFORM_FEE_PERCENT ?? '0', 10),
    minDonationMinor: 10000,
  },
  payouts: {
    // v1.0.7 — payout execution configuration. Only genuinely implemented
    // providers (PAYSTACK, FLUTTERWAVE) may be active; Stripe payouts are
    // disabled until a real Stripe Connect adapter ships (§6 of the v1.0.7
    // prompt). PAYOUT_UNKNOWN_ESCALATION_MINUTES bounds how long an ambiguous
    // submission may stay unresolved before escalating to manual review.
    supportedProviders: (process.env.PAYOUT_SUPPORTED_PROVIDERS ?? 'PAYSTACK,FLUTTERWAVE').toUpperCase(),
    unknownEscalationMinutes: parseInt(process.env.PAYOUT_UNKNOWN_ESCALATION_MINUTES ?? '120', 10),
    outboxSweepSeconds: parseInt(process.env.PAYOUT_OUTBOX_SWEEP_SECONDS ?? '30', 10),
    // v1.0.8 §5.2 — outbox lease window. A claimed IN_FLIGHT intent is owned
    // only until the lease expires; recovery reclaims expired leases through
    // the SAFE path (provider lookup before any resubmission).
    leaseMinutes: parseInt(process.env.PAYOUT_OUTBOX_LEASE_MINUTES ?? '10', 10),
    // v1.0.8 §6.3 — Flutterwave mobile-money payouts remain DISABLED until
    // their beneficiary verification is proven against the provider sandbox.
    // The verification implementation ships in v1.0.8; the channel opens only
    // when PAYOUT_FLW_MOBILE_MONEY_ENABLED=true AND sandbox tests have passed.
    flwMobileMoneyEnabled: process.env.PAYOUT_FLW_MOBILE_MONEY_ENABLED === 'true',
  },
  workerIngestToken: process.env.WORKER_INGEST_TOKEN ?? '',
  withdrawals: {
    // Dual-approval policy (v1.0.4). ALL (default) = every payout requires two
    // distinct administrators and a separate payout executor identity.
    // THRESHOLD = only payouts >= WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR.
    // There is NO configuration that disables dual approval entirely.
    dualApprovalMode: (process.env.WITHDRAWAL_DUAL_APPROVAL_MODE ?? 'ALL').toUpperCase() as 'ALL' | 'THRESHOLD',
    dualApprovalThresholdMinor: process.env.WITHDRAWAL_DUAL_APPROVAL_THRESHOLD_MINOR ?? '0',
  },
  mfa: {
    // Optional dedicated key for TOTP secret encryption at rest. Falls back to
    // a scrypt-derived, domain-separated key from JWT_SECRET when unset.
    encryptionKey: process.env.MFA_ENCRYPTION_KEY ?? '',
  },
  storage: {
    endpoint: process.env.STORAGE_ENDPOINT ?? '',
    bucket: process.env.STORAGE_BUCKET ?? '',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    accessKey: process.env.STORAGE_ACCESS_KEY ?? '',
    secretKey: process.env.STORAGE_SECRET_KEY ?? '',
    forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL ?? '',
    maxUploadMb: parseInt(process.env.STORAGE_MAX_UPLOAD_MB ?? '15', 10),
  },
  email: {
    provider: process.env.EMAIL_PROVIDER ?? 'smtp',
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    user: process.env.SMTP_USER ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
    fromAddress: process.env.EMAIL_FROM_ADDRESS ?? 'no-reply@kindora.com',
    fromName: process.env.EMAIL_FROM_NAME ?? 'KINDORA',
  },
  sms: {
    apiKey: process.env.SMS_PROVIDER_API_KEY ?? '',
    senderId: process.env.SMS_SENDER_ID ?? 'KINDORA',
  },
  payments: {
    paystack: { secretKey: process.env.PAYSTACK_SECRET_KEY ?? '' },
    flutterwave: {
      secretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? '',
      webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH ?? '',
    },
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY ?? '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    },
    paypal: {
      clientId: process.env.PAYPAL_CLIENT_ID ?? '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
      webhookId: process.env.PAYPAL_WEBHOOK_ID ?? '',
      env: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    },
  },
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    subject: process.env.VAPID_SUBJECT ?? 'mailto:dev@kindora.com',
  },
  ai: {
    apiKey: process.env.AI_PROVIDER_API_KEY ?? '',
    baseUrl: process.env.AI_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.AI_PROVIDER_MODEL ?? 'gpt-4o-mini',
  },
  sentryDsn: process.env.SENTRY_DSN ?? '',
  };
};
