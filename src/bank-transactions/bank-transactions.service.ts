import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, PaymentMatchStatus, TransactionClassification, TransactionType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class BankTransactionsService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
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
      include: { bankAccount: true, matches: { include: { charge: true } } },
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
      include: { transaction: true, charge: true },
    });
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
      classification = looksPaymentRelated(body.description) ? TransactionClassification.SUSPICIOUS : TransactionClassification.OTHER;
      matchStatus = classification === TransactionClassification.SUSPICIOUS ? PaymentMatchStatus.NEEDS_REVIEW : PaymentMatchStatus.IGNORED;
      confidence = classification === TransactionClassification.SUSPICIOUS ? 30 : 0;
      reason = classification === TransactionClassification.SUSPICIOUS ? ['Description looks payment-related but has no valid paymentCode.'] : ['No paymentCode found.'];
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
}

function extractPaymentCode(description = '') {
  return description.toUpperCase().match(/RTP-[A-Z0-9]{6}/)?.[0] ?? null;
}

function looksPaymentRelated(description = '') {
  return /(thue|thuê|phong|phòng|tien phong|tiền phòng|rent|dien|điện|nuoc|nước)/i.test(description);
}
