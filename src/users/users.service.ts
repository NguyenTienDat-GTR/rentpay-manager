import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { ListQuery } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    super(prisma);
  }

  list(user: AuthUser, query: ListQuery) {
    return super.listItems({
      model: 'user',
      user,
      query,
      searchFields: ['fullName', 'phone'],
      filterFields: ['role', 'isActive', 'businessId'],
      sortFields: ['fullName', 'phone', 'role', 'createdAt'],
      include: { business: true },
      businessScoped: user.role !== Role.SUPER_ADMIN,
    });
  }

  async createUser(user: AuthUser, body: any) {
    const role = body.role as Role;
    if (user.role === Role.BUSINESS_OWNER && role !== Role.STAFF) {
      throw new BadRequestException('BUSINESS_OWNER can only create STAFF');
    }
    if (user.role === Role.STAFF) throw new BadRequestException('STAFF cannot create users');
    const businessId = user.role === Role.SUPER_ADMIN ? body.businessId : user.businessId;
    if (role !== Role.SUPER_ADMIN && !businessId) throw new BadRequestException('businessId is required');

    const created = await this.prisma.user.create({
      data: {
        fullName: body.fullName,
        phone: body.phone,
        passwordHash: await bcrypt.hash(body.password ?? '123456', 12),
        role,
        businessId: role === Role.SUPER_ADMIN ? null : businessId,
        isActive: body.isActive ?? true,
      },
      select: { id: true, fullName: true, phone: true, role: true, businessId: true, isActive: true, createdAt: true },
    });
    await this.audit.log({ businessId, userId: user.sub, action: `CREATE_${role}`, entity: 'User', entityId: created.id });
    return created;
  }

  async updateUser(user: AuthUser, id: string, body: any) {
    const target = await this.prisma.user.findFirst({
      where: user.role === Role.SUPER_ADMIN ? { id } : { id, businessId: user.businessId },
    });
    if (!target) throw new BadRequestException('User not found');
    if (body.password) body.passwordHash = await bcrypt.hash(body.password, 12);
    delete body.password;
    delete body.businessId;
    const updated = await this.prisma.user.update({ where: { id }, data: body });
    await this.audit.log({ businessId: target.businessId, userId: user.sub, action: 'UPDATE_USER', entity: 'User', entityId: id });
    return updated;
  }
}
