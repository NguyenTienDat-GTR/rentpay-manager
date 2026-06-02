import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BillingPeriodsService } from '../billing-periods/billing-periods.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';
import { TenantCreditsService } from '../tenant-credits/tenant-credits.service';

@Injectable()
export class PaymentsService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly tenantCredits: TenantCreditsService,
    private readonly billingPeriods: BillingPeriodsService,
  ) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'payment',
      user,
      query,
      searchFields: ['note'],
      filterFields: ['method', 'status', 'collectedBy'],
      sortFields: ['amount', 'paidAt', 'method', 'createdAt'],
      include: { charge: true, room: { include: { roomArea: true } }, tenant: true, collector: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  async recordCash(user: AuthUser, body: any) {
    const charge = await this.get('charge', user, body.chargeId);
    if (charge.status === ChargeStatus.CANCELLED) throw new BadRequestException('Cannot pay a cancelled charge');
    if ([ChargeStatus.PAID, ChargeStatus.OVERPAID].includes(charge.status)) throw new BadRequestException('Charge is already paid');
    const payment = await this.prisma.payment.create({
      data: {
        businessId: charge.businessId,
        chargeId: charge.id,
        roomId: charge.roomId,
        contractId: charge.contractId,
        tenantId: charge.payerTenantId,
        method: PaymentMethod.CASH,
        amount: body.amount,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        collectedBy: user.sub,
        note: body.note,
      },
    });
    const updatedCharge = await this.tenantCredits.recalculateCharge(charge.id);
    await this.billingPeriods.autoLockIfNoUnpaidCharges(charge.billingPeriodId);
    await this.afterPaymentChanged(user, charge.businessId, 'RECORD_CASH_PAYMENT', payment.id, { chargeId: charge.id });
    return { payment, charge: updatedCharge };
  }

  async cancelPayment(user: AuthUser, id: string) {
    const payment = await this.get('payment', user, id);
    await this.tenantCredits.assertPaymentCanBeCancelled(id);
    const sourceChargeIds = await this.tenantCredits.voidCreditPaymentLedgers(id);
    const updated = await this.prisma.payment.update({ where: { id }, data: { status: PaymentStatus.CANCELLED } });
    for (const sourceChargeId of sourceChargeIds) await this.tenantCredits.recalculateCharge(sourceChargeId);
    const charge = await this.tenantCredits.recalculateCharge(payment.chargeId);
    await this.billingPeriods.autoLockIfNoUnpaidCharges(charge?.billingPeriodId);
    await this.afterPaymentChanged(user, payment.businessId, 'CANCEL_PAYMENT', id, { chargeId: payment.chargeId });
    return { payment: updated, charge };
  }

  async createBankTransferPayment(input: { chargeId: string; bankTransactionId: string; amount: number; paidAt: Date }) {
    const charge = await this.prisma.charge.findUnique({ where: { id: input.chargeId } });
    if (!charge) throw new BadRequestException('Charge not found');
    if ([ChargeStatus.PAID, ChargeStatus.OVERPAID, ChargeStatus.CANCELLED].some((status) => status === charge.status)) throw new BadRequestException('Charge cannot receive more payments');
    const payment = await this.prisma.payment.create({
      data: {
        businessId: charge.businessId,
        chargeId: charge.id,
        roomId: charge.roomId,
        contractId: charge.contractId,
        tenantId: charge.payerTenantId,
        method: PaymentMethod.BANK_TRANSFER,
        amount: input.amount,
        paidAt: input.paidAt,
        bankTransactionId: input.bankTransactionId,
      },
    });
    const updatedCharge = await this.tenantCredits.recalculateCharge(charge.id);
    await this.billingPeriods.autoLockIfNoUnpaidCharges(charge.billingPeriodId);
    await this.redis.del(`dashboard:${charge.businessId}:*`);
    this.realtime.emitBusiness(charge.businessId, 'payment.changed', { payment, charge: updatedCharge });
    return { payment, charge: updatedCharge };
  }

  private async afterPaymentChanged(user: AuthUser, businessId: string, action: string, paymentId: string, metadata?: unknown) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'Payment', entityId: paymentId, metadata });
    this.realtime.emitBusiness(businessId, 'payment.changed', { paymentId });
  }
}
