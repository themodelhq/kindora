import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { QueueService } from '../common/queue.service';

/**
 * Reusable notification facade for every feature module.
 *
 * notify() always persists the in-app Notification row and additionally
 * enqueues a push-delivery job for the worker. Failures degrade gracefully
 * (logged, never thrown): notifications are a side-channel and must not
 * break the caller's primary flow (e.g. a donation or a refund).
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async notify(
    userId: string,
    type: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId,
          type,
          title,
          body,
          ...(data ? { data: data as Prisma.InputJsonValue } : {}),
        },
      });

      await this.queue.enqueue('push', 'push.send', {
        userId,
        title,
        body,
        data: data ?? {},
      });

      return notification;
    } catch (err) {
      this.logger.warn(`notify(${type}) failed for user ${userId}: ${(err as Error).message}`);
      return null;
    }
  }
}
