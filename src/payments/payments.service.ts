import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class PaymentsService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
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
      include: { charge: true, room: true, tenant: true, collector: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  async recordCash(user: AuthUser, body: any) {
    const charge = await this.get('charge', user, body.chargeId);
    if (charge.status === ChargeStatus.CANCELLED) throw new BadRequestException('Cannot pay a cancelled charge');
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
    const updatedCharge = await this.recalculateCharge(charge.id);
    await this.afterPaymentChanged(user, charge.businessId, 'RECORD_CASH_PAYMENT', payment.id, { chargeId: charge.id });
    return { payment, charge: updatedCharge };
  }

  async cancelPayment(user: AuthUser, id: string) {
    const payment = await this.get('payment', user, id);
    const updated = await this.prisma.payment.update({ where: { id }, data: { status: PaymentStatus.CANCELLED } });
    const charge = await this.recalculateCharge(payment.chargeId);
    await this.afterPaymentChanged(user, payment.businessId, 'CANCEL_PAYMENT', id, { chargeId: payment.chargeId });
    return { payment: updated, charge };
  }

  async createBankTransferPayment(input: { chargeId: string; bankTransactionId: string; amount: number; paidAt: Date }) {
    const charge = await this.prisma.charge.findUnique({ where: { id: input.chargeId } });
    if (!charge) throw new BadRequestException('Charge not found');
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
    const updatedCharge = await this.recalculateCharge(charge.id);
    await this.redis.del(`dashboard:${charge.businessId}:*`);
    this.realtime.emitBusiness(charge.businessId, 'payment.changed', { payment, charge: updatedCharge });
    return { payment, charge: updatedCharge };
  }

  async recalculateCharge(chargeId: string) {
    const charge = await this.prisma.charge.findUnique({ where: { id: chargeId } });
    if (!charge || charge.status === ChargeStatus.CANCELLED) return charge;
    const aggregate = await this.prisma.payment.aggregate({
      where: { chargeId, status: PaymentStatus.CONFIRMED },
      _sum: { amount: true },
    });
    const amountPaid = Number(aggregate._sum.amount ?? 0);
    const amountDue = Number(charge.amountDue);
    const status = amountPaid === 0 ? ChargeStatus.UNPAID : amountPaid < amountDue ? ChargeStatus.PARTIAL : amountPaid === amountDue ? ChargeStatus.PAID : ChargeStatus.OVERPAID;
    return this.prisma.charge.update({ where: { id: chargeId }, data: { amountPaid, status } });
  }

  private async afterPaymentChanged(user: AuthUser, businessId: string, action: string, paymentId: string, metadata?: unknown) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'Payment', entityId: paymentId, metadata });
    this.realtime.emitBusiness(businessId, 'payment.changed', { paymentId });
  }
}
