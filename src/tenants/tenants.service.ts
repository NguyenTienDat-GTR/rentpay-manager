import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'tenant',
      user,
      query,
      searchFields: ['fullName', 'phone', 'identityNumber', 'permanentAddress'],
      filterFields: ['tenantType', 'status'],
      sortFields: ['fullName', 'phone', 'createdAt'],
    });
  }

  async createTenant(user: AuthUser, body: any) {
    if (body.phone && !/^(0|\+84)[0-9]{9,10}$/.test(body.phone)) throw new BadRequestException('Invalid phone');
    const tenant = await super.create('tenant', user, body);
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'CREATE_TENANT', entity: 'Tenant', entityId: tenant.id });
    return tenant;
  }

  async updateTenant(user: AuthUser, id: string, body: any) {
    const tenant = await super.update('tenant', user, id, body);
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'UPDATE_TENANT', entity: 'Tenant', entityId: id });
    return tenant;
  }

  markLeft(user: AuthUser, id: string) {
    return this.updateTenant(user, id, { status: TenantStatus.LEFT });
  }
}
