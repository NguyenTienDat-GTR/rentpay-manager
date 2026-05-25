import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ChargeStatus, PaymentMatchStatus, PaymentStatus, TransactionClassification, TransactionType } from '@prisma/client';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BankTransactionsService } from '../src/bank-transactions/bank-transactions.service';
import { AuthUser } from '../src/common/decorators/current-user.decorator';

const user: AuthUser = {
  sub: 'user-1',
  role: 'BUSINESS_OWNER',
  businessId: 'business-1',
  sessionId: 'session-1',
};

function makeTransaction(overrides: Record<string, any> = {}) {
  return {
    id: 'transaction-1',
    businessId: user.businessId,
    bankAccountId: 'bank-account-1',
    amount: 1000000,
    description: 'Thanh toan phong A-101',
    transactionTime: new Date('2026-05-25T01:00:00.000Z'),
    type: TransactionType.IN,
    payments: [],
    ...overrides,
  };
}

function makeMatch(overrides: Record<string, any> = {}) {
  return {
    id: 'match-1',
    businessId: user.businessId,
    transactionId: 'transaction-1',
    chargeId: null,
    matchStatus: PaymentMatchStatus.NEEDS_REVIEW,
    confidence: 40,
    transaction: makeTransaction(),
    ...overrides,
  };
}

function makeCharge(overrides: Record<string, any> = {}) {
  return {
    id: 'charge-1',
    businessId: user.businessId,
    roomId: 'room-1',
    contractId: 'contract-1',
    payerTenantId: 'tenant-1',
    billingPeriodId: 'period-1',
    bankAccountId: 'bank-account-1',
    paymentCode: 'RTP-ABC123',
    transferContent: 'THUE RTP-ABC123',
    amountDue: 1000000,
    amountPaid: 0,
    status: ChargeStatus.UNPAID,
    room: { id: 'room-1', roomCode: 'A-101', roomArea: { name: 'Khu A' } },
    payerTenant: { id: 'tenant-1', fullName: 'Nguyen Van A', phone: '0912345678' },
    billingPeriod: { id: 'period-1' },
    ...overrides,
  };
}

function makeService({ match = makeMatch(), charge = makeCharge(), suggestedCharges = [] }: { match?: any; charge?: any; suggestedCharges?: any[] } = {}) {
  const calls: Record<string, any[]> = { payments: [], matchUpdates: [], transactionUpdates: [], audits: [] };
  const tx = {
    payment: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        calls.payments.push(data);
        return { id: 'payment-1', ...data };
      },
    },
    paymentMatch: {
      update: async ({ data }: any) => {
        calls.matchUpdates.push(data);
        return { id: match.id, ...match, ...data };
      },
    },
    bankTransaction: {
      update: async ({ data }: any) => {
        calls.transactionUpdates.push(data);
        return { id: match.transactionId, ...data };
      },
    },
  };
  const prisma = {
    paymentMatch: {
      findFirst: async () => match,
      update: async ({ data }: any) => {
        calls.matchUpdates.push(data);
        return { id: match.id, ...match, ...data };
      },
    },
    charge: {
      findFirst: async () => charge,
      findMany: async () => suggestedCharges,
    },
    bankTransaction: {
      update: async ({ data }: any) => {
        calls.transactionUpdates.push(data);
        return { id: match.transactionId, ...data };
      },
    },
    $transaction: async (callback: any) => callback(tx),
  } as any;
  const audit = { log: async (payload: any) => calls.audits.push(payload) } as any;
  const redis = { del: async () => undefined } as any;
  const realtime = { emitBusiness: () => undefined } as any;
  const tenantCredits = { recalculateCharge: async () => ({ ...charge, status: ChargeStatus.PAID, amountPaid: charge.amountDue }) } as any;
  const service = new BankTransactionsService(prisma, {} as any, audit, redis, realtime, tenantCredits);
  return { service, calls };
}

