import { Controller, Get, Query } from '@nestjs/common';
import { BaseCrudService } from '../common/base-crud.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('notification-logs')
export class NotificationLogsController extends BaseCrudService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return super.listItems({
      model: 'notificationLog',
      user,
      query,
      searchFields: [],
      filterFields: ['action', 'createdBy'],
      sortFields: ['createdAt', 'action'],
      include: { charge: true, tenant: true, room: true, creator: { select: { id: true, fullName: true, phone: true } } },
    });
  }
}
