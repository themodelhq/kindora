import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma.service';

/**
 * Integration-test bootstrap.
 *
 * Boots the real AppModule in-process against a REAL PostgreSQL
 * (PROVIDER_MODE=mock, no Redis) and mirrors main.ts so the tested HTTP
 * surface matches production: trust-proxy, cookie-parser, helmet, CORS,
 * global prefix api/v1, JSON body parser with rawBody support (webhook
 * signature verification) and the global ValidationPipe.
 *
 * cookie-parser MUST be registered before the auth controllers execute —
 * the refresh/logout flows read the httpOnly `kindora_refresh` cookie
 * (cookie-only silent refresh and logout are covered by auth.e2e-spec.ts).
 *
 * AuthModule: app.module.ts already imports `AuthModule.forRoot()`, which
 * mounts the test-only dev verification controller (`POST /auth/dev/
 * complete-verification`) exactly when PROVIDER_MODE=mock — i.e. always in
 * this environment (see test/env.ts). No separate wiring is needed here.
 *
 * Specs guard execution with:
 *   const RUN = process.env.RUN_INTEGRATION === '1';
 *   const maybeDescribe = RUN ? describe : describe.skip;
 */

let cachedApp: NestExpressApplication | null = null;

export async function createTestApp(): Promise<NestExpressApplication> {
  if (cachedApp) return cachedApp;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true, // webhook controllers verify provider signatures over the raw body
    logger: ['error', 'warn'],
  });

  // ---- mirror main.ts -------------------------------------------------------
  app.set('trust proxy', 1);
  // Cookie parsing MUST be registered before auth controllers execute —
  // the refresh/logout flows read the httpOnly kindora_refresh cookie.
  app.use(cookieParser());
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'x-mfa-challenge'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.setGlobalPrefix('api/v1');
  app.useBodyParser('json', { limit: '2mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.enableShutdownHooks();
  // ---------------------------------------------------------------------------

  await app.init();
  cachedApp = app;
  return app;
}

export async function closeTestApp(): Promise<void> {
  if (cachedApp) {
    const app = cachedApp;
    cachedApp = null;
    await app.close();
  }
}

/**
 * Direct Prisma access for assertions and test seeding (StoredFile rows,
 * role promotion, ledger counts). Returns the PrismaService instance owned
 * by the cached test app; throws if called before createTestApp().
 */
export function getTestPrisma(): PrismaService {
  if (!cachedApp) throw new Error('getTestPrisma() called before createTestApp()');
  return cachedApp.get(PrismaService);
}

/** Standard integration guard: specs skip entirely unless the env is set. */
export const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
export const maybeDescribe = RUN_INTEGRATION ? describe : describe.skip;

// End-to-end flows are long-running: give each test generous time.
jest.setTimeout(120000);
