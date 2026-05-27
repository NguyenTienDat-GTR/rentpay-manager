import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BankAccountStatus,
  ChargeType,
  ChargeStatus,
  ContractStatus,
  CreditLedgerStatus,
  CreditLedgerType,
  OccupantStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  RefundMethod,
  RoomStatus,
  TenantStatus,
  TenantCreditActivityStatus,
  TenantCreditActivityType,
  TransactionType,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BillingPeriodsService } from '../billing-periods/billing-periods.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { scopedWhere } from '../common/utils/business-scope';
import { orderBy, pagination } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';

type DbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class TenantCreditsService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly billingPeriods: BillingPeriodsService,
  ) {
    super(prisma);
  }

  async list(user: AuthUser, query: any) {
    const { page, take, skip } = pagination(query);
    const where = scopedWhere(user, pickFilters(query, ['tenantId', 'contractId', 'roomId', 'sourceChargeId', 'status', 'type']));
    const [items, total] = await Promise.all([
      this.prisma.creditLedger.findMany({
        where,
        include: creditLedgerInclude(),
        skip,
        take,
        orderBy: orderBy(query, ['amount', 'type', 'status', 'createdAt']),
      }),
      this.prisma.creditLedger.count({ where }),
    ]);
    return { items, meta: { page, take, total, pages: Math.ceil(total / take) } };
  }

  async summary(user: AuthUser, query: any) {
    const where = scopedWhere(user, {
      ...pickFilters(query, ['tenantId', 'contractId', 'roomId', 'sourceChargeId']),
      status: CreditLedgerStatus.POSTED,
    });
    const ledgers = await this.prisma.creditLedger.findMany({ where, select: { type: true, amount: true } });
    return summarizeLedgers(ledgers);
  }

  async apply(user: AuthUser, body: any) {
    const sourceChargeId = requiredText(body.sourceChargeId, 'sourceChargeId is required');
    const targetChargeId = requiredText(body.targetChargeId, 'targetChargeId is required');
    if (sourceChargeId === targetChargeId) throw new BadRequestException('Cannot apply credit to the same charge');

    const result = await this.prisma.$transaction(async (tx) => {
      const sourceCharge = await this.findChargeForUser(tx, user, sourceChargeId);
      const targetCharge = await this.findChargeForUser(tx, user, targetChargeId);
      if (sourceCharge.businessId !== targetCharge.businessId) throw new BadRequestException('Charges must belong to the same business');
      if (!([ChargeStatus.UNPAID, ChargeStatus.PARTIAL] as ChargeStatus[]).includes(targetCharge.status)) {
        throw new BadRequestException('Target charge must be UNPAID or PARTIAL');
      }

      const balance = await this.creditBalance(tx, sourceCharge.id);
      if (balance <= 0) throw new BadRequestException('Source charge has no available credit');
      const remaining = remainingAmount(targetCharge);
      if (remaining <= 0) throw new BadRequestException('Target charge has no remaining amount');
      const amount = normalizePositiveAmount(body.amount ?? Math.min(balance, remaining), 'amount');
      const applyNote = optionalText(body.note) ?? `Cấn trừ ${amount} vào khoản thu ${targetCharge.paymentCode ?? targetCharge.id}`;
      if (amount > balance) throw new BadRequestException('Apply amount exceeds available credit balance');
      if (amount > remaining) throw new BadRequestException('Apply amount exceeds target charge remaining amount');

      const payment = await tx.payment.create({
        data: {
          businessId: targetCharge.businessId,
          chargeId: targetCharge.id,
          roomId: targetCharge.roomId,
          contractId: targetCharge.contractId,
          tenantId: targetCharge.payerTenantId,
          method: PaymentMethod.CREDIT,
          amount,
          paidAt: new Date(),
          collectedBy: user.sub,
          note: applyNote,
        },
      });

      const activity = await tx.tenantCreditActivity.create({
        data: {
          activityCode: makeActivityCode(TenantCreditActivityType.APPLY_TO_CHARGE),
          businessId: sourceCharge.businessId,
          tenantId: sourceCharge.payerTenantId,
          contractId: sourceCharge.contractId,
          roomId: sourceCharge.roomId,
          sourceChargeId: sourceCharge.id,
          targetChargeId: targetCharge.id,
          type: TenantCreditActivityType.APPLY_TO_CHARGE,
          status: TenantCreditActivityStatus.POSTED,
          amount,
          note: applyNote,
          createdBy: user.sub,
        },
      });
      const allocations = await this.allocateCredit(tx, sourceCharge.id, amount);
      const ledgerData = allocations.map((allocation) => ({
        activityId: activity.id,
        businessId: sourceCharge.businessId,
        tenantId: sourceCharge.payerTenantId,
        contractId: sourceCharge.contractId,
        roomId: sourceCharge.roomId,
        sourceChargeId: sourceCharge.id,
        targetChargeId: targetCharge.id,
        sourcePaymentId: allocation.sourcePaymentId,
        targetPaymentId: payment.id,
        type: CreditLedgerType.APPLY_TO_CHARGE,
        amount: -allocation.amount,
        note: applyNote,
      }));
      await tx.creditLedger.createMany({ data: ledgerData });
      const ledgers = await tx.creditLedger.findMany({ where: { activityId: activity.id }, include: creditLedgerInclude(), orderBy: { createdAt: 'asc' } });
      const fullActivity = await tx.tenantCreditActivity.findUnique({ where: { id: activity.id }, include: tenantCreditActivityInclude() });

      const updatedTargetCharge = await this.recalculateChargeWithClient(tx, targetCharge.id);
      const updatedSourceCharge = await this.recalculateChargeWithClient(tx, sourceCharge.id);
      return { activity: fullActivity, payment, ledgers, sourceCharge: updatedSourceCharge, targetCharge: updatedTargetCharge, businessId: sourceCharge.businessId };
    });

    await this.afterCreditChanged(user, result.businessId, 'APPLY_TENANT_CREDIT', sourceChargeId, {
      targetChargeId,
      amount: body.amount,
    });
    await this.billingPeriods.autoLockIfNoUnpaidCharges(result.targetCharge?.billingPeriodId);
    return result;
  }

  async refund(user: AuthUser, body: any) {
    const sourceChargeId = requiredText(body.sourceChargeId, 'sourceChargeId is required');
    const amount = normalizePositiveAmount(body.amount, 'amount');
    const refundMethod = normalizeRefundMethod(body.refundMethod);
    const transferContent = optionalText(body.transferContent);
    const recipientAccountName = requiredText(body.recipientAccountName, 'recipientAccountName is required for refund');
    if (!body.transferredAt) throw new BadRequestException('transferredAt is required for refund');
    let ownerBankAccountId: string | undefined;
    if (refundMethod === RefundMethod.BANK_TRANSFER) {
      ownerBankAccountId = requiredText(body.ownerBankAccountId, 'ownerBankAccountId is required for bank transfer refund');
      requiredText(body.recipientBankName, 'recipientBankName is required for bank transfer refund');
      requiredText(body.recipientAccountNumber, 'recipientAccountNumber is required for bank transfer refund');
      requiredText(body.transferContent, 'transferContent is required for bank transfer refund');
    } else {
      requiredText(body.transferContent, 'transferContent is required for refund');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const sourceCharge = await this.findChargeForUser(tx, user, sourceChargeId);
      const balance = await this.creditBalance(tx, sourceCharge.id);
      if (amount > balance) throw new BadRequestException('Refund amount exceeds available credit balance');
      const ownerBankAccount =
        refundMethod === RefundMethod.BANK_TRANSFER ? await this.findOwnerBankAccount(tx, sourceCharge.businessId, ownerBankAccountId!) : null;
      const bankTransaction =
        refundMethod === RefundMethod.BANK_TRANSFER && transferContent
          ? await this.findMatchingOutboundTransaction(tx, sourceCharge.businessId, amount, transferContent, ownerBankAccount?.id)
          : null;

      const activity = await tx.tenantCreditActivity.create({
        data: {
          activityCode: makeActivityCode(TenantCreditActivityType.REFUND),
          businessId: sourceCharge.businessId,
          tenantId: sourceCharge.payerTenantId,
          contractId: sourceCharge.contractId,
          roomId: sourceCharge.roomId,
          sourceChargeId: sourceCharge.id,
          ownerBankAccountId: ownerBankAccount?.id,
          bankTransactionId: bankTransaction?.id,
          type: TenantCreditActivityType.REFUND,
          status: TenantCreditActivityStatus.POSTED,
          amount,
          refundMethod,
          recipientBankName: optionalText(body.recipientBankName),
          recipientAccountNumber: optionalText(body.recipientAccountNumber),
          recipientAccountName,
          transferContent,
          transferredAt: body.transferredAt ? new Date(body.transferredAt) : null,
          bankMatchedAt: bankTransaction ? new Date() : null,
          note: body.note,
          createdBy: user.sub,
        },
      });
      const allocations = await this.allocateCredit(tx, sourceCharge.id, amount);
      const ledgerData = allocations.map((allocation) => ({
        activityId: activity.id,
        businessId: sourceCharge.businessId,
        tenantId: sourceCharge.payerTenantId,
        contractId: sourceCharge.contractId,
        roomId: sourceCharge.roomId,
        sourceChargeId: sourceCharge.id,
        sourcePaymentId: allocation.sourcePaymentId,
        bankTransactionId: bankTransaction?.id,
        type: CreditLedgerType.REFUND,
        amount: -allocation.amount,
        refundMethod,
        recipientBankName: optionalText(body.recipientBankName),
        recipientAccountNumber: optionalText(body.recipientAccountNumber),
        recipientAccountName,
        transferContent,
        transferredAt: body.transferredAt ? new Date(body.transferredAt) : null,
        bankMatchedAt: bankTransaction ? new Date() : null,
        note: body.note,
      }));
      await tx.creditLedger.createMany({ data: ledgerData });
      const ledgers = await tx.creditLedger.findMany({ where: { activityId: activity.id }, include: creditLedgerInclude(), orderBy: { createdAt: 'asc' } });
      const fullActivity = await tx.tenantCreditActivity.findUnique({ where: { id: activity.id }, include: tenantCreditActivityInclude() });
      const updatedSourceCharge = await this.recalculateChargeWithClient(tx, sourceCharge.id);
      return { activity: fullActivity, ledgers, sourceCharge: updatedSourceCharge, bankTransaction, businessId: sourceCharge.businessId };
    });

    await this.afterCreditChanged(user, result.businessId, 'REFUND_TENANT_CREDIT', sourceChargeId, { amount, refundMethod });
    return result;
  }

  async recalculateCharge(chargeId: string) {
    return this.recalculateChargeWithClient(this.prisma, chargeId);
  }

  async assertPaymentCanBeCancelled(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('payment not found');
    if (payment.method === PaymentMethod.CREDIT) return;
    const used = await this.usedCreditFromPayment(this.prisma, paymentId);
    if (used > 0) {
      throw new BadRequestException('Cannot cancel this payment because its overpayment credit has already been applied or refunded');
    }
  }

  async voidCreditPaymentLedgers(paymentId: string) {
    const ledgers = await this.prisma.creditLedger.findMany({
      where: { targetPaymentId: paymentId, type: CreditLedgerType.APPLY_TO_CHARGE, status: CreditLedgerStatus.POSTED },
      select: { sourceChargeId: true, activityId: true },
    });
    if (!ledgers.length) return [];
    const activityIds = [...new Set(ledgers.map((ledger) => ledger.activityId).filter(Boolean) as string[])];
    await this.prisma.creditLedger.updateMany({
      where: { targetPaymentId: paymentId, type: CreditLedgerType.APPLY_TO_CHARGE, status: CreditLedgerStatus.POSTED },
      data: { status: CreditLedgerStatus.VOIDED },
    });
    if (activityIds.length) {
      await this.prisma.tenantCreditActivity.updateMany({
        where: { id: { in: activityIds }, type: TenantCreditActivityType.APPLY_TO_CHARGE },
        data: { status: TenantCreditActivityStatus.VOIDED },
      });
    }
    return [...new Set(ledgers.map((ledger) => ledger.sourceChargeId).filter(Boolean) as string[])];
  }

  async autoLinkOutboundRefund(transactionId: string) {
    const transaction = await this.prisma.bankTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.type !== TransactionType.OUT) return { linked: 0 };
    const description = transaction.description.toLowerCase();
    const activities = await this.prisma.tenantCreditActivity.findMany({
      where: {
        businessId: transaction.businessId,
        type: TenantCreditActivityType.REFUND,
        status: TenantCreditActivityStatus.POSTED,
        refundMethod: RefundMethod.BANK_TRANSFER,
        bankTransactionId: null,
        transferContent: { not: null },
        amount: Number(transaction.amount),
        OR: [{ ownerBankAccountId: null }, { ownerBankAccountId: transaction.bankAccountId }],
      },
      include: { ledgers: { select: { id: true } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const activity of activities) {
      const content = activity.transferContent?.trim();
      if (!content || !description.includes(content.toLowerCase())) continue;
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.tenantCreditActivity.update({
          where: { id: activity.id },
          data: { bankTransactionId: transaction.id, bankMatchedAt: now },
        });
        await tx.creditLedger.updateMany({
          where: { activityId: activity.id, status: CreditLedgerStatus.POSTED },
          data: { bankTransactionId: transaction.id, bankMatchedAt: now },
        });
      });
      await this.redis.del(`dashboard:${transaction.businessId}:*`);
      this.realtime.emitBusiness(transaction.businessId, 'tenant-credit.changed', { entityId: activity.id, action: 'AUTO_MATCH_REFUND_TRANSACTION' });
      return { linked: activity.ledgers.length, activityId: activity.id };
    }
    const ledgers = await this.prisma.creditLedger.findMany({
      where: {
        businessId: transaction.businessId,
        type: CreditLedgerType.REFUND,
        status: CreditLedgerStatus.POSTED,
        refundMethod: RefundMethod.BANK_TRANSFER,
        bankTransactionId: null,
        transferContent: { not: null },
      },
    });
    const groups = new Map<string, typeof ledgers>();
    for (const ledger of ledgers) {
      const content = ledger.transferContent?.trim();
      if (!content || !description.includes(content.toLowerCase())) continue;
      groups.set(content, [...(groups.get(content) ?? []), ledger]);
    }
    for (const group of groups.values()) {
      const total = roundMoney(group.reduce((sum, ledger) => sum + Math.abs(Number(ledger.amount)), 0));
      if (sameMoney(total, Number(transaction.amount))) {
        const ids = group.map((ledger) => ledger.id);
        const activityIds = [...new Set(group.map((ledger) => ledger.activityId).filter(Boolean) as string[])];
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          await tx.creditLedger.updateMany({ where: { id: { in: ids } }, data: { bankTransactionId: transaction.id, bankMatchedAt: now } });
          if (activityIds.length) {
            await tx.tenantCreditActivity.updateMany({
              where: { id: { in: activityIds } },
              data: { bankTransactionId: transaction.id, bankMatchedAt: now },
            });
          }
        });
        await this.redis.del(`dashboard:${transaction.businessId}:*`);
        this.realtime.emitBusiness(transaction.businessId, 'tenant-credit.changed', { entityId: activityIds[0] ?? ids[0], action: 'AUTO_MATCH_REFUND_TRANSACTION' });
        return { linked: ids.length };
      }
    }
    return { linked: 0 };
  }

  async enrichCharge<T extends Record<string, any>>(charge: T | null) {
    if (!charge) return charge;
    const [summary] = await this.enrichCharges([charge]);
    return summary as T & CreditFields;
  }

  async enrichCharges<T extends Record<string, any>>(charges: T[]) {
    if (!charges.length) return charges as Array<T & CreditFields>;
    const ids = charges.map((charge) => charge.id);
    const ledgers = await this.prisma.creditLedger.findMany({
      where: { sourceChargeId: { in: ids }, status: CreditLedgerStatus.POSTED },
      select: { sourceChargeId: true, type: true, amount: true },
    });
    const byCharge = new Map<string, CreditFields>();
    for (const charge of charges) byCharge.set(charge.id, emptyCreditFields(charge));
    for (const ledger of ledgers) {
      if (!ledger.sourceChargeId) continue;
      const fields = byCharge.get(ledger.sourceChargeId);
      if (!fields) continue;
      const amount = Number(ledger.amount);
      fields.creditBalance = roundMoney(fields.creditBalance + amount);
      if (ledger.type === CreditLedgerType.OVERPAYMENT) fields.overpaidAmount = roundMoney(fields.overpaidAmount + amount);
    }
    return charges.map((charge) => ({ ...charge, ...byCharge.get(charge.id), remainingAmount: remainingAmount(charge) }));
  }

  private async recalculateChargeWithClient(client: DbClient, chargeId: string) {
    const charge = await client.charge.findUnique({ where: { id: chargeId } });
    if (!charge || charge.status === ChargeStatus.CANCELLED) return charge;

    const payments = await client.payment.findMany({
      where: { chargeId, status: PaymentStatus.CONFIRMED },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
    });
    const seenPaymentIds = new Set<string>();
    let remainingDue = Number(charge.amountDue);
    let totalPaid = 0;

    for (const payment of payments) {
      seenPaymentIds.add(payment.id);
      const amount = Number(payment.amount);
      totalPaid = roundMoney(totalPaid + amount);
      const appliedToCharge = Math.min(amount, Math.max(remainingDue, 0));
      remainingDue = roundMoney(remainingDue - appliedToCharge);
      const overpayment = payment.method === PaymentMethod.CREDIT ? 0 : roundMoney(Math.max(amount - appliedToCharge, 0));
      await this.syncOverpaymentLedger(client, charge, payment, overpayment);
    }

    await this.voidUnusedOrphanOverpayments(client, charge.id, seenPaymentIds);
    const amountPaid = roundMoney(Math.min(totalPaid, Number(charge.amountDue)));
    const credit = await this.creditSummaryForCharge(client, charge.id);
    const amountDue = Number(charge.amountDue);
    const status =
      amountDue <= 0
        ? credit.creditBalance > 0 && credit.overpaidAmount > 0
          ? ChargeStatus.OVERPAID
          : ChargeStatus.PAID
        : amountPaid === 0
        ? ChargeStatus.UNPAID
        : amountPaid < amountDue
          ? ChargeStatus.PARTIAL
          : credit.creditBalance > 0 && credit.overpaidAmount > 0
            ? ChargeStatus.OVERPAID
            : ChargeStatus.PAID;

    const updated = await client.charge.update({ where: { id: chargeId }, data: { amountPaid, status } });
    await this.activateContractAfterPaidDeposit(client, updated);
    return { ...updated, ...credit, remainingAmount: remainingAmount(updated) };
  }

  private async activateContractAfterPaidDeposit(client: DbClient, charge: any) {
    if (charge.chargeType !== ChargeType.DEPOSIT || ![ChargeStatus.PAID, ChargeStatus.OVERPAID].includes(charge.status) || !charge.contractId) return;
    const contract = await client.rentalContract.findUnique({
      where: { id: charge.contractId },
      include: {
        occupants: true,
        contractRooms: { include: { room: true } },
        room: true,
      },
    });
    if (!contract || contract.status === ContractStatus.ACTIVE) return;

    const rooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
    const effective = startOfLocalDay(contract.startDate).getTime() <= startOfLocalDay(new Date()).getTime();
    await client.rentalContract.update({ where: { id: contract.id }, data: { status: ContractStatus.ACTIVE } });
    await client.tenant.update({
      where: { id: contract.representativeTenantId },
      data: { status: effective ? TenantStatus.STAYING : TenantStatus.DEPOSITED },
    });
    await client.contractOccupant.updateMany({
      where: { contractId: contract.id, status: { not: OccupantStatus.LEFT } },
      data: { status: effective ? OccupantStatus.STAYING : OccupantStatus.DEPOSITED },
    });
    if (!effective) {
      await client.room.updateMany({ where: { id: { in: rooms.map((room) => room.id) } }, data: { status: RoomStatus.DEPOSITED, currentOccupantCount: 0 } });
      return;
    }

    const counts = new Map<string, number>();
    for (const room of rooms) counts.set(room.id, room.id === contract.roomId ? 1 : 0);
    for (const occupant of contract.occupants) {
      if (occupant.status === OccupantStatus.LEFT) continue;
      const roomId = occupant.roomId ?? contract.roomId;
      counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
    }
    for (const room of rooms) {
      await client.room.update({
        where: { id: room.id },
        data: { status: RoomStatus.OCCUPIED, currentOccupantCount: counts.get(room.id) ?? 0 },
      });
    }
  }

  private async syncOverpaymentLedger(client: DbClient, charge: any, payment: any, overpayment: number) {
    const existing = await client.creditLedger.findFirst({
      where: { type: CreditLedgerType.OVERPAYMENT, sourcePaymentId: payment.id },
    });
    if (overpayment > 0) {
      const data = {
        businessId: charge.businessId,
        tenantId: charge.payerTenantId,
        contractId: charge.contractId,
        roomId: charge.roomId,
        sourceChargeId: charge.id,
        sourcePaymentId: payment.id,
        bankTransactionId: payment.bankTransactionId,
        type: CreditLedgerType.OVERPAYMENT,
        status: CreditLedgerStatus.POSTED,
        amount: overpayment,
        note: `Overpayment from payment ${payment.id}`,
      };
      if (existing) await client.creditLedger.update({ where: { id: existing.id }, data });
      else await client.creditLedger.create({ data });
      return;
    }
    if (existing?.status === CreditLedgerStatus.POSTED) {
      const used = await this.usedCreditFromPayment(client, payment.id);
      if (used === 0) await client.creditLedger.update({ where: { id: existing.id }, data: { status: CreditLedgerStatus.VOIDED } });
    }
  }

  private async voidUnusedOrphanOverpayments(client: DbClient, chargeId: string, confirmedPaymentIds: Set<string>) {
    const overpayments = await client.creditLedger.findMany({
      where: { sourceChargeId: chargeId, type: CreditLedgerType.OVERPAYMENT, status: CreditLedgerStatus.POSTED },
      select: { id: true, sourcePaymentId: true },
    });
    for (const ledger of overpayments) {
      if (!ledger.sourcePaymentId || confirmedPaymentIds.has(ledger.sourcePaymentId)) continue;
      const used = await this.usedCreditFromPayment(client, ledger.sourcePaymentId);
      if (used === 0) await client.creditLedger.update({ where: { id: ledger.id }, data: { status: CreditLedgerStatus.VOIDED } });
    }
  }

  private async allocateCredit(client: DbClient, sourceChargeId: string, amount: number) {
    const overpayments = await client.creditLedger.findMany({
      where: { sourceChargeId, type: CreditLedgerType.OVERPAYMENT, status: CreditLedgerStatus.POSTED },
      orderBy: [{ createdAt: 'asc' }],
    });
    const allocations: Array<{ sourcePaymentId: string | null; amount: number }> = [];
    let remaining = amount;
    for (const overpayment of overpayments) {
      if (remaining <= 0) break;
      const sourcePaymentId = overpayment.sourcePaymentId;
      const used = sourcePaymentId ? await this.usedCreditFromPayment(client, sourcePaymentId) : 0;
      const available = roundMoney(Number(overpayment.amount) - used);
      if (available <= 0) continue;
      const take = roundMoney(Math.min(available, remaining));
      allocations.push({ sourcePaymentId, amount: take });
      remaining = roundMoney(remaining - take);
    }
    if (remaining > 0) throw new BadRequestException('Available credit allocation is insufficient');
    return allocations;
  }

  private async usedCreditFromPayment(client: DbClient, sourcePaymentId: string) {
    const aggregate = await client.creditLedger.aggregate({
      where: {
        sourcePaymentId,
        status: CreditLedgerStatus.POSTED,
        type: { in: [CreditLedgerType.APPLY_TO_CHARGE, CreditLedgerType.REFUND] },
      },
      _sum: { amount: true },
    });
    return Math.abs(Number(aggregate._sum.amount ?? 0));
  }

  private async creditBalance(client: DbClient, sourceChargeId: string) {
    const summary = await this.creditSummaryForCharge(client, sourceChargeId);
    return summary.creditBalance;
  }

  private async creditSummaryForCharge(client: DbClient, sourceChargeId: string) {
    const ledgers = await client.creditLedger.findMany({
      where: { sourceChargeId, status: CreditLedgerStatus.POSTED },
      select: { type: true, amount: true },
    });
    return summarizeLedgers(ledgers);
  }

  private async findChargeForUser(client: DbClient, user: AuthUser, id: string) {
    const charge = await client.charge.findFirst({ where: scopedWhere(user, { id }) });
    if (!charge) throw new NotFoundException('Charge not found');
    if (charge.status === ChargeStatus.CANCELLED) throw new BadRequestException('Cancelled charge cannot use tenant credit');
    return charge;
  }

  private findMatchingOutboundTransaction(client: DbClient, businessId: string, amount: number, transferContent: string, ownerBankAccountId?: string) {
    return client.bankTransaction.findFirst({
      where: {
        businessId,
        ...(ownerBankAccountId ? { bankAccountId: ownerBankAccountId } : {}),
        type: TransactionType.OUT,
        amount,
        description: { contains: transferContent, mode: 'insensitive' },
      },
      orderBy: { transactionTime: 'desc' },
    });
  }

  private async findOwnerBankAccount(client: DbClient, businessId: string, bankAccountId: string) {
    const bankAccount = await client.bankAccount.findFirst({
      where: {
        id: bankAccountId,
        businessId,
        status: BankAccountStatus.ACTIVE,
      },
    });
    if (!bankAccount) throw new BadRequestException('Owner bank account not found or inactive');
    return bankAccount;
  }

  private async afterCreditChanged(user: AuthUser, businessId: string, action: string, entityId: string, metadata?: unknown) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'CreditLedger', entityId, metadata });
    this.realtime.emitBusiness(businessId, 'tenant-credit.changed', { entityId, action });
  }
}

