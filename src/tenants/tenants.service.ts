import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

const PHONE_PATTERN = /^0\d{9}$/;
const IDENTITY_NUMBER_PATTERN = /^\d{12}$/;
const CREATE_STATUSES: readonly TenantStatus[] = [TenantStatus.DEPOSITED, TenantStatus.STAYING];
const UPDATE_STATUSES: readonly TenantStatus[] = [TenantStatus.DEPOSITED, TenantStatus.STAYING, TenantStatus.LEFT];
const TENANT_SELECT = {
  id: true,
  businessId: true,
  fullName: true,
  phone: true,
  identityNumber: true,
  dateOfBirth: true,
  permanentAddress: true,
  note: true,
  status: true,
  createdAt: true,
  updatedAt: true,
};

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
      filterFields: ['status'],
      sortFields: ['fullName', 'phone', 'createdAt'],
      select: TENANT_SELECT,
    });
  }

  getTenant(user: AuthUser, id: string) {
    return this.get('tenant', user, id, undefined, true, TENANT_SELECT);
  }

  async createTenant(user: AuthUser, body: any) {
    const data = this.normalizeTenantPayload(body, true);
    const tenant = await this.prisma.tenant.create({ data: { ...data, businessId: this.requireBusinessId(user) } as any, select: TENANT_SELECT });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'CREATE_TENANT', entity: 'Tenant', entityId: tenant.id });
    return tenant;
  }

  async updateTenant(user: AuthUser, id: string, body: any) {
    const existing = await this.getTenant(user, id);
    const data = this.normalizeTenantPayload(body, false, existing);
    const tenant = await this.prisma.tenant.update({ where: { id }, data, select: TENANT_SELECT });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'UPDATE_TENANT', entity: 'Tenant', entityId: id });
    return tenant;
  }

  markLeft(user: AuthUser, id: string) {
    return this.updateTenant(user, id, { status: TenantStatus.LEFT });
  }

  private normalizeTenantPayload(body: Record<string, any>, isCreate: boolean, _existing?: Record<string, any>) {
    const data: Record<string, any> = {};

    if (body.fullName !== undefined) data.fullName = this.requiredText(body.fullName, 'Full name is required');
    if (body.phone !== undefined || isCreate) data.phone = this.requiredPhone(body.phone, 'Phone is required', 'Invalid phone');
    if (body.identityNumber !== undefined || isCreate) data.identityNumber = this.requiredIdentityNumber(body.identityNumber);
    if (body.permanentAddress !== undefined || isCreate) data.permanentAddress = this.requiredText(body.permanentAddress, 'Permanent address is required');
    if (body.note !== undefined) data.note = this.optionalText(body.note) ?? null;
    if (body.dateOfBirth !== undefined) data.dateOfBirth = this.normalizeDateOfBirth(body.dateOfBirth);

    const status = body.status ?? (isCreate ? TenantStatus.DEPOSITED : undefined);
    if (status !== undefined) data.status = this.normalizeStatus(status, isCreate);

    if (isCreate && !data.fullName) throw new BadRequestException('Full name is required');
    return data;
  }

  private requiredText(value: unknown, message: string) {
    const text = this.optionalText(value);
    if (!text) throw new BadRequestException(message);
    return text;
  }

  private optionalText(value: unknown) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text || undefined;
  }

  private requiredPhone(value: unknown, requiredMessage: string, invalidMessage: string) {
    const phone = this.optionalText(value);
    if (!phone) throw new BadRequestException(requiredMessage);
    if (!PHONE_PATTERN.test(phone)) throw new BadRequestException(invalidMessage);
    return phone;
  }

  private requiredIdentityNumber(value: unknown) {
    const identityNumber = this.requiredText(value, 'Identity number is required');
    if (!IDENTITY_NUMBER_PATTERN.test(identityNumber)) throw new BadRequestException('Identity number must be exactly 12 digits');
    return identityNumber;
  }

  private normalizeDateOfBirth(value: unknown) {
    const text = this.optionalText(value);
    if (!text) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date of birth');
    if (!isAtLeastAgeByYear(date, 18)) throw new BadRequestException('Tenant must be at least 18 years old');
    return date;
  }

  private normalizeStatus(value: unknown, isCreate: boolean) {
    const normalized = value === 'ACTIVE' ? TenantStatus.STAYING : value;
    const allowed = isCreate ? CREATE_STATUSES : UPDATE_STATUSES;
    if (!allowed.includes(normalized as TenantStatus)) {
      throw new BadRequestException(isCreate ? 'Tenant cannot be created with left status' : 'Invalid tenant status');
    }
    return normalized as TenantStatus;
  }

  private requireBusinessId(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Business scope is required');
    return user.businessId;
  }
}

function isAtLeastAgeByYear(date: Date, age: number) {
  return new Date().getFullYear() - date.getFullYear() >= age;
}
