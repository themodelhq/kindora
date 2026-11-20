import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { QueueService } from './queue.service';
import { IdempotencyService } from './idempotency.service';

/**
 * Global infrastructure services shared by every feature module:
 * Redis (cache + locks), BullMQ producer (with offline degradation) and
 * database-backed idempotency.
 */
@Global()
@Module({
  providers: [RedisService, QueueService, IdempotencyService],
  exports: [RedisService, QueueService, IdempotencyService],
})
export class CoreModule {}
