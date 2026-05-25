import { BadRequestException, Injectable } from '@nestjs/common';
import { BankConnectionStatus, BillingPeriodStatus, ChargeStatus, ChargeType, ContractStatus, NotificationAction, OccupantStatus, PaymentStatus } from '@prisma/client';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId, scopedWhere } from '../common/utils/business-scope';
import { contains, orderBy, pagination } from '../common/utils/list-query';
import { buildTransferContent, makePaymentCode } from '../common/utils/payment-code';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TenantCreditsService } from '../tenant-credits/tenant-credits.service';

@Injectable()
export class ChargesService extends BaseCrudService {
  constructor(
    prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly tenantCredits: TenantCreditsService,
  ) {
    super(prisma);
  }

  async list(user: AuthUser, query: any) {
    const { page, take, skip } = pagination(query);
    const and: Record<string, unknown>[] = [];
    const billingPeriodWhere: Record<string, number> = {};
    const billingMonth = normalizeNumberFilter(query.billingMonth);
    const billingYear = normalizeNumberFilter(query.billingYear);

    if (query.search) {
      const search = contains(query.search);
      and.push({
        OR: [
          ...['title', 'paymentCode', 'transferContent'].map((field) => ({ [field]: search })),
          { room: { roomCode: search } },
          { room: { roomArea: { name: search } } },
          { payerTenant: { is: { fullName: search } } },
          { payerTenant: { is: { phone: search } } },
        ],
      });
    }
    if (query.chargeType) {
      and.push({
        OR: [{ chargeType: query.chargeType }, { items: { some: { chargeType: query.chargeType } } }],
      });
    }
    if (query.status) and.push({ status: query.status });
    if (query.billingPeriodId) and.push({ billingPeriodId: query.billingPeriodId });
    if (query.roomId) and.push({ roomId: query.roomId });
    if (billingMonth) billingPeriodWhere.month = billingMonth;
    if (billingYear) billingPeriodWhere.year = billingYear;
    if (Object.keys(billingPeriodWhere).length) and.push({ billingPeriod: { is: billingPeriodWhere } });
    if (query.isOverdue === 'true') {
      and.push({ dueDate: { lt: new Date() }, status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] } });
    } else if (query.isOverdue === 'false') {
      and.push({
        OR: [
          { dueDate: null },
          { dueDate: { gte: new Date() } },
          { status: { notIn: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] } },
        ],
      });
    }

    const where = scopedWhere(user, and.length ? { AND: and } : {});
    const include = {
      room: { include: { roomArea: true } },
      payerTenant: true,
      billingPeriod: true,
      bankAccount: true,
      items: true,
      payments: {
        where: { status: { not: PaymentStatus.CANCELLED } },
        orderBy: { paidAt: 'desc' as const },
      },
    };
    const [items, total] = await Promise.all([
      this.prisma.charge.findMany({
        where,
        include,
        skip,
        take,
        orderBy: orderBy(query, ['amountDue', 'amountPaid', 'dueDate', 'status', 'createdAt']),
      }),
      this.prisma.charge.count({ where }),
    ]);

    return { items: await this.tenantCredits.enrichCharges(items), meta: { page, take, total, pages: Math.ceil(total / take) } };
  }

  async getCharge(user: AuthUser, id: string) {
    const charge = await this.get('charge', user, id, {
      room: { include: { roomArea: true } },
      payerTenant: true,
      payments: true,
      bankAccount: true,
      billingPeriod: true,
      items: true,
      sourceCreditLedgers: { include: { targetCharge: true, sourcePayment: true, bankTransaction: true, activity: { include: { ownerBankAccount: true, bankTransaction: true, creator: true } } }, orderBy: { createdAt: 'desc' } },
      targetCreditLedgers: { include: { sourceCharge: true, sourcePayment: true, activity: { include: { ownerBankAccount: true, bankTransaction: true, creator: true } } }, orderBy: { createdAt: 'desc' } },
      sourceCreditActivities: {
        include: {
          targetCharge: { include: { room: { include: { roomArea: true } }, payerTenant: true } },
          creator: { select: { id: true, fullName: true, phone: true, role: true } },
          ownerBankAccount: true,
          bankTransaction: true,
          ledgers: { include: { sourcePayment: true, targetPayment: true, bankTransaction: true }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
      },
      targetCreditActivities: {
        include: {
          sourceCharge: { include: { room: { include: { roomArea: true } }, payerTenant: true } },
          creator: { select: { id: true, fullName: true, phone: true, role: true } },
          ownerBankAccount: true,
          bankTransaction: true,
          ledgers: { include: { sourcePayment: true, targetPayment: true, bankTransaction: true }, orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
      },
    });
    return this.tenantCredits.enrichCharge(charge);
  }

  async context(user: AuthUser, roomId?: string, billingPeriodId?: string) {
    const businessId = requireBusinessId(user);
    const [room, openPeriods, connectedBankAccounts] = await Promise.all([
      roomId
        ? this.prisma.room.findFirst({
            where: { id: roomId, businessId },
            include: { roomArea: true },
          })
        : null,
      this.prisma.billingPeriod.findMany({
        where: { businessId, status: BillingPeriodStatus.OPEN },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }),
      this.connectedBankAccounts(businessId),
    ]);
    if (roomId && !room) throw new BadRequestException('Room not found');
    const contract = roomId ? await this.findActiveContractForRoom(businessId, roomId) : null;
    const hasRoomRentCharge = contract && billingPeriodId ? await this.hasRoomRentCharge(businessId, contract.id, billingPeriodId) : false;
    return {
      room,
      contract,
      tenants: contract ? this.currentTenantsForRoom(contract, roomId!) : [],
      openPeriods,
      connectedBankAccounts,
      defaultBankAccount: connectedBankAccounts.find((account) => account.isDefault) ?? connectedBankAccounts[0] ?? null,
      hasRoomRentCharge,
    };
  }

  async createCharge(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const paymentCode = await this.uniquePaymentCode();
    const normalized = await this.normalizeChargeInput(businessId, body);
    const charge = await this.prisma.$transaction(async (tx) =>
      tx.charge.create({
        data: {
          businessId,
          roomId: normalized.roomId,
          contractId: normalized.contractId,
          payerTenantId: normalized.payerTenantId,
          billingPeriodId: normalized.billingPeriodId,
          bankAccountId: normalized.bankAccountId,
          chargeType: normalized.chargeType,
          title: normalized.title,
          amountDue: normalized.amountDue,
          dueDate: normalized.dueDate,
          paymentCode,
          transferContent: buildTransferContent(normalized.chargeType, paymentCode),
          paymentLink: body.paymentLink,
          status: normalized.amountDue === 0 ? ChargeStatus.PAID : ChargeStatus.UNPAID,
          items: {
            create: normalized.items.map((item) => ({
              businessId,
              chargeType: item.chargeType,
              title: item.title,
              amount: item.amount,
              note: item.note,
            })),
          },
        },
        include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true, bankAccount: true, items: true },
      }),
    );
    await this.changed(user, 'CREATE_CHARGE', charge.id, businessId);
    return this.tenantCredits.enrichCharge(charge);
  }

  async updateCharge(user: AuthUser, id: string, body: any) {
    const current = await this.get('charge', user, id);
    if (![ChargeStatus.UNPAID, ChargeStatus.PARTIAL].includes(current.status)) {
      throw new BadRequestException('Only unpaid or partially paid charges can be updated');
    }
    delete body.paymentCode;
    delete body.transferContent;
    if (body.items !== undefined || body.amountDue !== undefined || body.chargeType !== undefined) {
      const normalized = await this.normalizeChargeInput(current.businessId, {
        id,
        ...current,
        ...body,
        items: body.items ?? [{ chargeType: body.chargeType ?? current.chargeType, title: body.title ?? current.title, amount: body.amountDue ?? current.amountDue }],
      });
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.chargeItem.deleteMany({ where: { chargeId: id } });
        return tx.charge.update({
          where: { id },
          data: {
            roomId: normalized.roomId,
            contractId: normalized.contractId,
            payerTenantId: normalized.payerTenantId,
            billingPeriodId: normalized.billingPeriodId,
            bankAccountId: normalized.bankAccountId,
            chargeType: normalized.chargeType,
            title: normalized.title,
            amountDue: normalized.amountDue,
            dueDate: normalized.dueDate,
            paymentLink: body.paymentLink,
            items: {
              create: normalized.items.map((item) => ({
                businessId: current.businessId,
                chargeType: item.chargeType,
                title: item.title,
                amount: item.amount,
                note: item.note,
              })),
            },
          },
          include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true, bankAccount: true, items: true },
        });
      });
      await this.changed(user, 'UPDATE_CHARGE', id, updated.businessId);
      return this.tenantCredits.enrichCharge(updated);
    }
    const updated = await super.update('charge', user, id, body);
    await this.changed(user, 'UPDATE_CHARGE', id, updated.businessId);
    return this.tenantCredits.enrichCharge(updated);
  }

  private async normalizeChargeInput(businessId: string, body: any) {
    const roomId = requiredText(body.roomId, 'Room is required');
    const room = await this.prisma.room.findFirst({ where: { id: roomId, businessId } });
    if (!room) throw new BadRequestException('Room not found');
    const items = this.normalizeChargeItems(body.items ?? [{ chargeType: body.chargeType, title: body.title, amount: body.amountDue }]);
    const hasRoomRent = items.some((item) => item.chargeType === ChargeType.ROOM_RENT);
    const contract = await this.resolveContract(businessId, roomId, body.contractId, hasRoomRent);
    const billingPeriodId = requiredText(body.billingPeriodId, 'Billing period is required');
    const period = await this.prisma.billingPeriod.findFirst({ where: { id: billingPeriodId, businessId } });
    if (!period) throw new BadRequestException('Billing period not found');
    if (period.status !== BillingPeriodStatus.OPEN) throw new BadRequestException('Billing period must be open');
    if (hasRoomRent && contract && billingPeriodId) await this.assertRoomRentNotDuplicated(businessId, contract.id, billingPeriodId, body.id);
    const bankAccountId = requiredText(body.bankAccountId, 'Bank account is required');
    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: {
        id: bankAccountId,
        businessId,
        status: 'ACTIVE',
        connections: { some: { status: BankConnectionStatus.CONNECTED } },
      },
    });
    if (!bankAccount) throw new BadRequestException('Connected active bank account not found');
    const amountDue = items.reduce((sum, item) => sum + item.amount, 0);
    const chargeType = items.length === 1 ? items[0].chargeType : hasRoomRent ? ChargeType.ROOM_RENT : items[0].chargeType;
    return {
      roomId,
      contractId: contract?.id ?? (body.contractId ? String(body.contractId) : null),
      payerTenantId: body.payerTenantId ? String(body.payerTenantId) : contract?.representativeTenantId ?? null,
      billingPeriodId,
      bankAccountId,
      chargeType,
      title: optionalText(body.title) ?? items.map((item) => item.title).join(', '),
      amountDue,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      items,
    };
  }

  private normalizeChargeItems(value: any[]) {
    if (!Array.isArray(value) || !value.length) throw new BadRequestException('At least one charge item is required');
    return value.map((item, index) => {
      const chargeType = item.chargeType as ChargeType;
      if (!Object.values(ChargeType).includes(chargeType)) throw new BadRequestException(`Invalid charge type at item ${index + 1}`);
      const amount = Number(item.amount ?? item.amountDue);
      if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException(`Invalid amount at item ${index + 1}`);
      return {
        chargeType,
        title: optionalText(item.title) ?? displayChargeType(chargeType),
        amount,
        note: optionalText(item.note) ?? null,
      };
    });
  }

  private async resolveContract(businessId: string, roomId: string, contractId: unknown, isRequired: boolean) {
    if (contractId) {
      const contract = await this.prisma.rentalContract.findFirst({
        where: { id: String(contractId), businessId, status: ContractStatus.ACTIVE },
      });
      if (!contract) throw new BadRequestException('Active contract not found');
      const belongsToRoom = contract.roomId === roomId || Boolean(await this.prisma.rentalContractRoom.findFirst({ where: { contractId: contract.id, roomId } }));
      if (!belongsToRoom) throw new BadRequestException('Contract does not belong to selected room');
      return contract;
    }
    const contract = await this.findActiveContractForRoom(businessId, roomId);
    if (!contract && isRequired) throw new BadRequestException('ROOM_RENT charge must be linked to an effective contract');
    return contract;
  }

  private async assertRoomRentNotDuplicated(businessId: string, contractId: string, billingPeriodId: string, exceptId?: string) {
    const exists = await this.prisma.charge.findFirst({
      where: {
        businessId,
        contractId,
        billingPeriodId,
        status: { not: ChargeStatus.CANCELLED },
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [{ chargeType: ChargeType.ROOM_RENT }, { items: { some: { chargeType: ChargeType.ROOM_RENT } } }],
      },
    });
    if (exists) throw new BadRequestException('ROOM_RENT charge already exists for this contract and billing period');
  }

  private async hasRoomRentCharge(businessId: string, contractId: string, billingPeriodId: string) {
    const exists = await this.prisma.charge.findFirst({
      where: {
        businessId,
        contractId,
        billingPeriodId,
        status: { not: ChargeStatus.CANCELLED },
        OR: [{ chargeType: ChargeType.ROOM_RENT }, { items: { some: { chargeType: ChargeType.ROOM_RENT } } }],
      },
      select: { id: true },
    });
    return Boolean(exists);
  }

  private async connectedBankAccounts(businessId: string) {
    const connections = await this.prisma.bankConnection.findMany({
      where: { businessId, status: BankConnectionStatus.CONNECTED, bankAccount: { status: 'ACTIVE' } },
      include: { bankAccount: true },
      orderBy: { createdAt: 'desc' },
    });
    const seen = new Set<string>();
    return connections.reduce<any[]>((accounts, connection) => {
      if (seen.has(connection.bankAccountId)) return accounts;
      seen.add(connection.bankAccountId);
      accounts.push(connection.bankAccount);
      return accounts;
    }, []);
  }

  private findActiveContractForRoom(businessId: string, roomId: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return this.prisma.rentalContract.findFirst({
      where: {
        businessId,
        status: ContractStatus.ACTIVE,
        OR: [{ endDate: null }, { endDate: { gte: todayStart } }],
        AND: [{ OR: [{ roomId }, { contractRooms: { some: { roomId } } }] }],
      },
      include: {
        room: { include: { roomArea: true } },
        representativeTenant: true,
        contractRooms: { include: { room: { include: { roomArea: true } } } },
        occupants: { where: { status: { not: OccupantStatus.LEFT } } },
      },
      orderBy: { startDate: 'desc' },
    });
  }

  private currentTenantsForRoom(contract: any, roomId: string) {
    const tenants: any[] = [];
    if (contract.representativeTenant) tenants.push(contract.representativeTenant);
    for (const occupant of contract.occupants ?? []) {
      if (occupant.roomId === roomId) tenants.push(occupant);
    }
    return tenants;
  }

  async cancel(user: AuthUser, id: string) {
    const current = await this.get('charge', user, id);
    if (current.status === ChargeStatus.CANCELLED) {
      throw new BadRequestException('Cancelled charges cannot be cancelled again');
    }
    if (isSettledStatus(current.status)) {
      throw new BadRequestException('Paid charges cannot be cancelled');
    }
    const updated = await super.update('charge', user, id, { status: ChargeStatus.CANCELLED });
    await this.changed(user, 'CANCEL_CHARGE', id, updated.businessId);
    return updated;
  }

  async qr(user: AuthUser, id: string) {
    const charge = await this.get('charge', user, id, { bankAccount: true, room: { include: { roomArea: true } } });
    return this.renderQr(charge, user.sub);
  }

  async renderQr(charge: any, userId?: string | null) {
    if (charge.status === ChargeStatus.CANCELLED) throw new BadRequestException('Charge was cancelled');
    if (isSettledStatus(charge.status)) throw new BadRequestException('Charge is already paid');
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

function normalizeNumberFilter(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isSettledStatus(status: ChargeStatus) {
  return status === ChargeStatus.PAID || status === ChargeStatus.OVERPAID;
}

function displayChargeType(type: ChargeType) {
  const labels: Record<ChargeType, string> = {
    ROOM_RENT: 'Tien phong',
    DEPOSIT: 'Tien coc',
    ELECTRICITY: 'Tien dien',
    WATER: 'Tien nuoc',
    PARKING: 'Gui xe',
    INTERNET: 'Internet',
    GARBAGE: 'Rac',
    CLEANING: 'Ve sinh',
    DAMAGE_FEE: 'Boi thuong',
    OTHER: 'Khac',
  };
  return labels[type] ?? String(type);
}
