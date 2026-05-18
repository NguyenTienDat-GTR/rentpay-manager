import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BankAccountsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'bankAccount',
      user,
      query,
      searchFields: ['bankName', 'bankCode', 'accountNumber', 'accountName'],
      filterFields: ['status', 'isDefault', 'bankCode'],
      sortFields: ['bankName', 'accountNumber', 'createdAt'],
    });
  }

  async createAccount(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const account = await this.prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.bankAccount.updateMany({ where: { businessId }, data: { isDefault: false } });
      return tx.bankAccount.create({ data: { ...body, businessId } });
    });
    await this.audit.log({ businessId, userId: user.sub, action: 'CREATE_BANK_ACCOUNT', entity: 'BankAccount', entityId: account.id });
    return account;
  }

  async setDefault(user: AuthUser, id: string) {
    const account = await this.get('bankAccount', user, id);
    await this.prisma.$transaction([
      this.prisma.bankAccount.updateMany({ where: { businessId: account.businessId }, data: { isDefault: false } }),
      this.prisma.bankAccount.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return this.get('bankAccount', user, id);
  }
}
