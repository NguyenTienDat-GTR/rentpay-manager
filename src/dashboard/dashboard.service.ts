import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, ContractStatus, OccupantStatus, PaymentMethod, PaymentStatus, RoomStatus, TransactionClassification } from '@prisma/client';
import dayjs = require('dayjs');
import { AuthUser } from '../common/decorators/current-user.decorator';
import { dateRange, toMoney } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  async summary(user: AuthUser, query: any) {
    if (!user.businessId) throw new BadRequestException('Dashboard requires business user');
    const range = resolveDateRange(query);
    const cacheKey = `dashboard:${user.businessId}:${JSON.stringify(range)}`;
    const cached = await this.redis.getJson(cacheKey);
    if (cached) return cached;

    const chargeWhere = { businessId: user.businessId, ...(range ? { createdAt: range } : {}) };
    const paymentWhere = { businessId: user.businessId, status: PaymentStatus.CONFIRMED, ...(range ? { paidAt: range } : {}) };
    const effectiveContractWhere = { businessId: user.businessId, status: ContractStatus.ACTIVE, startDate: { lt: addDays(startOfLocalDay(new Date()), 1) } };
    const [rooms, representativeContracts, occupants, activeContracts, chargeAgg, paymentAgg, cashAgg, bankAgg, suspiciousCount, otherCount, recentTransactions, debtByRoom] =
      await Promise.all([
        this.prisma.room.groupBy({ by: ['status'], where: { businessId: user.businessId }, _count: true }),
        this.prisma.rentalContract.findMany({ where: effectiveContractWhere, select: { representativeTenantId: true } }),
        this.prisma.contractOccupant.count({ where: { businessId: user.businessId, status: OccupantStatus.STAYING, contract: effectiveContractWhere } }),
        this.prisma.rentalContract.count({ where: { businessId: user.businessId, status: 'ACTIVE' } }),
        this.prisma.charge.aggregate({ where: chargeWhere, _sum: { amountDue: true, amountPaid: true }, _count: true }),
        this.prisma.payment.aggregate({ where: paymentWhere, _sum: { amount: true }, _count: true }),
        this.prisma.payment.aggregate({ where: { ...paymentWhere, method: PaymentMethod.CASH }, _sum: { amount: true } }),
        this.prisma.payment.aggregate({ where: { ...paymentWhere, method: PaymentMethod.BANK_TRANSFER }, _sum: { amount: true } }),
        this.prisma.bankTransaction.count({ where: { businessId: user.businessId, classification: TransactionClassification.SUSPICIOUS } }),
        this.prisma.bankTransaction.count({ where: { businessId: user.businessId, classification: TransactionClassification.OTHER } }),
        this.prisma.bankTransaction.findMany({ where: { businessId: user.businessId }, take: 10, orderBy: { transactionTime: 'desc' } }),
        this.prisma.charge.groupBy({ by: ['roomId'], where: { businessId: user.businessId, status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] } }, _sum: { amountDue: true, amountPaid: true } }),
      ]);

    const roomCounts = Object.fromEntries(rooms.map((r) => [r.status, r._count]));
    const representativeCount = new Set(representativeContracts.map((contract) => contract.representativeTenantId)).size;
    const overdueCharges = await this.prisma.charge.findMany({
      where: { businessId: user.businessId, dueDate: { lt: new Date() }, status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] } },
      include: { room: true },
      take: 20,
    });
    const response = {
      totalRooms: rooms.reduce((sum, r) => sum + r._count, 0),
      occupiedRooms: roomCounts[RoomStatus.OCCUPIED] ?? 0,
      depositedRooms: roomCounts[RoomStatus.DEPOSITED] ?? 0,
      availableRooms: roomCounts[RoomStatus.AVAILABLE] ?? 0,
      maintenanceRooms: roomCounts[RoomStatus.MAINTENANCE] ?? 0,
      totalCurrentOccupants: representativeCount + occupants,
      activeContracts,
      totalDue: toMoney(chargeAgg._sum.amountDue),
      totalCollected: toMoney(paymentAgg._sum.amount),
      totalDebt: Math.max(toMoney(chargeAgg._sum.amountDue) - toMoney(chargeAgg._sum.amountPaid), 0),
      cashCollected: toMoney(cashAgg._sum.amount),
      bankCollected: toMoney(bankAgg._sum.amount),
      suspiciousTransactions: suspiciousCount,
      otherTransactions: otherCount,
      overdueCount: overdueCharges.length,
      overdueAmount: overdueCharges.reduce((sum, c) => sum + Math.max(toMoney(c.amountDue) - toMoney(c.amountPaid), 0), 0),
      recentTransactions,
      debtByRoom,
    };
    await this.redis.setJson(cacheKey, response, 45);
    return response;
  }
}

export function resolveDateRange(query: any) {
  if (query.fromDate || query.toDate) return dateRange(query.fromDate, query.toDate);
  const year = Number(query.year ?? dayjs().year());
  if (query.periodType === 'year') return { gte: dayjs(`${year}-01-01`).startOf('year').toDate(), lte: dayjs(`${year}-01-01`).endOf('year').toDate() };
  if (query.periodType === 'quarter') {
    const quarter = Math.max(Number(query.quarter ?? 1), 1);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    return {
      gte: dayjs(`${year}-${String(startMonth).padStart(2, '0')}-01`).startOf('month').toDate(),
      lte: dayjs(`${year}-${String(endMonth).padStart(2, '0')}-01`).endOf('month').toDate(),
    };
  }
  if (query.month || query.periodType === 'month') {
    const month = Number(query.month ?? dayjs().month() + 1);
    const base = dayjs(`${year}-${String(month).padStart(2, '0')}-01`);
    return { gte: base.startOf('month').toDate(), lte: base.endOf('month').toDate() };
  }
  return undefined;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
