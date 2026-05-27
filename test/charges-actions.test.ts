import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ChargeStatus } from '@prisma/client';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChargesService } from '../src/charges/charges.service';
import { AuthUser } from '../src/common/decorators/current-user.decorator';

const user: AuthUser = {
  sub: 'user-1',
  role: 'BUSINESS_OWNER',
  businessId: 'business-1',
  sessionId: 'session-1',
};

function makeCharge(status: ChargeStatus) {
  return {
    id: 'charge-1',
    businessId: user.businessId,
    status,
    amountDue: 1000000,
    amountPaid: status === ChargeStatus.PAID ? 1000000 : 0,
  };
}

function makeService(status: ChargeStatus) {
  const calls: Record<string, any[]> = { updates: [] };
  const prisma = {
    charge: {
      findFirst: async () => makeCharge(status),
      update: async ({ data }: any) => {
        calls.updates.push(data);
        return { ...makeCharge(status), ...data };
      },
    },
  } as any;
  const service = new ChargesService(prisma, {} as any, {} as any, {} as any, {} as any);
  return { service, calls };
}

describe('Charges action guards', () => {
  it('blocks updates for cancelled and paid charges', async () => {
    for (const status of [ChargeStatus.CANCELLED, ChargeStatus.PAID]) {
      const { service } = makeService(status);

      await assert.rejects(() => service.updateCharge(user, 'charge-1', { title: 'Updated' }), BadRequestException);
    }
  });

  it('blocks cancelling cancelled and paid charges', async () => {
    for (const status of [ChargeStatus.CANCELLED, ChargeStatus.PAID]) {
      const { service, calls } = makeService(status);

      await assert.rejects(() => service.cancel(user, 'charge-1'), BadRequestException);
      assert.equal(calls.updates.length, 0);
    }
  });
});
