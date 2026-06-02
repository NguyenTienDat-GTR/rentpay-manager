import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, PaymentMatchStatus, PaymentMethod, PaymentStatus, TransactionClassification, TransactionType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BillingPeriodsService } from '../billing-periods/billing-periods.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';
import { PaymentsService } from '../payments/payments.service';
import { TenantCreditsService } from '../tenant-credits/tenant-credits.service';

@Injectable()
export class BankTransactionsService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly payments: PaymentsService,
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
      model: 'bankTransaction',
      user,
      query,
      searchFields: ['transactionRef', 'description', 'accountNumber'],
      filterFields: ['classification', 'type', 'bankAccountId'],
      sortFields: ['amount', 'transactionTime', 'classification', 'createdAt'],
      include: {
        bankAccount: true,
        payments: { include: { room: { include: { roomArea: true } }, charge: true } },
        matches: { include: { charge: { include: { room: { include: { roomArea: true } } } } } },
      },
    });
  }

  listMatches(user: AuthUser, query: any) {
    return super.listItems({
      model: 'paymentMatch',
      user,
      query,
      searchFields: [],
      filterFields: ['matchStatus'],
      sortFields: ['confidence', 'createdAt'],
      include: { transaction: true, charge: { include: { room: { include: { roomArea: true } } } }, reviewer: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  async reviewContext(user: AuthUser, id: string) {
    const match = await this.get('paymentMatch', user, id, {
      transaction: { include: { bankAccount: true, payments: true } },
      charge: { include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true } },
      reviewer: { select: { id: true, fullName: true, phone: true } },
    });
    const suggestions = await this.suggestChargesForTransaction(match.transaction);
    return { match, transaction: match.transaction, suggestions };
  }

  async confirmMatch(user: AuthUser, id: string, body: any) {
    const chargeId = requiredText(body.chargeId, 'chargeId is required');
    const reviewNote = optionalText(body.reviewNote);
    const match = await this.get('paymentMatch', user, id, {
      transaction: { include: { payments: true } },
    });
    if (match.matchStatus !== PaymentMatchStatus.NEEDS_REVIEW) throw new BadRequestException('Only matches that need review can be confirmed');
    const transaction = match.transaction;
    if (transaction.type !== TransactionType.IN || Number(transaction.amount) <= 0) {
      throw new BadRequestException('Only inbound transactions with positive amount are processed.');
    }
    if (hasConfirmedPayment(transaction.payments)) throw new BadRequestException('Bank transaction already has a confirmed payment');

    const charge = await this.prisma.charge.findFirst({
      where: { id: chargeId, businessId: match.businessId },
      include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true },
    });
    if (!charge) throw new BadRequestException('Charge not found');
    this.assertChargeCanBeManuallyMatched(charge);

    const amount = Number(transaction.amount);
    const remainingAmount = remainingChargeAmount(charge);
    if (amount > remainingAmount && !reviewNote) throw new BadRequestException('Review note is required when transaction amount exceeds remaining charge amount');

    const result = await this.prisma.$transaction(async (tx) => {
      const existingPayment = await tx.payment.findFirst({ where: { bankTransactionId: transaction.id, status: PaymentStatus.CONFIRMED } });
      if (existingPayment) throw new BadRequestException('Bank transaction already has a confirmed payment');
      const payment = await tx.payment.create({
        data: {
          businessId: charge.businessId,
          chargeId: charge.id,
          roomId: charge.roomId,
          contractId: charge.contractId,
          tenantId: charge.payerTenantId,
          method: PaymentMethod.BANK_TRANSFER,
          amount,
          paidAt: transaction.transactionTime,
          bankTransactionId: transaction.id,
          note: reviewNote,
        },
      });
      const reviewedAt = new Date();
      const updatedMatch = await tx.paymentMatch.update({
        where: { id },
        data: {
          chargeId: charge.id,
          matchStatus: PaymentMatchStatus.MANUAL_MATCHED,
          confidence: Math.max(Number(match.confidence ?? 0), 90),
          reviewedBy: user.sub,
          reviewedAt,
          reviewNote,
          reviewDecision: {
            action: 'CONFIRM',
            chargeId: charge.id,
            transactionId: transaction.id,
            paymentId: payment.id,
            amount,
            remainingAmountBefore: remainingAmount,
          },
        },
      });
      await tx.bankTransaction.update({ where: { id: transaction.id }, data: { classification: TransactionClassification.RENT_MATCHED } });
      return { payment, match: updatedMatch, businessId: charge.businessId };
    });

    const updatedCharge = await this.tenantCredits.recalculateCharge(charge.id);
    await this.billingPeriods.autoLockIfNoUnpaidCharges(updatedCharge?.billingPeriodId);
    await this.redis.del(`dashboard:${result.businessId}:*`);
    await this.audit.log({
      businessId: result.businessId,
      userId: user.sub,
      action: 'MANUAL_CONFIRM_PAYMENT_MATCH',
      entity: 'PaymentMatch',
      entityId: id,
      metadata: { chargeId: charge.id, transactionId: transaction.id, paymentId: result.payment.id, reviewNote },
    });
    this.realtime.emitBusiness(result.businessId, 'payment-match.reviewed', { match: result.match, payment: result.payment, charge: updatedCharge });
    this.realtime.emitBusiness(result.businessId, 'payment.changed', { payment: result.payment, charge: updatedCharge });
    return { ...result, charge: updatedCharge };
  }

  async rejectMatch(user: AuthUser, id: string, body: any) {
    const reviewNote = optionalText(body.reviewNote);
    const match = await this.get('paymentMatch', user, id, { transaction: { include: { payments: true } } });
    if (match.matchStatus !== PaymentMatchStatus.NEEDS_REVIEW) throw new BadRequestException('Only matches that need review can be rejected');
    if (hasConfirmedPayment(match.transaction.payments)) throw new BadRequestException('Bank transaction already has a confirmed payment');
    const suggestions = await this.suggestChargesForTransaction(match.transaction);
    if (!suggestions.length && !reviewNote) throw new BadRequestException('Review note is required when no valid charge suggestions are found');
    const reviewedAt = new Date();
    const updated = await this.prisma.paymentMatch.update({
      where: { id },
      data: {
        matchStatus: PaymentMatchStatus.REJECTED,
        reviewedBy: user.sub,
        reviewedAt,
        reviewNote,
        reviewDecision: {
          action: 'REJECT',
          transactionId: match.transactionId,
          chargeId: match.chargeId,
        },
      },
    });
    await this.prisma.bankTransaction.update({ where: { id: match.transactionId }, data: { classification: TransactionClassification.OTHER } });
    await this.redis.del(`dashboard:${match.businessId}:*`);
    await this.audit.log({
      businessId: match.businessId,
      userId: user.sub,
      action: 'REJECT_PAYMENT_MATCH',
      entity: 'PaymentMatch',
      entityId: id,
      metadata: { transactionId: match.transactionId, chargeId: match.chargeId, reviewNote },
    });
    this.realtime.emitBusiness(match.businessId, 'payment-match.reviewed', { match: updated });
    return updated;
  }

  async receiveWebhook(body: any, sourceUser?: AuthUser) {
    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { bankCode: body.bankCode, accountNumber: body.accountNumber, status: 'ACTIVE' },
    });
    if (!bankAccount) throw new BadRequestException('Unknown bank account');

    const duplicate = await this.prisma.bankTransaction.findFirst({
      where: { bankAccountId: bankAccount.id, transactionRef: body.transactionRef },
      include: { matches: true, payments: true },
    });
    if (duplicate) return { duplicate: true, transaction: duplicate };

    const amount = Number(body.amount);
    const type = body.type ?? TransactionType.IN;
    const paymentCode = extractPaymentCode(body.description);
    const now = body.transactionTime ? new Date(body.transactionTime) : new Date();

    let classification: TransactionClassification = TransactionClassification.OTHER;
    let matchStatus: PaymentMatchStatus = PaymentMatchStatus.IGNORED;
    let chargeId: string | null = null;
    let confidence = 0;
    let reason: string[] = [];

    if (type !== TransactionType.IN || amount <= 0) {
      reason = ['Only inbound transactions with positive amount are processed.'];
    } else if (!paymentCode) {
      classification = TransactionClassification.SUSPICIOUS;
      matchStatus = PaymentMatchStatus.NEEDS_REVIEW;
      confidence = 20;
      reason = ['Inbound transaction has no valid paymentCode and requires manual confirmation.'];
    } else {
      const charge = await this.prisma.charge.findFirst({
        where: { paymentCode, businessId: bankAccount.businessId },
        include: { bankAccount: true },
      });
      if (!charge) {
        classification = TransactionClassification.SUSPICIOUS;
        matchStatus = PaymentMatchStatus.NEEDS_REVIEW;
        confidence = 40;
        reason = ['Payment code was not found in this business.'];
      } else if (charge.status === ChargeStatus.CANCELLED) {
        classification = TransactionClassification.SUSPICIOUS;
        matchStatus = PaymentMatchStatus.NEEDS_REVIEW;
        chargeId = charge.id;
        confidence = 70;
        reason = ['Payment code belongs to cancelled charge.'];
      } else {
        classification = TransactionClassification.RENT_MATCHED;
        matchStatus = PaymentMatchStatus.AUTO_MATCHED;
        chargeId = charge.id;
        confidence = 100;
        reason = ['Valid paymentCode matched charge.'];
      }
    }

    const transaction = await this.prisma.bankTransaction.create({
      data: {
        businessId: bankAccount.businessId,
        bankAccountId: bankAccount.id,
        bankCode: body.bankCode,
        accountNumber: body.accountNumber,
        transactionRef: body.transactionRef,
        amount,
        description: body.description,
        transactionTime: now,
        type,
        classification,
        rawData: body,
      },
    });
    const match = await this.prisma.paymentMatch.create({
      data: { businessId: bankAccount.businessId, transactionId: transaction.id, chargeId, matchStatus, confidence, reason },
    });

    let paymentResult: unknown = null;
    if (classification === TransactionClassification.RENT_MATCHED && chargeId) {
      paymentResult = await this.payments.createBankTransferPayment({ chargeId, bankTransactionId: transaction.id, amount, paidAt: now });
    } else if (type === TransactionType.OUT && amount > 0) {
      paymentResult = await this.tenantCredits.autoLinkOutboundRefund(transaction.id);
    }

    await this.redis.del(`dashboard:${bankAccount.businessId}:*`);
    await this.audit.log({
      businessId: bankAccount.businessId,
      userId: sourceUser?.sub,
      action: classification === TransactionClassification.RENT_MATCHED ? 'AUTO_MATCH_BANK_TRANSACTION' : 'RECEIVE_BANK_TRANSACTION',
      entity: 'BankTransaction',
      entityId: transaction.id,
      metadata: { matchStatus, chargeId, reason },
    });
    this.realtime.emitBusiness(bankAccount.businessId, 'bank-transaction.created', { transaction, match, paymentResult });
    return { transaction, match, paymentResult };
  }

  private async suggestChargesForTransaction(transaction: any) {
    if (transaction.type !== TransactionType.IN || Number(transaction.amount) <= 0) return [];
    const charges = await this.prisma.charge.findMany({
      where: {
        businessId: transaction.businessId,
        bankAccountId: transaction.bankAccountId,
        status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] },
      },
      include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true, items: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return charges
      .map((charge) => scoreChargeCandidate(transaction, charge))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || Number(left.remainingAmount) - Number(right.remainingAmount))
      .slice(0, 10);
  }

  private assertChargeCanBeManuallyMatched(charge: any) {
    if ([ChargeStatus.CANCELLED, ChargeStatus.PAID, ChargeStatus.OVERPAID].includes(charge.status)) {
      throw new BadRequestException('Charge cannot receive more payments');
    }
    if (!charge.paymentCode || !charge.room || !charge.billingPeriodId || (!charge.payerTenantId && !charge.contractId)) {
      throw new BadRequestException('Charge does not have enough traceable information for manual matching');
    }
  }
}

