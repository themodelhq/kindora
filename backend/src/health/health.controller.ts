import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import type { Response } from 'express';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness probe - must never touch external systems. */
  @Public()
  @Get()
  health() {
    return {
      status: 'ok',
      service: 'kindora-api',
      version: process.env.npm_package_version ?? '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('database')
  async database(@Res() res: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return res.status(200).json({ status: 'ok', component: 'database' });
    } catch (err) {
      // Never expose connection details publicly.
      return res.status(503).json({ status: 'degraded', component: 'database' });
    }
  }

  @Public()
  @Get('redis')
  async redisCheck(@Res() res: Response) {
    const ok = await this.redis.ping();
    return res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      component: 'redis',
      configured: process.env.REDIS_URL ? true : false,
    });
  }
}
