import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.notifications.list(user.id, pagination.skip, pagination.limit);
  }

  // NOTE: declared before any future ':id' route so it is not captured as an id.
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post(':id/read')
  async markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }
}