function extractPaymentCode(description = '') {
  return description.toUpperCase().match(/RTP-[A-Z0-9]{6}/)?.[0] ?? null;
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

function hasConfirmedPayment(payments: any[] = []) {
  return payments.some((payment) => payment.status === PaymentStatus.CONFIRMED);
}

function remainingChargeAmount(charge: any) {
  return Math.max(Number(charge.amountDue ?? 0) - Number(charge.amountPaid ?? 0), 0);
}

function normalizeSearchText(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'd')
    .toLowerCase();
}

function includesText(haystack: string, value: unknown) {
  const text = normalizeSearchText(value).trim();
  return Boolean(text && (haystack.includes(text) || compactText(haystack).includes(compactText(text))));
}

function compactText(value: unknown) {
  return normalizeSearchText(value).replace(/[^a-z0-9]/g, '');
}

function scoreChargeCandidate(transaction: any, charge: any) {
  const description = normalizeSearchText(transaction.description);
  const amount = Number(transaction.amount);
  const remainingAmount = remainingChargeAmount(charge);
  const reasons: string[] = [];
  let score = 0;

  if (includesText(description, charge.paymentCode)) {
    score += 100;
    reasons.push('MATCH_PAYMENT_CODE');
  }
  if (includesText(description, charge.transferContent)) {
    score += 25;
    reasons.push('MATCH_TRANSFER_CONTENT');
  }
  if (matchesChargeItems(description, charge)) {
    score += 25;
    reasons.push('MATCH_CHARGE_ITEM');
  }
  if (matchesBillingPeriod(description, charge.billingPeriod)) {
    score += 25;
    reasons.push('MATCH_BILLING_PERIOD');
  }
  if (Math.abs(amount - remainingAmount) < 1) {
    score += 40;
    reasons.push('MATCH_REMAINING_AMOUNT');
  }
  if (Math.abs(amount - Number(charge.amountDue ?? 0)) < 1) {
    score += 30;
    reasons.push('MATCH_AMOUNT_DUE');
  }
  if (includesText(description, charge.room?.roomCode)) {
    score += 20;
    reasons.push('MATCH_ROOM_CODE');
  }
  if (includesText(description, charge.room?.roomArea?.name)) {
    score += 15;
    reasons.push('MATCH_ROOM_AREA');
  }
  if (includesText(description, charge.payerTenant?.phone)) {
    score += 15;
    reasons.push('MATCH_TENANT_PHONE');
  }
  if (includesText(description, charge.payerTenant?.fullName)) {
    score += 10;
    reasons.push('MATCH_TENANT_NAME');
  }
  if ([ChargeStatus.UNPAID, ChargeStatus.PARTIAL].includes(charge.status)) {
    score += 10;
    reasons.push('OPEN_CHARGE');
  }

  return { charge, score, reasons, remainingAmount };
}

