import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { UsersService } from './users.service';
import {
  ChangePasswordDto,
  PushSubscriptionDto,
  SubmitKycDto,
  UpdateNotificationPrefsDto,
  UpdateProfileDto,
} from './dto/user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getProfile(user.id);
  }

  @Patch('me')
  async updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('me/change-password')
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.users.changePassword(user.id, dto);
  }

  @Get('me/notifications')
  async notifications(@CurrentUser() user: AuthenticatedUser, @Query() pagination: PaginationDto) {
    return this.users.listNotifications(user.id, pagination.skip, pagination.limit);
  }

  /** Marks all unread notifications as read. */
  @HttpCode(200)
  @Post('me/notifications/read')
  async markNotificationsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.users.markAllNotificationsRead(user.id);
  }

  @Get('me/prefs')
  async prefs(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getPreferences(user.id);
  }

  // 'prefs' is kept as a short alias; the canonical route is /notification-preferences.
  @Patch(['me/notification-preferences', 'me/prefs'])
  async updatePrefs(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateNotificationPrefsDto) {
    return this.users.updatePreferences(user.id, dto);
  }

  @Get('me/sessions')
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.users.listSessions(user.id);
  }

  @Delete('me/sessions/:id')
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id') sessionId: string) {
    return this.users.revokeSession(user.id, sessionId);
  }

  @Post('me/kyc')
  async submitKyc(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubmitKycDto) {
    return this.users.submitKyc(user.id, dto);
  }

  @Get('me/kyc')
  async kyc(@CurrentUser() user: AuthenticatedUser) {
    return this.users.listKyc(user.id);
  }

  @Post('me/push-subscriptions')
  async pushSubscription(@CurrentUser() user: AuthenticatedUser, @Body() dto: PushSubscriptionDto) {
    return this.users.upsertPushSubscription(user.id, dto);
  }
}
