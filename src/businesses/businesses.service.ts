import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ListQuery } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BusinessesService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    super(prisma);
  }

  list(user: AuthUser, query: ListQuery) {
    return super.listItems({
      model: 'business',
      user,
      query,
      searchFields: ['businessName', 'businessSlug', 'ownerName', 'taxCode'],
      filterFields: ['status'],
      sortFields: ['businessName', 'ownerName', 'createdAt'],
      businessScoped: false,
    });
  }

  async getMyBusiness(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('No business assigned');
    return this.prisma.business.findUnique({ where: { id: user.businessId } });
  }

  async updateMyBusiness(user: AuthUser, body: any) {
    if (!user.businessId) throw new BadRequestException('No business assigned');
    const updated = await this.prisma.business.update({ where: { id: user.businessId }, data: body });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'UPDATE_BUSINESS', entity: 'Business', entityId: user.businessId });
    return updated;
  }

  async createBusinessOwner(user: AuthUser, body: any) {
    const result = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          businessName: body.businessName,
          businessSlug: body.businessSlug,
          ownerName: body.ownerName,
          taxCode: body.taxCode,
          address: body.address,
        },
      });
      const owner = await tx.user.create({
        data: {
          fullName: body.fullName ?? body.ownerName,
          phone: body.phone,
          passwordHash: await bcrypt.hash(body.password ?? '123456', 12),
          role: Role.BUSINESS_OWNER,
          businessId: business.id,
        },
        select: { id: true, fullName: true, phone: true, role: true, businessId: true },
      });
      return { business, owner };
    });
    await this.audit.log({ userId: user.sub, action: 'CREATE_BUSINESS_OWNER', entity: 'Business', entityId: result.business.id });
    return result;
  }
}
