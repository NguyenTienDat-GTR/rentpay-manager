import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BillingPeriodStatus, ChargeStatus, ChargeType, ContractStatus } from '@prisma/client';
import dayjs = require('dayjs');
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { buildTransferContent, makePaymentCode } from '../common/utils/payment-code';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const BILLING_PERIOD_INCLUDE = {
  creator: {
    select: {
      id: true,
      fullName: true,
      phone: true,
    },
  },
} as const;

@Injectable()
export class BillingPeriodsService extends BaseCrudService implements OnModuleInit, OnModuleDestroy {
  private autoCloseTimer?: NodeJS.Timeout;

  constructor(prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {
    super(prisma);
  }

  onModuleInit() {
    void this.closeExpiredPeriods().catch(() => undefined);
    this.autoCloseTimer = setInterval(() => {
      void this.closeExpiredPeriods().catch(() => undefined);
    }, 60_000);
    this.autoCloseTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.autoCloseTimer) clearInterval(this.autoCloseTimer);
  }

  async list(user: AuthUser, query: any) {
    await this.syncExpiredPeriods(user, typeof query.businessId === 'string' ? query.businessId : undefined);
    return super.listItems({
      model: 'billingPeriod',
      user,
      query,
      searchFields: [],
      filterFields: ['status', 'year'],
      sortFields: ['year', 'month', 'status', 'createdAt'],
      include: BILLING_PERIOD_INCLUDE,
    });
  }

  async getPeriod(user: AuthUser, id: string) {
    return this.requirePeriod(user, id);
  }

  async createPeriod(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    await this.closeExpiredPeriods(businessId);

    const now = dayjs();
    const month = Number(body.month ?? now.month() + 1);
    const year = Number(body.year ?? now.year());
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new BadRequestException('Billing period month must be between 1 and 12');
    if (!Number.isInteger(year) || year < 2000) throw new BadRequestException('Billing period year is invalid');

    const startDate = body.startDate ? dayjs(body.startDate) : now.startOf('day');
    const endDate = body.endDate ? dayjs(body.endDate) : startDate.add(1, 'month');
    if (!startDate.isValid()) throw new BadRequestException('Billing period start date is invalid');
    if (!endDate.isValid()) throw new BadRequestException('Billing period end date is invalid');
    if (endDate.startOf('day').isBefore(startDate.startOf('day'))) {
      throw new BadRequestException('Billing period end date must be on or after start date');
    }

    const status = this.normalizeCreateStatus(body.status);
    const period = await this.prisma.billingPeriod.create({
      data: {
        businessId,
        createdBy: user.sub,
        month,
        year,
        startDate: startDate.startOf('day').toDate(),
        endDate: endDate.startOf('day').toDate(),
        status,
      },
      include: BILLING_PERIOD_INCLUDE,
    });
    await this.audit.log({ businessId, userId: user.sub, action: 'CREATE_BILLING_PERIOD', entity: 'BillingPeriod', entityId: period.id });
    return period;
  }

  async updatePeriod(user: AuthUser, id: string, body: any) {
    const period = await this.requirePeriod(user, id);
    if (!this.canEditPeriod(period.status)) throw new BadRequestException('Only open or locked billing periods can be edited');
    if (!body.endDate) throw new BadRequestException('Billing period end date is required');

    const endDate = dayjs(body.endDate);
    if (!endDate.isValid()) throw new BadRequestException('Billing period end date is invalid');
    if (endDate.startOf('day').isBefore(dayjs(period.startDate).startOf('day'))) {
      throw new BadRequestException('Billing period end date must be on or after start date');
    }

    const updated = await this.prisma.billingPeriod.update({
      where: { id },
      data: { endDate: endDate.startOf('day').toDate() },
      include: BILLING_PERIOD_INCLUDE,
    });
    await this.redis.del(`dashboard:${updated.businessId}:*`);
    await this.audit.log({
      businessId: updated.businessId,
      userId: user.sub,
      action: 'UPDATE_BILLING_PERIOD',
      entity: 'BillingPeriod',
      entityId: id,
      metadata: { endDate: updated.endDate },
    });
    return this.closeExpiredPeriodIfNeeded(updated);
  }