type CreditFields = { overpaidAmount: number; creditBalance: number; remainingAmount: number };

function creditLedgerInclude() {
  return {
    sourceCharge: { include: { room: { include: { roomArea: true } }, payerTenant: true } },
    targetCharge: { include: { room: { include: { roomArea: true } }, payerTenant: true } },
    sourcePayment: true,
    targetPayment: true,
    bankTransaction: true,
    activity: {
      include: {
        creator: { select: { id: true, fullName: true, phone: true, role: true } },
        ownerBankAccount: true,
        bankTransaction: true,
      },
    },
  };
}

function tenantCreditActivityInclude() {
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

function pickFilters(query: any, fields: string[]) {
  return fields.reduce<Record<string, unknown>>((where, field) => {
    if (query[field] !== undefined && query[field] !== '') where[field] = query[field];
    return where;
  }, {});
}

function summarizeLedgers(ledgers: Array<{ type: CreditLedgerType; amount: Prisma.Decimal | number }>) {
  let creditBalance = 0;
  let overpaidAmount = 0;
  let appliedAmount = 0;
  let refundedAmount = 0;
  for (const ledger of ledgers) {
    const amount = Number(ledger.amount);
    creditBalance = roundMoney(creditBalance + amount);
    if (ledger.type === CreditLedgerType.OVERPAYMENT) overpaidAmount = roundMoney(overpaidAmount + amount);
    if (ledger.type === CreditLedgerType.APPLY_TO_CHARGE) appliedAmount = roundMoney(appliedAmount + Math.abs(amount));
    if (ledger.type === CreditLedgerType.REFUND) refundedAmount = roundMoney(refundedAmount + Math.abs(amount));
  }
  return { creditBalance, overpaidAmount, appliedAmount, refundedAmount };
}

function emptyCreditFields(charge: any): CreditFields {
  return { overpaidAmount: 0, creditBalance: 0, remainingAmount: remainingAmount(charge) };
}

function remainingAmount(charge: any) {
  return roundMoney(Math.max(Number(charge.amountDue) - Number(charge.amountPaid), 0));
}

function normalizePositiveAmount(value: unknown, field: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException(`${field} must be greater than 0`);
  return roundMoney(amount);
}

function normalizeRefundMethod(value: unknown) {
  if (value === RefundMethod.CASH || value === RefundMethod.BANK_TRANSFER) return value;
  throw new BadRequestException('refundMethod must be CASH or BANK_TRANSFER');
}

function requiredText(value: unknown, message: string) {
  const text = optionalText(value);
  if (!text) throw new BadRequestException(message);
  return text;
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function sameMoney(left: number, right: number) {
  return Math.round(left * 100) === Math.round(right * 100);
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function makeActivityCode(type: TenantCreditActivityType) {
  const prefix = type === TenantCreditActivityType.REFUND ? 'RF' : 'CR';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${date}-${suffix}`;
}
