import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * Own-notification endpoints: paged list, read receipts, unread count.
 * Every query is scoped to the caller — users can only ever see their own
 * notifications.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, skip: number, limit: number) {
    const [total, items] = await this.prisma.$transaction([
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return { total, items };
  }

  /** Marks a single notification read. Reading an already-read note is idempotent. */
  async markRead(userId: string, id: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (updated.count === 0) {
      const exists = await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
      if (!exists) throw new NotFoundException('Notification not found');
      return { marked: false, alreadyRead: true };
    }
    return { marked: true };
  }

  async markAllRead(userId: string) {
    const updated = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: updated.count };
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({ where: { userId, readAt: null } });
    return { count };
  }
}
