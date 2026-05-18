import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { TenantStatus, TenantType } from '@prisma/client';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthUser } from '../src/common/decorators/current-user.decorator';
import { TenantsService } from '../src/tenants/tenants.service';

const user: AuthUser = {
  sub: 'user-1',
  role: 'BUSINESS_OWNER',
  businessId: 'business-1',
  sessionId: 'session-1',
};

function birthDateYearsAgo(years: number) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma = {
    tenant: {
      findFirst: async () => ({ id: 'tenant-1', businessId: user.businessId }),
      create: async ({ data }: any) => ({ id: 'tenant-1', ...data }),
      update: async ({ data }: any) => ({ id: 'tenant-1', businessId: user.businessId, ...data }),
    },
    ...prismaOverrides,
  } as any;
  const audit = { log: async () => undefined } as any;
  return new TenantsService(prisma, audit);
}

describe('TenantsService', () => {
  it('requires tenants to be at least 18 years old', async () => {
    const service = makeService();

    await assert.rejects(
      () => service.createTenant(user, { fullName: 'Nguyen Van A', dateOfBirth: birthDateYearsAgo(17) }),
      BadRequestException,
    );
  });

  it('creates deposited adult tenants and normalizes data from the FE form', async () => {
    let createdData: any;
    const service = makeService({
      tenant: {
        create: async ({ data }: any) => {
          createdData = data;
          return { id: 'tenant-1', ...data };
        },
      },
    });

    const tenant = await service.createTenant(user, {
      fullName: 'Nguyen Van A',
      phone: '0912345678',
      dateOfBirth: birthDateYearsAgo(18),
      tenantType: TenantType.CHILD,
      status: TenantStatus.DEPOSITED,
      roommateCount: 1,
      roommatePhone: '0987654321',
    });

    assert.equal(tenant.status, TenantStatus.DEPOSITED);
    assert.equal(createdData.businessId, user.businessId);
    assert.equal(createdData.tenantType, TenantType.ADULT);
    assert.equal(createdData.roommateCount, 1);
    assert.ok(createdData.dateOfBirth instanceof Date);
  });

  it('does not allow left status during tenant creation', async () => {
    const service = makeService();

    await assert.rejects(
      () => service.createTenant(user, { fullName: 'Nguyen Van A', dateOfBirth: birthDateYearsAgo(20), status: TenantStatus.LEFT }),
      BadRequestException,
    );
  });

  it('requires one roommate phone when roommate count is greater than zero', async () => {
    const service = makeService();

    await assert.rejects(
      () => service.createTenant(user, { fullName: 'Nguyen Van A', dateOfBirth: birthDateYearsAgo(20), roommateCount: 1 }),
      BadRequestException,
    );
  });
});
