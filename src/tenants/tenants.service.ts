import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantStatus, TenantType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

const PHONE_PATTERN = /^0\d{9}$/;
const IDENTITY_NUMBER_PATTERN = /^\d{12}$/;
const CREATE_STATUSES: readonly TenantStatus[] = [TenantStatus.ACTIVE, TenantStatus.DEPOSITED];
const UPDATE_STATUSES: readonly TenantStatus[] = [TenantStatus.ACTIVE, TenantStatus.DEPOSITED, TenantStatus.LEFT];

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
    const data = this.normalizeTenantPayload(body, true);
    const tenant = await this.prisma.tenant.create({ data: { ...data, businessId: this.requireBusinessId(user) } as any });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'CREATE_TENANT', entity: 'Tenant', entityId: tenant.id });
    return tenant;
  }

  async updateTenant(user: AuthUser, id: string, body: any) {
    const existing = await this.get('tenant', user, id);
    const data = this.normalizeTenantPayload(body, false, existing);
    const tenant = await this.prisma.tenant.update({ where: { id }, data });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'UPDATE_TENANT', entity: 'Tenant', entityId: id });
    return tenant;
  }

  markLeft(user: AuthUser, id: string) {
    return this.updateTenant(user, id, { status: TenantStatus.LEFT });
  }

  private normalizeTenantPayload(body: Record<string, any>, isCreate: boolean, existing?: Record<string, any>) {
    const data: Record<string, any> = {};

    if (body.fullName !== undefined) data.fullName = this.requiredText(body.fullName, 'Full name is required');
    if (body.phone !== undefined || isCreate) data.phone = this.requiredPhone(body.phone, 'Phone is required', 'Invalid phone');
    if (body.identityNumber !== undefined || isCreate) data.identityNumber = this.requiredIdentityNumber(body.identityNumber);
    if (body.permanentAddress !== undefined || isCreate) data.permanentAddress = this.requiredText(body.permanentAddress, 'Permanent address is required');
    if (body.note !== undefined) data.note = this.optionalText(body.note);

    if (body.dateOfBirth !== undefined || isCreate) {
      data.dateOfBirth = this.normalizeDateOfBirth(body.dateOfBirth);
    }

    if (body.roommateCount !== undefined || isCreate) {
      data.roommateCount = this.normalizeRoommateCount(body.roommateCount ?? 0);
    }
    const roommateCount = data.roommateCount ?? (body.roommateCount === undefined ? undefined : this.normalizeRoommateCount(body.roommateCount));
    if (body.roommatePhone !== undefined) data.roommatePhone = this.optionalPhone(body.roommatePhone, 'Invalid roommate phone');
    const effectiveRoommatePhone = body.roommatePhone !== undefined ? data.roommatePhone : existing?.roommatePhone;
    if ((roommateCount ?? 0) > 0 && !this.optionalText(effectiveRoommatePhone)) {
      throw new BadRequestException('Roommate phone is required when roommate count is greater than 0');
    }

    const status = body.status ?? (isCreate ? TenantStatus.ACTIVE : undefined);
    if (status !== undefined) data.status = this.normalizeStatus(status, isCreate);

    if (isCreate && !data.fullName) throw new BadRequestException('Full name is required');
    data.tenantType = TenantType.ADULT;
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

  private optionalPhone(value: unknown, message: string) {
    const phone = this.optionalText(value);
    if (!phone) return null;
    if (!PHONE_PATTERN.test(phone)) throw new BadRequestException(message);
    return phone;
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
    const text = this.requiredText(value, 'Date of birth is required');
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date of birth');
    if (!isAtLeastAge(date, 18)) throw new BadRequestException('Tenant must be at least 18 years old');
    return date;
  }

  private normalizeRoommateCount(value: unknown) {
    const count = Number(value ?? 0);
    if (!Number.isInteger(count) || count < 0) throw new BadRequestException('Roommate count must be a non-negative integer');
    if (count > 10) throw new BadRequestException('Roommate count must not exceed 10');
    return count;
  }

  private normalizeStatus(value: unknown, isCreate: boolean) {
    const allowed = isCreate ? CREATE_STATUSES : UPDATE_STATUSES;
    if (!allowed.includes(value as TenantStatus)) {
      throw new BadRequestException(isCreate ? 'Tenant cannot be created with left status' : 'Invalid tenant status');
    }
    return value as TenantStatus;
  }

  private requireBusinessId(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Business scope is required');
    return user.businessId;
  }
}

function isAtLeastAge(date: Date, age: number) {
  const today = new Date();
  const birthdayThisYear = new Date(today.getFullYear(), date.getMonth(), date.getDate());
  const years = today.getFullYear() - date.getFullYear() - (today < birthdayThisYear ? 1 : 0);
  return years >= age;
}
