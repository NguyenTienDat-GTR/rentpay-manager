import { Module } from '@nestjs/common';
import { NotificationLogsController } from './notification-logs.controller';

@Module({ controllers: [NotificationLogsController] })
export class NotificationLogsModule {}