describe('Payment match manual review', () => {
  it('confirms a NEEDS_REVIEW inbound transaction into a bank transfer payment', async () => {
    const { service, calls } = makeService();

    const result = await service.confirmMatch(user, 'match-1', { chargeId: 'charge-1', reviewNote: 'Sao ke ngan hang khop phong A-101' });

    assert.equal(calls.payments.length, 1);
    assert.equal(calls.payments[0].bankTransactionId, 'transaction-1');
    assert.equal(calls.payments[0].chargeId, 'charge-1');
    assert.equal(calls.matchUpdates[0].matchStatus, PaymentMatchStatus.MANUAL_MATCHED);
    assert.equal(calls.matchUpdates[0].reviewedBy, user.sub);
    assert.equal(calls.transactionUpdates[0].classification, TransactionClassification.RENT_MATCHED);
    assert.equal(calls.audits[0].action, 'MANUAL_CONFIRM_PAYMENT_MATCH');
    assert.equal(result.payment.id, 'payment-1');
  });

  it('rejects confirmation when the bank transaction already has a confirmed payment', async () => {
    const match = makeMatch({ transaction: makeTransaction({ payments: [{ id: 'payment-existing', status: PaymentStatus.CONFIRMED }] }) });
    const { service } = makeService({ match });

    await assert.rejects(() => service.confirmMatch(user, 'match-1', { chargeId: 'charge-1' }), BadRequestException);
  });

  it('requires a review note when the transaction amount exceeds the remaining charge amount', async () => {
    const match = makeMatch({ transaction: makeTransaction({ amount: 1200000 }) });
    const { service } = makeService({ match });

    await assert.rejects(() => service.confirmMatch(user, 'match-1', { chargeId: 'charge-1' }), BadRequestException);
  });

  it('rejects paid charges for manual matching', async () => {
    const { service } = makeService({ charge: makeCharge({ status: ChargeStatus.PAID, amountPaid: 1000000 }) });

    await assert.rejects(() => service.confirmMatch(user, 'match-1', { chargeId: 'charge-1' }), BadRequestException);
  });

  it('marks a NEEDS_REVIEW match as rejected without creating a payment', async () => {
    const match = makeMatch({ transaction: makeTransaction({ description: 'Thanh toan phong A-101 RTP-ABC123' }) });
    const { service, calls } = makeService({ match });

    const result = await service.rejectMatch(user, 'match-1', { reviewNote: 'Khong phai tien phong' });

    assert.equal(calls.payments.length, 0);
    assert.equal(result.matchStatus, PaymentMatchStatus.REJECTED);
    assert.equal(calls.transactionUpdates[0].classification, TransactionClassification.OTHER);
    assert.equal(calls.audits[0].action, 'REJECT_PAYMENT_MATCH');
  });

  it('requires a review note when rejecting without valid charge suggestions', async () => {
    const { service } = makeService();

    await assert.rejects(() => service.rejectMatch(user, 'match-1', {}), BadRequestException);
  });

  it('keeps inbound transactions without payment code in review and does not create payment automatically', async () => {
    const calls: Record<string, any[]> = { transactions: [], matches: [], payments: [], audits: [] };
    const prisma = {
      bankAccount: {
        findFirst: async () => ({ id: 'bank-account-1', businessId: user.businessId, bankCode: 'VCB', accountNumber: '1234567890', status: 'ACTIVE' }),
      },
      bankTransaction: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          calls.transactions.push(data);
          return { id: 'transaction-no-code', ...data };
        },
      },
      paymentMatch: {
        create: async ({ data }: any) => {
          calls.matches.push(data);
          return { id: 'match-no-code', ...data };
        },
      },
    } as any;
    const payments = { createBankTransferPayment: async (payload: any) => calls.payments.push(payload) } as any;
    const audit = { log: async (payload: any) => calls.audits.push(payload) } as any;
    const redis = { del: async () => undefined } as any;
    const realtime = { emitBusiness: () => undefined } as any;
    const service = new BankTransactionsService(prisma, payments, audit, redis, realtime, {} as any);

    const result = await service.receiveWebhook({
      bankCode: 'VCB',
      accountNumber: '1234567890',
      transactionRef: 'NO-CODE-1',
      amount: 1000000,
      description: 'Nguyen Van A chuyen tien',
      transactionTime: '2026-05-25T01:00:00.000Z',
      type: TransactionType.IN,
    });

    assert.equal(calls.transactions[0].classification, TransactionClassification.SUSPICIOUS);
    assert.equal(calls.matches[0].matchStatus, PaymentMatchStatus.NEEDS_REVIEW);
    assert.equal(calls.matches[0].chargeId, null);
    assert.equal(calls.payments.length, 0);
    assert.equal(result.paymentResult, null);
  });

  it('suggests matching charges from room, charge item and billing period in transfer content', async () => {
    const match = makeMatch({
      transaction: makeTransaction({
        description: 'tien rac b101 7/2026',
        amount: 50000,
      }),
    });
    const charge = makeCharge({
      id: 'garbage-charge',
      room: { id: 'room-1', roomCode: 'B-101', roomArea: { name: 'Khu B' } },
      amountDue: 50000,
      amountPaid: 0,
      chargeType: 'GARBAGE',
      items: [{ title: 'Tiền rác', chargeType: 'GARBAGE', amount: 50000 }],
      billingPeriod: { id: 'period-7-2026', month: 7, year: 2026 },
    });
    const { service } = makeService({ match, suggestedCharges: [charge] });

    const context = await service.reviewContext(user, 'match-1');

    assert.equal(context.suggestions.length, 1);
    assert.equal(context.suggestions[0].charge.id, 'garbage-charge');
    assert.ok(context.suggestions[0].reasons.includes('MATCH_ROOM_CODE'));
    assert.ok(context.suggestions[0].reasons.includes('MATCH_CHARGE_ITEM'));
    assert.ok(context.suggestions[0].reasons.includes('MATCH_BILLING_PERIOD'));
  });
});
