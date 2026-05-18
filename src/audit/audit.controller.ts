import { Controller, Get, Query } from '@nestjs/common';
import { BaseCrudService } from '../common/base-crud.service';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('audit-logs')
export class AuditController extends BaseCrudService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return super.listItems({
      model: 'auditLog',
      user,
      query,
      searchFields: ['action', 'entity'],
      filterFields: ['action', 'entity', 'userId'],
      sortFields: ['createdAt', 'action', 'entity'],
      include: { user: { select: { id: true, fullName: true, phone: true } } },
      businessScoped: user.role !== 'SUPER_ADMIN',
    });
  }

  @Get('payments')
  paymentLogs(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.list(user, { ...query, entity: 'Payment' });
  }
}