function matchesChargeItems(description: string, charge: any) {
  const candidates = new Set<string>();
  if (charge.chargeType) {
    for (const label of chargeTypeSearchTerms(String(charge.chargeType))) candidates.add(label);
  }
  for (const item of charge.items ?? []) {
    if (item?.title) candidates.add(String(item.title));
    if (item?.chargeType) {
      for (const label of chargeTypeSearchTerms(String(item.chargeType))) candidates.add(label);
    }
  }
  return Array.from(candidates).some((candidate) => includesText(description, candidate));
}

function chargeTypeSearchTerms(type: string) {
  const terms: Record<string, string[]> = {
    ROOM_RENT: ['tien phong', 'thue phong', 'phong', 'rent'],
    DEPOSIT: ['tien coc', 'coc'],
    ELECTRICITY: ['tien dien', 'dien'],
    WATER: ['tien nuoc', 'nuoc'],
    PARKING: ['gui xe', 'giu xe', 'xe'],
    INTERNET: ['internet', 'wifi', 'mang'],
    GARBAGE: ['tien rac', 'rac'],
    CLEANING: ['ve sinh', 'don dep'],
    DAMAGE_FEE: ['boi thuong', 'hu hong'],
    OTHER: [],
  };
  return terms[type] ?? [];
}

function matchesBillingPeriod(description: string, billingPeriod: any) {
  if (!billingPeriod?.month || !billingPeriod?.year) return false;
  const month = Number(billingPeriod.month);
  const year = Number(billingPeriod.year);
  const shortYear = String(year).slice(-2);
  const normalized = normalizeSearchText(description);
  return [
    `${month}/${year}`,
    `${String(month).padStart(2, '0')}/${year}`,
    `${month}-${year}`,
    `${String(month).padStart(2, '0')}-${year}`,
    `thang ${month} ${year}`,
    `thang ${String(month).padStart(2, '0')} ${year}`,
    `${month}/${shortYear}`,
    `${String(month).padStart(2, '0')}/${shortYear}`,
  ].some((pattern) => normalized.includes(pattern));
}
