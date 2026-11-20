import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['log', 'warn', 'error'],
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 10000;
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Render terminates TLS at its proxy: trust exactly one proxy hop so
  // req.ip is the real client address (rate limiting / audit metadata), and
  // never trust client-supplied X-Forwarded-For deeper chains.
  app.set('trust proxy', 1);

  // Cookie parsing MUST be registered before auth controllers execute —
  // the refresh/logout flows read the httpOnly kindora_refresh cookie.
  app.use(cookieParser());

  // Security headers (CSP disabled: this service serves JSON only).
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));

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

  // Guards, BigInt serializer and the exception filter are registered
  // globally via AppModule providers (see app.module.ts).
  app.enableShutdownHooks(); // graceful shutdown: in-flight requests finish, resources close

  await app.listen(port, '0.0.0.0');
  logger.log(`KINDORA API listening on 0.0.0.0:${port} (env=${process.env.NODE_ENV ?? 'development'})`);
}

bootstrap().catch((err) => {
   
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
