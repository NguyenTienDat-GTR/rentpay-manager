import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantCreditActivityStatus } from '@prisma/client';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { scopedWhere } from '../common/utils/business-scope';
import { contains, dateRange, orderBy, pagination } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantCreditActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser, query: any) {
    const { page, take, skip } = pagination(query);
    const where = scopedWhere(user, activityFilters(query));
    const [items, total] = await Promise.all([
      this.prisma.tenantCreditActivity.findMany({
        where,
        include: tenantCreditActivityInclude(),
        skip,
        take,
        orderBy: orderBy(query, ['amount', 'type', 'status', 'createdAt', 'transferredAt', 'bankMatchedAt']),
      }),
      this.prisma.tenantCreditActivity.count({ where }),
    ]);
    return { items, meta: { page, take, total, pages: Math.ceil(total / take) } };
  }

  async get(user: AuthUser, id: string) {
    const activity = await this.prisma.tenantCreditActivity.findFirst({
      where: scopedWhere(user, { id }),
      include: tenantCreditActivityInclude(),
    });
    if (!activity) throw new NotFoundException('Tenant credit activity not found');
    return activity;
  }
}

export function tenantCreditActivityInclude() {
  return {
    sourceCharge: { include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true } },
    targetCharge: { include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true } },
    tenant: true,
    contract: true,
    room: { include: { roomArea: true } },
    creator: { select: { id: true, fullName: true, phone: true, role: true } },
    ownerBankAccount: true,
    bankTransaction: true,
    ledgers: {
      include: {
        sourcePayment: true,
        targetPayment: true,
        bankTransaction: true,
      },
      orderBy: { createdAt: 'asc' as const },
    },
  };
}

function activityFilters(query: any) {
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  for (const field of ['type', 'sourceChargeId', 'tenantId', 'contractId', 'roomId', 'refundMethod', 'status']) {
    if (query[field] !== undefined && query[field] !== '') where[field] = query[field];
  }
  const bankMatched = query.bankMatched ?? normalizeBankMatchedState(query.bankMatchedState);
  if (bankMatched === 'true' || bankMatched === true) where.bankTransactionId = { not: null };
  if (bankMatched === 'false' || bankMatched === false) where.bankTransactionId = null;
  if (query.bankMatchedState === 'BANK_NOT_REQUIRED') and.push({ OR: [{ refundMethod: { not: 'BANK_TRANSFER' } }, { refundMethod: null }] });
  const createdAt = dateRange(query.fromDate ?? query.createdAtFrom, query.toDate ?? query.createdAtTo);
  if (createdAt) where.createdAt = createdAt;
  if (query.search) {
    const search = contains(query.search);
    and.push({ OR: [
      { activityCode: search },
      { recipientBankName: search },
      { recipientAccountNumber: search },
      { recipientAccountName: search },
      { transferContent: search },
      { note: search },
      { ownerBankAccount: { is: { bankName: search } } },
      { ownerBankAccount: { is: { accountNumber: search } } },
      { ownerBankAccount: { is: { accountName: search } } },
      { room: { roomCode: search } },
      { tenant: { is: { fullName: search } } },
      { tenant: { is: { phone: search } } },
      { sourceCharge: { is: { paymentCode: search } } },
      { sourceCharge: { is: { title: search } } },
      { targetCharge: { is: { paymentCode: search } } },
      { targetCharge: { is: { title: search } } },
    ] });
  }
  if (and.length) where.AND = and;
  if (!where.status) where.status = { not: TenantCreditActivityStatus.VOIDED };
  return where;
}

function normalizeBankMatchedState(value: unknown) {
  if (value === 'BANK_MATCHED' || value === 'MATCHED') return 'true';
  if (value === 'BANK_UNMATCHED' || value === 'UNMATCHED') return 'false';
  return undefined;
}
