import { Injectable } from '@nestjs/common';
import { BankConnectionStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BankConnectionsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'bankConnection',
      user,
      query,
      searchFields: ['bankCode', 'provider'],
      filterFields: ['status', 'provider'],
      sortFields: ['bankCode', 'provider', 'status', 'createdAt'],
      include: { bankAccount: true },
    });
  }

  async connectMock(user: AuthUser, body: any) {
    const bankAccount = await this.prisma.bankAccount.findFirst({ where: { id: body.bankAccountId, businessId: user.businessId! } });
    const created = await this.prisma.bankConnection.create({
      data: {
        businessId: user.businessId!,
        bankAccountId: body.bankAccountId,
        bankCode: bankAccount?.bankCode ?? body.bankCode,
        provider: body.provider ?? 'MANUAL',
        status: BankConnectionStatus.CONNECTED,
      },
    });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'CONNECT_BANK', entity: 'BankConnection', entityId: created.id });
    return created;
  }

  disconnect(user: AuthUser, id: string) {
    return this.update('bankConnection', user, id, { status: BankConnectionStatus.DISCONNECTED });
  }
}
