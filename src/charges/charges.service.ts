import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, ChargeType, NotificationAction } from '@prisma/client';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { buildTransferContent, makePaymentCode } from '../common/utils/payment-code';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class ChargesService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'charge',
      user,
      query,
      searchFields: ['title', 'paymentCode', 'transferContent'],
      filterFields: ['chargeType', 'status', 'billingPeriodId', 'roomId'],
      sortFields: ['amountDue', 'amountPaid', 'dueDate', 'status', 'createdAt'],
      include: { room: true, payerTenant: true, billingPeriod: true, bankAccount: true },
    });
  }

  async createCharge(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const paymentCode = await this.uniquePaymentCode();
    const chargeType = body.chargeType as ChargeType;
    if (chargeType === ChargeType.ROOM_RENT && !body.contractId) {
      throw new BadRequestException('ROOM_RENT charge must be linked to a contract');
    }
    if (chargeType === ChargeType.ROOM_RENT && body.contractId && body.billingPeriodId) {
      const exists = await this.prisma.charge.findFirst({
        where: { businessId, contractId: body.contractId, billingPeriodId: body.billingPeriodId, chargeType },
      });
      if (exists) throw new BadRequestException('ROOM_RENT charge already exists for this contract and billing period');
    }
    const charge = await this.prisma.charge.create({
      data: {
        businessId,
        roomId: body.roomId,
        contractId: body.contractId,
        payerTenantId: body.payerTenantId,
        billingPeriodId: body.billingPeriodId,
        bankAccountId: body.bankAccountId,
        chargeType,
        title: body.title,
        amountDue: body.amountDue,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        paymentCode,
        transferContent: buildTransferContent(chargeType, paymentCode),
        paymentLink: body.paymentLink,
      },
    });
    await this.changed(user, 'CREATE_CHARGE', charge.id, businessId);
    return charge;
  }

  async updateCharge(user: AuthUser, id: string, body: any) {
    const current = await this.get('charge', user, id);
    if (current.status === ChargeStatus.CANCELLED) throw new BadRequestException('Cannot update cancelled charge');
    delete body.paymentCode;
    delete body.transferContent;
    const updated = await super.update('charge', user, id, body);
    await this.changed(user, 'UPDATE_CHARGE', id, updated.businessId);
    return updated;
  }

  async cancel(user: AuthUser, id: string) {
    const updated = await super.update('charge', user, id, { status: ChargeStatus.CANCELLED });
    await this.changed(user, 'CANCEL_CHARGE', id, updated.businessId);
    return updated;
  }

  async qr(user: AuthUser, id: string) {
    const charge = await this.get('charge', user, id, { bankAccount: true, room: true });
    return this.renderQr(charge, user.sub);
  }

  async renderQr(charge: any, userId?: string | null) {
    if (charge.status === ChargeStatus.CANCELLED) throw new BadRequestException('Charge was cancelled');
    const remainingAmount = Math.max(Number(charge.amountDue) - Number(charge.amountPaid), 0);
    const payload = JSON.stringify({
      bankCode: charge.bankAccount.bankCode,
      accountNumber: charge.bankAccount.accountNumber,
      accountName: charge.bankAccount.accountName,
      amount: remainingAmount || Number(charge.amountDue),
      transferContent: charge.transferContent,
      paymentCode: charge.paymentCode,
    });
    const qrBase64 = await QRCode.toDataURL(payload, { margin: 1, width: 360 });
    await this.prisma.notificationLog.create({
      data: {
        businessId: charge.businessId,
        chargeId: charge.id,
        tenantId: charge.payerTenantId,
        roomId: charge.roomId,
        action: userId ? NotificationAction.DOWNLOADED_QR : NotificationAction.PUBLIC_QR_VIEWED,
        createdBy: userId ?? undefined,
      },
    });
    return { qrBase64, payload: JSON.parse(payload), transferContent: charge.transferContent, paymentCode: charge.paymentCode };
  }

  async uniquePaymentCode() {
    for (let i = 0; i < 10; i++) {
      const code = makePaymentCode();
      const exists = await this.prisma.charge.findUnique({ where: { paymentCode: code } });
      if (!exists) return code;
    }
    throw new BadRequestException('Unable to generate payment code');
  }

  private async changed(user: AuthUser, action: string, id: string, businessId: string) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'Charge', entityId: id });
  }
}