  async setStatus(user: AuthUser, id: string, status: BillingPeriodStatus) {
    const period = await this.requirePeriod(user, id);
    this.assertStatusTransition(period.status, status);
    if (period.status === status) return period;

    const updated = await this.prisma.billingPeriod.update({
      where: { id },
      data: { status },
      include: BILLING_PERIOD_INCLUDE,
    });
    await this.redis.del(`dashboard:${updated.businessId}:*`);
    await this.audit.log({ businessId: updated.businessId, userId: user.sub, action: `${status}_BILLING_PERIOD`, entity: 'BillingPeriod', entityId: id });
    return updated;
  }

  async generateMonthlyRentCharges(user: AuthUser, id: string) {
    const period = await this.requirePeriod(user, id);
    if (period.status !== BillingPeriodStatus.OPEN) throw new BadRequestException('Billing period must be open');
    const bankAccount = await this.prisma.bankAccount.findFirst({ where: { businessId: period.businessId, isDefault: true, status: 'ACTIVE' } });
    if (!bankAccount) throw new BadRequestException('Default bank account is required');
    const contracts = await this.prisma.rentalContract.findMany({
      where: { businessId: period.businessId, status: ContractStatus.ACTIVE },
      include: { room: { include: { roomArea: true } }, representativeTenant: true },
    });

    const created: any[] = [];
    for (const contract of contracts) {
      const exists = await this.prisma.charge.findFirst({
        where: {
          contractId: contract.id,
          billingPeriodId: id,
          status: { not: ChargeStatus.CANCELLED },
          OR: [{ chargeType: ChargeType.ROOM_RENT }, { items: { some: { chargeType: ChargeType.ROOM_RENT } } }],
        },
      });
      if (exists) continue;
      const hasPreviousRoomRent = await this.prisma.charge.findFirst({ where: { contractId: contract.id, chargeType: ChargeType.ROOM_RENT } });
      const paidDepositAmount = hasPreviousRoomRent ? 0 : await this.getPaidDepositAmount(contract.id);
      const amountDue = Math.max(Number(contract.rentAmount) - paidDepositAmount, 0);
      const paymentCode = await this.uniquePaymentCode();
      created.push(
        await this.prisma.charge.create({
          data: {
            businessId: period.businessId,
            roomId: contract.roomId,
            contractId: contract.id,
            payerTenantId: contract.representativeTenantId,
            billingPeriodId: id,
            bankAccountId: bankAccount.id,
            chargeType: ChargeType.ROOM_RENT,
            title: paidDepositAmount > 0 ? `Tien phong thang ${period.month}/${period.year} sau khi tru coc` : `Tien phong thang ${period.month}/${period.year}`,
            amountDue,
            dueDate: dayjs(period.startDate).date(contract.paymentDueDay).toDate(),
            paymentCode,
            transferContent: buildTransferContent(ChargeType.ROOM_RENT, paymentCode),
            status: amountDue === 0 ? ChargeStatus.PAID : ChargeStatus.UNPAID,
            items: {
              create: {
                businessId: period.businessId,
                chargeType: ChargeType.ROOM_RENT,
                title: 'Tien phong',
                amount: amountDue,
                note: paidDepositAmount > 0 ? `Da tru tien coc da thu ${paidDepositAmount}` : null,
              },
            },
          },
          include: { items: true },
        }),
      );
    }
    await this.redis.del(`dashboard:${period.businessId}:*`);
    await this.audit.log({ businessId: period.businessId, userId: user.sub, action: 'GENERATE_MONTHLY_RENT_CHARGES', entity: 'BillingPeriod', entityId: id, metadata: { count: created.length } });
    return { createdCount: created.length, items: created };
  }

  private normalizeCreateStatus(status: unknown) {
    if (status == null || status === '') return BillingPeriodStatus.OPEN;
    if (status !== BillingPeriodStatus.OPEN && status !== BillingPeriodStatus.LOCKED) {
      throw new BadRequestException('Billing period status must be OPEN or LOCKED when creating a period');
    }
    return status;
  }

