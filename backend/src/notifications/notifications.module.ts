import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotifyService } from './notify.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotifyService],
  exports: [NotificationsService, NotifyService],
})
export class NotificationsModule {}
