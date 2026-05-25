import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, CreditLedgerStatus, CreditLedgerType, PaymentMethod, PaymentStatus } from '@prisma/client';
import ExcelJS from 'exceljs';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { toMoney } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCreditsService } from '../tenant-credits/tenant-credits.service';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly tenantCredits: TenantCreditsService) {}

  async collectionSummary(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    const [charges, payments, realPayments, creditBalance, overpaidAmount] = await Promise.all([
      this.prisma.charge.aggregate({ where: { businessId: user.businessId }, _sum: { amountDue: true, amountPaid: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['method'], where: { businessId: user.businessId, status: PaymentStatus.CONFIRMED }, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { businessId: user.businessId, status: PaymentStatus.CONFIRMED, method: { not: PaymentMethod.CREDIT } }, _sum: { amount: true } }),
      this.prisma.creditLedger.aggregate({ where: { businessId: user.businessId, status: CreditLedgerStatus.POSTED }, _sum: { amount: true } }),
      this.prisma.creditLedger.aggregate({ where: { businessId: user.businessId, status: CreditLedgerStatus.POSTED, type: CreditLedgerType.OVERPAYMENT }, _sum: { amount: true } }),
    ]);
    return {
      totalCharges: charges._count,
      totalDue: toMoney(charges._sum.amountDue),
      totalPaid: toMoney(charges._sum.amountPaid),
      totalCollected: toMoney(realPayments._sum.amount),
      creditBalance: toMoney(creditBalance._sum.amount),
      overpaidAmount: toMoney(overpaidAmount._sum.amount),
      byMethod: payments,
    };
  }

  async debt(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    const charges = await this.prisma.charge.findMany({
      where: { businessId: user.businessId, status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] } },
      include: { room: { include: { roomArea: true } }, payerTenant: true },
      orderBy: { dueDate: 'asc' },
    });
    return this.tenantCredits.enrichCharges(charges);
  }

  payments(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    return this.prisma.payment.findMany({ where: { businessId: user.businessId }, include: { charge: true, room: { include: { roomArea: true } }, tenant: true }, orderBy: { paidAt: 'desc' } });
  }

  bankTransactions(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    return this.prisma.bankTransaction.findMany({ where: { businessId: user.businessId }, include: { matches: true }, orderBy: { transactionTime: 'desc' } });
  }

  async exportExcel(user: AuthUser) {
    const [summary, debt, payments, transactions] = await Promise.all([
      this.collectionSummary(user),
      this.debt(user),
      this.payments(user),
      this.bankTransactions(user),
    ]);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'RentPay Manager';
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.addRows([
      ['Metric', 'Value'],
      ['Total charges', summary.totalCharges],
      ['Total due', summary.totalDue],
      ['Total paid', summary.totalPaid],
      ['Total collected', summary.totalCollected],
      ['Credit balance', summary.creditBalance],
      ['Overpaid amount', summary.overpaidAmount],
    ]);
    const debtSheet = workbook.addWorksheet('Debt');
    debtSheet.addRow(['Room', 'Title', 'Amount Due', 'Amount Paid', 'Remaining', 'Credit Balance', 'Status', 'Due Date']);
    debt.forEach((c: any) => debtSheet.addRow([c.room.roomCode, c.title, Number(c.amountDue), Number(c.amountPaid), c.remainingAmount, c.creditBalance, c.status, c.dueDate]));
    const paymentSheet = workbook.addWorksheet('Payments');
    paymentSheet.addRow(['Charge', 'Room', 'Method', 'Amount', 'Paid At', 'Status']);
    payments.forEach((p) => paymentSheet.addRow([p.charge.title, p.room.roomCode, p.method, Number(p.amount), p.paidAt, p.status]));
    const txSheet = workbook.addWorksheet('BankTransactions');
    txSheet.addRow(['Ref', 'Amount', 'Description', 'Classification', 'Time']);
    transactions.forEach((t) => txSheet.addRow([t.transactionRef, Number(t.amount), t.description, t.classification, t.transactionTime]));
    return workbook.xlsx.writeBuffer();
  }
}