  private canEditPeriod(status: BillingPeriodStatus) {
    return status === BillingPeriodStatus.OPEN || status === BillingPeriodStatus.LOCKED;
  }

  private assertStatusTransition(currentStatus: BillingPeriodStatus, nextStatus: BillingPeriodStatus) {
    if (!Object.values(BillingPeriodStatus).includes(nextStatus)) {
      throw new BadRequestException('Billing period status is invalid');
    }
    const allowedTransitions: Record<BillingPeriodStatus, BillingPeriodStatus[]> = {
      [BillingPeriodStatus.OPEN]: [BillingPeriodStatus.OPEN, BillingPeriodStatus.LOCKED, BillingPeriodStatus.CLOSED],
      [BillingPeriodStatus.LOCKED]: [BillingPeriodStatus.OPEN, BillingPeriodStatus.LOCKED, BillingPeriodStatus.CLOSED],
      [BillingPeriodStatus.CLOSED]: [BillingPeriodStatus.CLOSED],
    };
    if (!allowedTransitions[currentStatus]?.includes(nextStatus)) {
      throw new BadRequestException('Closed billing periods cannot be reopened');
    }
  }

  private async requirePeriod(user: AuthUser, id: string) {
    const period = await this.get('billingPeriod', user, id, BILLING_PERIOD_INCLUDE);
    return this.closeExpiredPeriodIfNeeded(period);
  }

  private async closeExpiredPeriodIfNeeded(period: any) {
    if (!this.shouldAutoClose(period)) return period;
    const closed = await this.prisma.billingPeriod.update({
      where: { id: period.id },
      data: { status: BillingPeriodStatus.CLOSED },
      include: BILLING_PERIOD_INCLUDE,
    });
    await this.redis.del(`dashboard:${closed.businessId}:*`);
    return closed;
  }

  private shouldAutoClose(period: { endDate: Date; status: BillingPeriodStatus }) {
    return (
      (period.status === BillingPeriodStatus.OPEN || period.status === BillingPeriodStatus.LOCKED) &&
      dayjs().startOf('day').valueOf() >= dayjs(period.endDate).startOf('day').valueOf()
    );
  }

  private async syncExpiredPeriods(user: AuthUser, requestedBusinessId?: string) {
    const businessId = user.role === 'SUPER_ADMIN' ? requestedBusinessId : user.businessId ?? undefined;
    await this.closeExpiredPeriods(businessId);
  }

  private async closeExpiredPeriods(businessId?: string) {
    const where: Record<string, unknown> = {
      status: { in: [BillingPeriodStatus.OPEN, BillingPeriodStatus.LOCKED] },
      endDate: { lt: dayjs().add(1, 'day').startOf('day').toDate() },
    };
    if (businessId) where.businessId = businessId;

    const expiredPeriods = await this.prisma.billingPeriod.findMany({
      where,
      select: { id: true, businessId: true },
    });
    if (!expiredPeriods.length) return;

    await this.prisma.billingPeriod.updateMany({
      where: { id: { in: expiredPeriods.map((period) => period.id) } },
      data: { status: BillingPeriodStatus.CLOSED },
    });
    await Promise.all(
      Array.from(new Set(expiredPeriods.map((period) => period.businessId))).map((itemBusinessId) => this.redis.del(`dashboard:${itemBusinessId}:*`)),
    );
  }

  private async uniquePaymentCode() {
    for (let i = 0; i < 10; i++) {
      const code = makePaymentCode();
      const exists = await this.prisma.charge.findUnique({ where: { paymentCode: code } });
      if (!exists) return code;
    }
    throw new BadRequestException('Unable to generate payment code');
  }

  private async getPaidDepositAmount(contractId: string) {
    const depositCharges = await this.prisma.charge.findMany({
      where: { contractId, chargeType: ChargeType.DEPOSIT, status: { not: ChargeStatus.CANCELLED } },
      select: { amountPaid: true },
    });
    return depositCharges.reduce((sum, charge) => sum + Number(charge.amountPaid ?? 0), 0);
  }
}
