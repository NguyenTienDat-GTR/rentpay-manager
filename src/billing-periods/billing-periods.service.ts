import { BadRequestException, Injectable } from '@nestjs/common';
import { BillingPeriodStatus, ChargeStatus, ChargeType, ContractStatus } from '@prisma/client';
import dayjs = require('dayjs');
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { buildTransferContent, makePaymentCode } from '../common/utils/payment-code';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class BillingPeriodsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'billingPeriod',
      user,
      query,
      searchFields: [],
      filterFields: ['status', 'year'],
      sortFields: ['year', 'month', 'status', 'createdAt'],
    });
  }

  async createPeriod(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const month = Number(body.month);
    const year = Number(body.year);
    const startDate = body.startDate ? new Date(body.startDate) : dayjs(`${year}-${month}-01`).startOf('month').toDate();
    const endDate = body.endDate ? new Date(body.endDate) : dayjs(startDate).endOf('month').toDate();
    const period = await this.prisma.billingPeriod.create({ data: { businessId, month, year, startDate, endDate, status: body.status ?? BillingPeriodStatus.OPEN } });
    await this.audit.log({ businessId, userId: user.sub, action: 'CREATE_BILLING_PERIOD', entity: 'BillingPeriod', entityId: period.id });
    return period;
  }

  async setStatus(user: AuthUser, id: string, status: BillingPeriodStatus) {
    const period = await this.update('billingPeriod', user, id, { status });
    await this.redis.del(`dashboard:${period.businessId}:*`);
    await this.audit.log({ businessId: period.businessId, userId: user.sub, action: `${status}_BILLING_PERIOD`, entity: 'BillingPeriod', entityId: id });
    return period;
  }

  async generateMonthlyRentCharges(user: AuthUser, id: string) {
    const period = await this.get('billingPeriod', user, id);
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
