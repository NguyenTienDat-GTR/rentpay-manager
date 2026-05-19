import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
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

function birthDateInYear(yearsAgo: number, month = 12, day = 31) {
  const year = new Date().getFullYear() - yearsAgo;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validTenantBody(overrides: Record<string, any> = {}) {
  return {
    fullName: 'Nguyen Van A',
    phone: '0912345678',
    identityNumber: '012345678901',
    dateOfBirth: birthDateYearsAgo(20),
    permanentAddress: '123 Nguyen Trai',
    ...overrides,
  };
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
      () => service.createTenant(user, validTenantBody({ dateOfBirth: birthDateYearsAgo(17) })),
      BadRequestException,
    );
  });

  it('requires phone, identity number, and permanent address during tenant creation', async () => {
    const service = makeService();

    await assert.rejects(() => service.createTenant(user, validTenantBody({ phone: '' })), BadRequestException);
    await assert.rejects(() => service.createTenant(user, validTenantBody({ identityNumber: '' })), BadRequestException);
    await assert.rejects(() => service.createTenant(user, validTenantBody({ permanentAddress: '' })), BadRequestException);
  });

  it('validates phone and identity number formats', async () => {
    const service = makeService();

    await assert.rejects(() => service.createTenant(user, validTenantBody({ phone: '+84912345678' })), BadRequestException);
    await assert.rejects(() => service.createTenant(user, validTenantBody({ phone: '091234567' })), BadRequestException);
    await assert.rejects(() => service.createTenant(user, validTenantBody({ identityNumber: '01234567890' })), BadRequestException);
    await assert.rejects(() => service.createTenant(user, validTenantBody({ identityNumber: '01234567890A' })), BadRequestException);
  });

  it('creates deposited tenants and normalizes data from the FE form', async () => {
    let createdData: any;
    const service = makeService({
      tenant: {
        create: async ({ data }: any) => {
          createdData = data;
          return { id: 'tenant-1', ...data };
        },
      },
    });

    const tenant = await service.createTenant(user, validTenantBody({
      dateOfBirth: birthDateYearsAgo(18),
      status: TenantStatus.DEPOSITED,
    }));

    assert.equal(tenant.status, TenantStatus.DEPOSITED);
    assert.equal(createdData.businessId, user.businessId);
    assert.ok(createdData.dateOfBirth instanceof Date);
  });

  it('allows blank date of birth during tenant creation and update', async () => {
    const service = makeService();

    const created = await service.createTenant(user, validTenantBody({ dateOfBirth: '' }));
    const updated = await service.updateTenant(user, 'tenant-1', { dateOfBirth: '' });

    assert.equal(created.dateOfBirth, null);
    assert.equal(updated.dateOfBirth, null);
  });

  it('checks adult tenants by birth year only', async () => {
    let createdData: any;
    const service = makeService({
      tenant: {
        create: async ({ data }: any) => {
          createdData = data;
          return { id: 'tenant-1', ...data };
        },
      },
    });

    await service.createTenant(user, validTenantBody({ dateOfBirth: birthDateInYear(18, 12, 31) }));

    assert.ok(createdData.dateOfBirth instanceof Date);
  });

  it('does not allow left status during tenant creation', async () => {
    const service = makeService();

    await assert.rejects(
      () => service.createTenant(user, validTenantBody({ status: TenantStatus.LEFT })),
      BadRequestException,
    );
  });

});
