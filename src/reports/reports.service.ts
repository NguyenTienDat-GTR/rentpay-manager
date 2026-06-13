import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ChargeStatus,
  ContractStatus,
  CreditLedgerStatus,
  CreditLedgerType,
  PaymentMatchStatus,
  PaymentMethod,
  PaymentStatus,
  RoomStatus,
  TenantCreditActivityStatus,
  TenantCreditActivityType,
  TenantStatus,
  TransactionClassification,
} from '@prisma/client';
import ExcelJS from 'exceljs';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { toMoney } from '../common/utils/list-query';
import { resolveDateRange } from '../dashboard/dashboard.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantCreditsService } from '../tenant-credits/tenant-credits.service';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly tenantCredits: TenantCreditsService) {}

  async collectionSummary(user: AuthUser, query: any = {}) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    const range = resolveDateRange(query);
    const previousRange = range ? previousDateRange(range) : undefined;
    const current = await this.buildCollectionSlice(user.businessId, range);
    const previous = await this.buildCollectionSlice(user.businessId, previousRange);
    const [creditBalance, overpaidAmount, analytics] = await Promise.all([
      this.prisma.creditLedger.aggregate({ where: { businessId: user.businessId, status: CreditLedgerStatus.POSTED }, _sum: { amount: true } }),
      this.prisma.creditLedger.aggregate({ where: { businessId: user.businessId, status: CreditLedgerStatus.POSTED, type: CreditLedgerType.OVERPAYMENT }, _sum: { amount: true } }),
      this.buildOperationalAnalytics(user.businessId, range),
    ]);
    return {
      ...current,
      creditBalance: toMoney(creditBalance._sum.amount),
      overpaidAmount: toMoney(overpaidAmount._sum.amount),
      comparison: {
        previousRange,
        totalDue: compareMetric(current.totalDue, previous.totalDue),
        totalPaid: compareMetric(current.totalPaid, previous.totalPaid),
        totalCollected: compareMetric(current.totalCollected, previous.totalCollected),
        depositCollected: compareMetric(current.depositCollected, previous.depositCollected),
        totalDebt: compareMetric(current.totalDebt, previous.totalDebt),
      },
      analytics,
      previous,
    };
  }

  async debt(user: AuthUser, query: any = {}) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    const range = resolveDateRange(query);
    const charges = await this.prisma.charge.findMany({
      where: { businessId: user.businessId, status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] }, ...(range ? { createdAt: range } : {}) },
      include: { room: { include: { roomArea: true } }, payerTenant: true },
      orderBy: { dueDate: 'asc' },
    });
    return this.tenantCredits.enrichCharges(charges);
  }

  payments(user: AuthUser, query: any = {}) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    const range = resolveDateRange(query);
    return this.prisma.payment.findMany({
      where: { businessId: user.businessId, ...(range ? { paidAt: range } : {}), ...(query.paymentMethod ? { method: query.paymentMethod } : {}), ...(query.status ? { status: query.status } : {}) },
      include: { charge: true, room: { include: { roomArea: true } }, tenant: true },
      orderBy: { paidAt: 'desc' },
    });
  }

  bankTransactions(user: AuthUser, query: any = {}) {
    if (!user.businessId) throw new BadRequestException('Report requires business user');
    const range = resolveDateRange(query);
    return this.prisma.bankTransaction.findMany({ where: { businessId: user.businessId, ...(range ? { transactionTime: range } : {}) }, include: { matches: true }, orderBy: { transactionTime: 'desc' } });
  }

  async exportExcel(user: AuthUser, query: any = {}) {
    const range = resolveDateRange(query);
    const [summary, debt, payments, transactions, contracts, rooms, tenants] = await Promise.all([
      this.collectionSummary(user, query),
      this.debt(user, query),
      this.payments(user, query),
      this.bankTransactions(user, query),
      this.prisma.rentalContract.findMany({
        where: { businessId: user.businessId! },
        include: { room: true, representativeTenant: true },
        orderBy: { endDate: 'asc' },
        take: 500,
      }),
      this.prisma.room.findMany({ where: { businessId: user.businessId! }, include: { roomArea: true }, orderBy: { roomCode: 'asc' }, take: 500 }),
      this.prisma.tenant.findMany({ where: { businessId: user.businessId! }, orderBy: { fullName: 'asc' }, take: 500 }),
    ]);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'RentPay Manager';
    workbook.lastModifiedBy = 'RentPay Manager';
    workbook.created = new Date();
    workbook.modified = new Date();

    const summarySheet = workbook.addWorksheet('Tổng hợp');
    addReportTitle(summarySheet, 'BÁO CÁO TỔNG HỢP THU TIỀN NHÀ TRỌ', 2);
    summarySheet.addRow(['Chỉ tiêu', 'Giá trị']);
    summarySheet.addRows([
      ['Tổng số khoản thu', summary.totalCharges],
      ['Tổng cần thu', summary.totalDue],
      ['Tổng đã ghi nhận trên khoản thu', summary.totalPaid],
      ['Tổng tiền thực thu', summary.totalCollected],
      ['Tiền cọc đã thu', summary.depositCollected],
      ['Tổng công nợ còn lại', summary.totalDebt],
      ['Số dư tiền dư / credit', summary.creditBalance],
      ['Số tiền thu vượt', summary.overpaidAmount],
    ]);
    styleTable(summarySheet, 3, 2, [26, 22]);

    const opsSheet = workbook.addWorksheet('Thống kê vận hành');
    addReportTitle(opsSheet, 'THỐNG KÊ VẬN HÀNH PHÒNG TRỌ', 4);
    opsSheet.addRow(['Nhóm thống kê', 'Chỉ tiêu', 'Số lượng', 'Giá trị tiền']);
    const analytics = summary.analytics ?? {};
    [
      ['Phòng', 'Tổng phòng', analytics.rooms?.total, ''],
      ['Phòng', 'Đang thuê', analytics.rooms?.occupied, ''],
      ['Phòng', 'Đang cọc', analytics.rooms?.deposited, ''],
      ['Phòng', 'Phòng trống', analytics.rooms?.available, ''],
      ['Người thuê', 'Tổng người thuê', analytics.tenants?.total, ''],
      ['Người thuê', 'Đang ở', analytics.tenants?.staying, ''],
      ['Người thuê', 'Đã đặt cọc', analytics.tenants?.deposited, ''],
      ['Hợp đồng', 'Hiệu lực', analytics.contracts?.active, ''],
      ['Hợp đồng', 'Chờ kích hoạt', analytics.contracts?.pending, ''],
      ['Hợp đồng', 'Sắp hết hạn trong 30 ngày', analytics.contracts?.expiringSoon, ''],
      ['Hoàn tiền / credit', 'Số lượt hoàn tiền', analytics.credits?.refunds?.count, analytics.credits?.refunds?.total],
      ['Hoàn tiền / credit', 'Số lượt cấn trừ', analytics.credits?.applied?.count, analytics.credits?.applied?.total],
    ].forEach((row) => opsSheet.addRow(row));
    styleTable(opsSheet, 3, 4, [22, 34, 16, 18]);

    const typeSheet = workbook.addWorksheet('Cơ cấu khoản thu');
    addReportTitle(typeSheet, 'CƠ CẤU KHOẢN THU THEO LOẠI', 4);
    typeSheet.addRow(['Loại khoản thu', 'Số khoản', 'Tổng cần thu', 'Tổng đã thu']);
    summary.chargeTypeBreakdown.forEach((item: any) => {
      typeSheet.addRow([labelChargeType(item.chargeType), item.count, Number(item.totalDue), Number(item.totalPaid)]);
    });
    styleTable(typeSheet, 3, 4, [26, 12, 18, 18]);

    const chargeStatusSheet = workbook.addWorksheet('Tình trạng khoản thu');
    addReportTitle(chargeStatusSheet, 'BÁO CÁO TÌNH TRẠNG KHOẢN THU', 5);
    chargeStatusSheet.addRow(['Trạng thái', 'Số khoản', 'Tổng cần thu', 'Tổng đã thu', 'Còn thiếu']);
    (summary.analytics?.charges?.byStatus ?? []).forEach((item: any) => {
      chargeStatusSheet.addRow([item.label, item.count, Number(item.totalDue), Number(item.totalPaid), Math.max(Number(item.totalDue) - Number(item.totalPaid), 0)]);
    });
    styleTable(chargeStatusSheet, 3, 5, [24, 12, 18, 18, 18]);

    const debtSheet = workbook.addWorksheet('Công nợ');
    addReportTitle(debtSheet, 'DANH SÁCH CÔNG NỢ VÀ KHOẢN QUÁ HẠN', 9);
    debtSheet.addRow(['Phòng', 'Người thuê', 'Mã khoản thu', 'Nội dung khoản thu', 'Cần thu', 'Đã thu', 'Còn thiếu', 'Tiền dư / credit còn lại', 'Trạng thái', 'Hạn thanh toán']);
    debt.forEach((c: any) =>
      debtSheet.addRow([
        c.room?.roomCode ?? '',
        c.payerTenant?.fullName ?? '',
        c.paymentCode ?? '',
        c.title ?? '',
        Number(c.amountDue ?? 0),
        Number(c.amountPaid ?? 0),
        Number(c.remainingAmount ?? Math.max(Number(c.amountDue ?? 0) - Number(c.amountPaid ?? 0), 0)),
        Number(c.creditBalance ?? 0),
        labelChargeStatus(c.status),
        c.dueDate ?? null,
      ]),
    );
    styleTable(debtSheet, 3, 10, [14, 24, 18, 34, 16, 16, 16, 22, 18, 18]);

    const paymentSheet = workbook.addWorksheet('Thanh toán');
    addReportTitle(paymentSheet, 'SỔ THEO DÕI THANH TOÁN', 9);
    paymentSheet.addRow(['Ngày thu', 'Phòng', 'Người thuê', 'Mã khoản thu', 'Nội dung nghiệp vụ', 'Loại khoản', 'Phương thức', 'Số tiền', 'Trạng thái']);
    payments.forEach((p: any) =>
      paymentSheet.addRow([
        p.paidAt ?? null,
        p.room?.roomCode ?? '',
        p.tenant?.fullName ?? '',
        p.charge?.paymentCode ?? '',
        p.charge?.title ?? p.note ?? '',
        labelChargeType(p.charge?.chargeType),
        labelPaymentMethod(p.method),
        Number(p.amount ?? 0),
        labelPaymentStatus(p.status),
      ]),
    );
    styleTable(paymentSheet, 3, 9, [18, 14, 24, 18, 34, 18, 18, 16, 18]);

    const txSheet = workbook.addWorksheet('Đối soát ngân hàng');
    addReportTitle(txSheet, 'DANH SÁCH GIAO DỊCH NGÂN HÀNG VÀ ĐỐI SOÁT', 7);
    txSheet.addRow(['Thời gian giao dịch', 'Mã tham chiếu', 'Số tiền', 'Nội dung giao dịch', 'Phân loại', 'Kết quả đối soát', 'Ghi chú']);
    transactions.forEach((t: any) =>
      txSheet.addRow([
        t.transactionTime ?? null,
        t.transactionRef ?? '',
        Number(t.amount ?? 0),
        t.description ?? '',
        labelTransactionClassification(t.classification),
        summarizeMatchStatus(t.matches),
        t.rawData ? 'Có dữ liệu gốc' : '',
      ]),
    );
    styleTable(txSheet, 3, 7, [20, 22, 16, 42, 18, 24, 18]);

    const contractSheet = workbook.addWorksheet('Hợp đồng');
    addReportTitle(contractSheet, 'BÁO CÁO HỢP ĐỒNG THUÊ PHÒNG', 9);
    contractSheet.addRow(['Phòng', 'Người đại diện', 'Ngày bắt đầu', 'Ngày kết thúc', 'Tiền thuê', 'Tiền cọc', 'Số tháng cọc', 'Chu kỳ thu', 'Trạng thái']);
    contracts.forEach((contract: any) =>
      contractSheet.addRow([
        contract.room?.roomCode ?? '',
        contract.representativeTenant?.fullName ?? '',
        contract.startDate ?? null,
        contract.endDate ?? null,
        Number(contract.rentAmount ?? 0),
        Number(contract.depositAmount ?? 0),
        contract.depositMonths ?? 0,
        labelPaymentCycle(contract.paymentCycle),
        labelContractStatus(contract.status),
      ]),
    );
    styleTable(contractSheet, 3, 9, [14, 26, 18, 18, 16, 16, 14, 16, 18]);

    const roomTenantSheet = workbook.addWorksheet('Phòng và người thuê');
    addReportTitle(roomTenantSheet, 'BÁO CÁO PHÒNG VÀ NGƯỜI THUÊ', 8);
    roomTenantSheet.addRow(['Loại dòng', 'Khu vực', 'Phòng / Người thuê', 'Số điện thoại', 'CMND/CCCD', 'Giá thuê cơ bản', 'Số người hiện tại', 'Trạng thái']);
    rooms.forEach((room: any) =>
      roomTenantSheet.addRow(['Phòng', room.roomArea?.name ?? '', room.roomCode ?? '', '', '', Number(room.baseRentAmount ?? 0), room.currentOccupantCount ?? 0, labelRoomStatus(room.status)]),
    );
    tenants.forEach((tenant: any) =>
      roomTenantSheet.addRow(['Người thuê', '', tenant.fullName ?? '', tenant.phone ?? '', tenant.identityNumber ?? '', '', '', labelTenantStatus(tenant.status)]),
    );
    styleTable(roomTenantSheet, 3, 8, [16, 22, 28, 18, 18, 18, 16, 18]);

    const refundSheet = workbook.addWorksheet('Hoàn tiền và credit');
    addReportTitle(refundSheet, 'BÁO CÁO HOÀN TIỀN VÀ CẤN TRỪ TIỀN DƯ', 10);
    refundSheet.addRow(['Ngày tạo', 'Mã hoạt động', 'Loại xử lý', 'Người thuê', 'Phòng', 'Khoản thu nguồn', 'Số tiền', 'Phương thức hoàn', 'Trạng thái đối soát', 'Ghi chú']);
    (summary.analytics?.credits?.refunds?.items ?? []).forEach((item: any) =>
      refundSheet.addRow([
        item.createdAt ?? null,
        item.activityCode ?? '',
        labelCreditActivityType(item.type),
        item.tenant?.fullName ?? '',
        item.room?.roomCode ?? '',
        item.sourceCharge?.paymentCode ?? item.sourceCharge?.title ?? '',
        Number(item.amount ?? 0),
        labelRefundMethod(item.refundMethod),
        item.bankMatchedAt ? 'Đã khớp ngân hàng' : item.refundMethod === 'BANK_TRANSFER' ? 'Chưa khớp ngân hàng' : 'Không cần đối soát',
        item.note ?? '',
      ]),
    );
    styleTable(refundSheet, 3, 10, [18, 20, 18, 24, 14, 24, 16, 18, 22, 28]);
    return workbook.xlsx.writeBuffer();
  }

  private async buildCollectionSlice(businessId: string, range?: { gte?: Date; lte?: Date }) {
    const chargeWhere = { businessId, ...(range ? { createdAt: range } : {}) };
    const paymentWhere = { businessId, status: PaymentStatus.CONFIRMED, ...(range ? { paidAt: range } : {}) };
    const [charges, payments, realPayments, chargeTypes, paymentMethods, timeline] = await Promise.all([
      this.prisma.charge.aggregate({ where: chargeWhere, _sum: { amountDue: true, amountPaid: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['method'], where: paymentWhere, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { ...paymentWhere, method: { not: PaymentMethod.CREDIT } }, _sum: { amount: true } }),
      this.prisma.charge.groupBy({ by: ['chargeType'], where: chargeWhere, _sum: { amountDue: true, amountPaid: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['method'], where: { ...paymentWhere, method: { not: PaymentMethod.CREDIT } }, _sum: { amount: true }, _count: true }),
      this.prisma.payment.findMany({
        where: { ...paymentWhere, method: { not: PaymentMethod.CREDIT } },
        select: { amount: true, paidAt: true, charge: { select: { chargeType: true } } },
        orderBy: { paidAt: 'asc' },
      }),
    ]);
    const totalDue = toMoney(charges._sum.amountDue);
    const totalPaid = toMoney(charges._sum.amountPaid);
    const depositCollected = chargeTypes.find((item) => item.chargeType === 'DEPOSIT')?._sum.amountPaid;
    return {
      totalCharges: charges._count,
      totalDue,
      totalPaid,
      totalCollected: toMoney(realPayments._sum.amount),
      totalDebt: Math.max(totalDue - totalPaid, 0),
      depositCollected: toMoney(depositCollected),
      byMethod: payments,
      chargeTypeBreakdown: chargeTypes.map((item) => ({
        chargeType: item.chargeType,
        totalDue: toMoney(item._sum.amountDue),
        totalPaid: toMoney(item._sum.amountPaid),
        count: item._count,
      })),
      methodBreakdown: paymentMethods.map((item) => ({ method: item.method, total: toMoney(item._sum.amount), count: item._count })),
      timeline: buildPaymentTimeline(timeline),
    };
  }

  private async buildOperationalAnalytics(businessId: string, range?: { gte?: Date; lte?: Date }) {
    const expiringTo = addDays(new Date(), 30);
    const [
      roomsByStatus,
      tenantsByStatus,
      contractsByStatus,
      expiringContracts,
      chargesByStatus,
      chargesByType,
      paymentsByMethod,
      transactionsByClassification,
      matchesByStatus,
      refunds,
      refundActivities,
      creditsApplied,
      occupantCount,
      roomAreaStats,
    ] = await Promise.all([
      this.prisma.room.groupBy({ by: ['status'], where: { businessId }, _count: true }),
      this.prisma.tenant.groupBy({ by: ['status'], where: { businessId }, _count: true }),
      this.prisma.rentalContract.groupBy({ by: ['status'], where: { businessId }, _count: true }),
      this.prisma.rentalContract.count({
        where: { businessId, status: ContractStatus.ACTIVE, endDate: { gte: new Date(), lte: expiringTo } },
      }),
      this.prisma.charge.groupBy({
        by: ['status'],
        where: { businessId, ...(range ? { createdAt: range } : {}) },
        _count: true,
        _sum: { amountDue: true, amountPaid: true },
      }),
      this.prisma.charge.groupBy({
        by: ['chargeType'],
        where: { businessId, ...(range ? { createdAt: range } : {}) },
        _count: true,
        _sum: { amountDue: true, amountPaid: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: { businessId, status: PaymentStatus.CONFIRMED, ...(range ? { paidAt: range } : {}) },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.bankTransaction.groupBy({
        by: ['classification'],
        where: { businessId, ...(range ? { transactionTime: range } : {}) },
        _count: true,
        _sum: { amount: true },
      }),
      this.prisma.paymentMatch.groupBy({ by: ['matchStatus'], where: { businessId }, _count: true }),
      this.prisma.tenantCreditActivity.aggregate({
        where: { businessId, status: TenantCreditActivityStatus.POSTED, type: TenantCreditActivityType.REFUND, ...(range ? { createdAt: range } : {}) },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.tenantCreditActivity.findMany({
        where: { businessId, status: TenantCreditActivityStatus.POSTED, type: TenantCreditActivityType.REFUND, ...(range ? { createdAt: range } : {}) },
        include: { tenant: true, room: true, sourceCharge: true, bankTransaction: true },
        take: 50,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.tenantCreditActivity.aggregate({
        where: { businessId, status: TenantCreditActivityStatus.POSTED, type: TenantCreditActivityType.APPLY_TO_CHARGE, ...(range ? { createdAt: range } : {}) },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.contractOccupant.count({ where: { businessId, status: { in: ['STAYING', 'DEPOSITED'] } } }),
      this.prisma.room.groupBy({ by: ['roomAreaId'], where: { businessId }, _count: true, _sum: { baseRentAmount: true } }),
    ]);

    return {
      rooms: {
        total: sumCounts(roomsByStatus),
        occupied: countBy(roomsByStatus, RoomStatus.OCCUPIED),
        deposited: countBy(roomsByStatus, RoomStatus.DEPOSITED),
        available: countBy(roomsByStatus, RoomStatus.AVAILABLE),
        maintenance: countBy(roomsByStatus, RoomStatus.MAINTENANCE),
        inactive: countBy(roomsByStatus, RoomStatus.INACTIVE),
        byStatus: roomsByStatus.map((item) => ({ status: item.status, label: labelRoomStatus(item.status), count: item._count })),
        byArea: roomAreaStats.map((item) => ({ roomAreaId: item.roomAreaId, count: item._count, baseRentTotal: toMoney(item._sum.baseRentAmount) })),
      },
      tenants: {
        total: sumCounts(tenantsByStatus),
        deposited: countBy(tenantsByStatus, TenantStatus.DEPOSITED),
        staying: countBy(tenantsByStatus, TenantStatus.STAYING),
        left: countBy(tenantsByStatus, TenantStatus.LEFT),
        occupants: occupantCount,
        byStatus: tenantsByStatus.map((item) => ({ status: item.status, label: labelTenantStatus(item.status), count: item._count })),
      },
      contracts: {
        total: sumCounts(contractsByStatus),
        active: countBy(contractsByStatus, ContractStatus.ACTIVE),
        pending: countBy(contractsByStatus, ContractStatus.PENDING),
        expired: countBy(contractsByStatus, ContractStatus.EXPIRED),
        terminated: countBy(contractsByStatus, ContractStatus.TERMINATED),
        cancelled: countBy(contractsByStatus, ContractStatus.CANCELLED),
        expiringSoon: expiringContracts,
        byStatus: contractsByStatus.map((item) => ({ status: item.status, label: labelContractStatus(item.status), count: item._count })),
      },
      charges: {
        byStatus: chargesByStatus.map((item) => ({ status: item.status, label: labelChargeStatus(item.status), count: item._count, totalDue: toMoney(item._sum.amountDue), totalPaid: toMoney(item._sum.amountPaid) })),
        byType: chargesByType.map((item) => ({ chargeType: item.chargeType, label: labelChargeType(item.chargeType), count: item._count, totalDue: toMoney(item._sum.amountDue), totalPaid: toMoney(item._sum.amountPaid) })),
      },
      payments: {
        byMethod: paymentsByMethod.map((item) => ({ method: item.method, label: labelPaymentMethod(item.method), count: item._count, total: toMoney(item._sum.amount) })),
      },
      transactions: {
        byClassification: transactionsByClassification.map((item) => ({ classification: item.classification, label: labelTransactionClassification(item.classification), count: item._count, total: toMoney(item._sum.amount) })),
        matchesByStatus: matchesByStatus.map((item) => ({ matchStatus: item.matchStatus, label: labelPaymentMatchStatus(item.matchStatus), count: item._count })),
      },
      credits: {
        refunds: { count: refunds._count, total: toMoney(refunds._sum.amount), items: refundActivities },
        applied: { count: creditsApplied._count, total: toMoney(creditsApplied._sum.amount) },
      },
    };
  }
}

function previousDateRange(range: { gte?: Date; lte?: Date }) {
  if (!range.gte || !range.lte) return undefined;
  const start = new Date(range.gte);
  const end = new Date(range.lte);
  const duration = end.getTime() - start.getTime() + 1;
  return { gte: new Date(start.getTime() - duration), lte: new Date(end.getTime() - duration) };
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function sumCounts(items: { _count: number }[]) {
  return items.reduce((sum, item) => sum + Number(item._count ?? 0), 0);
}

function countBy<T extends string>(items: ({ _count: number } & Record<string, unknown>)[], value: T) {
  const key = Object.keys(items[0] ?? {}).find((item) => item !== '_count') ?? '';
  return Number(items.find((item) => item[key] === value)?._count ?? 0);
}

function compareMetric(current: number, previous: number) {
  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    percent: previous === 0 ? (current === 0 ? 0 : 100) : (delta / previous) * 100,
  };
}

function buildPaymentTimeline(payments: { amount: unknown; paidAt: Date; charge?: { chargeType: string } | null }[]) {
  const groups = new Map<string, { label: string; collected: number; deposit: number; rent: number; other: number }>();
  for (const payment of payments) {
    const date = payment.paidAt;
    const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const group = groups.get(label) ?? { label, collected: 0, deposit: 0, rent: 0, other: 0 };
    const amount = toMoney(payment.amount);
    group.collected += amount;
    if (payment.charge?.chargeType === 'DEPOSIT') group.deposit += amount;
    else if (payment.charge?.chargeType === 'ROOM_RENT') group.rent += amount;
    else group.other += amount;
    groups.set(label, group);
  }
  return Array.from(groups.values());
}

function addReportTitle(sheet: ExcelJS.Worksheet, title: string, columnCount: number) {
  sheet.mergeCells(1, 1, 1, columnCount);
  sheet.getCell(1, 1).value = title;
  sheet.getCell(1, 1).font = { bold: true, size: 15, color: { argb: 'FF111827' } };
  sheet.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;
  sheet.addRow([`Ngày xuất báo cáo: ${formatVietnameseDateTime(new Date())}`]);
}

function styleTable(sheet: ExcelJS.Worksheet, headerRowNumber: number, columnCount: number, widths: number[]) {
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  const header = sheet.getRow(headerRowNumber);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.height = 24;
  for (let column = 1; column <= columnCount; column += 1) {
    const cell = header.getCell(column);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    cell.border = borderStyle();
  }
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.alignment = { vertical: 'middle', wrapText: true };
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = row.getCell(column);
      cell.border = borderStyle();
      if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      if (cell.value instanceof Date) cell.numFmt = 'dd/mm/yyyy hh:mm';
    }
  }
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: columnCount },
  };
}

function borderStyle() {
  return {
    top: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    left: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    bottom: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    right: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
  };
}

function formatVietnameseDateTime(date: Date) {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function labelChargeType(value: unknown) {
  const labels: Record<string, string> = {
    ROOM_RENT: 'Tiền phòng',
    DEPOSIT: 'Tiền cọc',
    ELECTRICITY: 'Tiền điện',
    WATER: 'Tiền nước',
    PARKING: 'Phí gửi xe',
    INTERNET: 'Internet',
    GARBAGE: 'Phí rác',
    CLEANING: 'Phí vệ sinh',
    DAMAGE_FEE: 'Bồi thường hư hỏng',
    OTHER: 'Khác',
  };
  return labels[String(value ?? 'OTHER')] ?? String(value ?? '');
}

function labelRoomStatus(value: unknown) {
  const labels: Record<string, string> = {
    AVAILABLE: 'Phòng trống',
    DEPOSITED: 'Đang cọc',
    OCCUPIED: 'Đang thuê',
    MAINTENANCE: 'Bảo trì',
    INACTIVE: 'Ngưng sử dụng',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelTenantStatus(value: unknown) {
  const labels: Record<string, string> = {
    DEPOSITED: 'Đã đặt cọc',
    STAYING: 'Đang ở',
    LEFT: 'Đã rời đi',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelContractStatus(value: unknown) {
  const labels: Record<string, string> = {
    PENDING: 'Chờ kích hoạt',
    ACTIVE: 'Hiệu lực',
    EXPIRED: 'Hết hạn',
    CANCELLED: 'Đã hủy',
    TERMINATED: 'Đã kết thúc',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelChargeStatus(value: unknown) {
  const labels: Record<string, string> = {
    UNPAID: 'Chưa thanh toán',
    PARTIAL: 'Thanh toán một phần',
    PAID: 'Đã thanh toán',
    OVERPAID: 'Thu vượt',
    CANCELLED: 'Đã hủy',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelPaymentMethod(value: unknown) {
  const labels: Record<string, string> = {
    CASH: 'Tiền mặt',
    BANK_TRANSFER: 'Chuyển khoản',
    CREDIT: 'Cấn trừ tiền dư',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelPaymentStatus(value: unknown) {
  const labels: Record<string, string> = {
    CONFIRMED: 'Đã xác nhận',
    CANCELLED: 'Đã hủy',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelPaymentCycle(value: unknown) {
  const labels: Record<string, string> = {
    MONTHLY: 'Hàng tháng',
    QUARTERLY: 'Hàng quý',
    CUSTOM: 'Tùy chỉnh',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelCreditActivityType(value: unknown) {
  const labels: Record<string, string> = {
    REFUND: 'Hoàn tiền',
    APPLY_TO_CHARGE: 'Cấn trừ khoản thu',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelRefundMethod(value: unknown) {
  const labels: Record<string, string> = {
    CASH: 'Tiền mặt',
    BANK_TRANSFER: 'Chuyển khoản',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function labelTransactionClassification(value: unknown) {
  const labels: Record<string, string> = {
    RENT_MATCHED: 'Đã khớp khoản thu',
    SUSPICIOUS: 'Cần rà soát',
    OTHER: 'Giao dịch khác',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}

function summarizeMatchStatus(matches: unknown) {
  if (!Array.isArray(matches) || !matches.length) return 'Chưa có kết quả';
  const labels: Record<string, string> = {
    AUTO_MATCHED: 'Tự động khớp',
    MANUAL_MATCHED: 'Khớp thủ công',
    NEEDS_REVIEW: 'Cần rà soát',
    REJECTED: 'Đã từ chối',
    IGNORED: 'Không xử lý',
  };
  return matches.map((match: any) => labels[String(match?.matchStatus ?? '')] ?? String(match?.matchStatus ?? '')).filter(Boolean).join(', ');
}

function labelPaymentMatchStatus(value: unknown) {
  const labels: Record<string, string> = {
    AUTO_MATCHED: 'Tự động khớp',
    MANUAL_MATCHED: 'Khớp thủ công',
    NEEDS_REVIEW: 'Cần rà soát',
    REJECTED: 'Đã từ chối',
    IGNORED: 'Không xử lý',
  };
  return labels[String(value ?? '')] ?? String(value ?? '');
}
