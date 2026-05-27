import { BadRequestException, Injectable } from '@nestjs/common';
import { BankConnectionStatus, BillingPeriodStatus, ChargeStatus, ChargeType, ContractStatus, NotificationAction, OccupantStatus, PaymentStatus } from '@prisma/client';
import QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { BillingPeriodsService } from '../billing-periods/billing-periods.service';
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
    private readonly billingPeriods: BillingPeriodsService,
  ) {
    super(prisma);
  }

  async list(user: AuthUser, query: any) {
    const { page, take, skip } = pagination(query);
    const and: Record<string, unknown>[] = [];
    const billingPeriodWhere: Record<string, number> = {};
    const billingMonth = normalizeNumberFilter(query.billingMonth);
    const billingYear = normalizeNumberFilter(query.billingYear);
    const chargeScope = normalizeChargeScope(query.chargeScope);

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
    if (chargeScope === 'DEPOSIT') and.push({ chargeType: ChargeType.DEPOSIT });
    if (chargeScope === 'PERIOD') and.push({ billingPeriodId: { not: null } });
    if (billingMonth) billingPeriodWhere.month = billingMonth;
    if (billingYear) billingPeriodWhere.year = billingYear;
    if (Object.keys(billingPeriodWhere).length && chargeScope !== 'DEPOSIT') {
      const periodFilter = { billingPeriod: { is: billingPeriodWhere } };
      and.push(chargeScope === 'PERIOD' ? periodFilter : { OR: [periodFilter, { chargeType: ChargeType.DEPOSIT }] });
    }
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

  async context(user: AuthUser, roomId?: string, billingPeriodId?: string, roomAreaId?: string) {
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
        include: { chargeItemConfigs: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
      }),
      this.connectedBankAccounts(businessId),
    ]);
    if (roomId && !room) throw new BadRequestException('Room not found');
    const [contract, eligibleRooms] = await Promise.all([
      roomId ? this.findActiveContractForRoom(businessId, roomId) : null,
      billingPeriodId ? this.findEligibleRoomsForPeriod(businessId, billingPeriodId, roomAreaId) : Promise.resolve([]),
    ]);
    const selectedPeriod = billingPeriodId
      ? await this.prisma.billingPeriod.findFirst({
          where: { id: billingPeriodId, businessId },
          include: { chargeItemConfigs: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        })
      : null;
    const [hasRoomRentCharge, skipRoomRentForDeposit] = contract && selectedPeriod
      ? await Promise.all([
          this.hasRoomRentCharge(businessId, contract.id, selectedPeriod.id),
          this.isRoomRentCoveredByPaidDeposit(businessId, contract, selectedPeriod),
        ])
      : [false, false];
    return {
      room,
      contract,
      tenants: contract ? this.currentTenantsForRoom(contract, roomId!) : [],
      openPeriods,
      selectedPeriod,
      periodChargeItemConfigs: selectedPeriod?.chargeItemConfigs ?? [],
      eligibleRooms,
      connectedBankAccounts,
      defaultBankAccount: connectedBankAccounts.find((account) => account.isDefault) ?? connectedBankAccounts[0] ?? null,
      hasRoomRentCharge,
      skipRoomRentForDeposit,
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
              periodItemConfigId: item.periodItemConfigId,
              chargeType: item.chargeType,
              title: item.title,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              unitLabel: item.unitLabel,
              amount: item.amount,
              note: item.note,
            })),
          },
        },
        include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true, bankAccount: true, items: true },
      }),
    );
    await this.changed(user, 'CREATE_CHARGE', charge.id, businessId);
    await this.billingPeriods.autoLockIfNoUnpaidCharges(charge.billingPeriodId);
    return this.tenantCredits.enrichCharge(charge);
  }

  private async findEligibleRoomsForPeriod(businessId: string, billingPeriodId: string, roomAreaId?: string) {
    const todayStart = startOfLocalDay(new Date());
    const contracts = await this.prisma.rentalContract.findMany({
      where: {
        businessId,
        status: ContractStatus.ACTIVE,
        OR: [{ endDate: null }, { endDate: { gte: todayStart } }],
      },
      include: {
        room: { include: { roomArea: true } },
        contractRooms: { include: { room: { include: { roomArea: true } } } },
      },
      orderBy: { startDate: 'desc' },
    });
    const existingCharges = await this.prisma.charge.findMany({
      where: { businessId, billingPeriodId, status: { not: ChargeStatus.CANCELLED } },
      select: { roomId: true },
    });
    const chargedRoomIds = new Set(existingCharges.map((charge) => charge.roomId));
    const rooms = new Map<string, any>();
    for (const contract of contracts) {
      const contractRooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      for (const room of contractRooms) {
        if (roomAreaId && room.roomAreaId !== roomAreaId) continue;
        if (chargedRoomIds.has(room.id)) continue;
        if (rooms.has(room.id)) continue;
        rooms.set(room.id, {
          ...room,
          activeContractId: contract.id,
          representativeTenantId: contract.representativeTenantId,
          rentAmount: contract.rentAmount,
        });
      }
    }
    return Array.from(rooms.values()).sort((left, right) => String(left.roomCode).localeCompare(String(right.roomCode)));
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
                periodItemConfigId: item.periodItemConfigId,
                chargeType: item.chargeType,
                title: item.title,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                unitLabel: item.unitLabel,
                amount: item.amount,
                note: item.note,
              })),
            },
          },
          include: { room: { include: { roomArea: true } }, payerTenant: true, billingPeriod: true, bankAccount: true, items: true },
        });
      });
      await this.changed(user, 'UPDATE_CHARGE', id, updated.businessId);
      await this.billingPeriods.autoLockIfNoUnpaidCharges(updated.billingPeriodId);
      return this.tenantCredits.enrichCharge(updated);
    }
    const updated = await super.update('charge', user, id, body);
    await this.changed(user, 'UPDATE_CHARGE', id, updated.businessId);
    await this.billingPeriods.autoLockIfNoUnpaidCharges(updated.billingPeriodId);
    return this.tenantCredits.enrichCharge(updated);
  }

  private async normalizeChargeInput(businessId: string, body: any) {
    const roomId = requiredText(body.roomId, 'Room is required');
    const room = await this.prisma.room.findFirst({ where: { id: roomId, businessId } });
    if (!room) throw new BadRequestException('Room not found');
    const billingPeriodId = requiredText(body.billingPeriodId, 'Billing period is required');
    const period = await this.prisma.billingPeriod.findFirst({
      where: { id: billingPeriodId, businessId },
      include: { chargeItemConfigs: true },
    });
    if (!period) throw new BadRequestException('Billing period not found');
    if (period.status !== BillingPeriodStatus.OPEN) throw new BadRequestException('Billing period must be open');
    const rawItems = Array.isArray(body.items) && body.items.length ? body.items : [{ chargeType: body.chargeType, title: body.title, amount: body.amountDue }];
    const hasRoomRent = rawItems.some((item: any) => (item.chargeType ?? item.code) === ChargeType.ROOM_RENT);
    const contract = await this.resolveContract(businessId, roomId, body.contractId, hasRoomRent);
    if (hasRoomRent && contract && await this.isRoomRentCoveredByPaidDeposit(businessId, contract, period)) {
      throw new BadRequestException('Room rent is covered by paid deposit for this billing period');
    }
    const items = this.normalizeChargeItems(rawItems, period.chargeItemConfigs, contract);
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
      dueDate: body.dueDate ? new Date(body.dueDate) : defaultDueDateFromContractPeriod(contract, period),
      items,
    };
  }

  private normalizeChargeItems(value: any[], periodConfigs: any[], contract: any | null) {
    if (!Array.isArray(value) || !value.length) throw new BadRequestException('At least one charge item is required');
    const configsById = new Map(periodConfigs.map((config) => [config.id, config]));
    const configsByCode = new Map(periodConfigs.map((config) => [config.code, config]));
    return value.map((item, index) => {
      const config = item.periodItemConfigId
        ? configsById.get(String(item.periodItemConfigId))
        : item.code
          ? configsByCode.get(normalizeConfigCode(item.code))
          : undefined;
      if (item.periodItemConfigId && !config) throw new BadRequestException(`Billing period charge item config not found at item ${index + 1}`);
      const rawChargeType = item.chargeType ?? config?.code ?? item.code;
      const chargeType = normalizeChargeType(rawChargeType);
      if (!Object.values(ChargeType).includes(chargeType)) throw new BadRequestException(`Invalid charge type at item ${index + 1}`);
      const amountFallback = item.amount ?? item.amountDue;
      const quantity =
        item.quantity === undefined || item.quantity === ''
          ? amountFallback !== undefined && !item.unitPrice && !item.price
            ? 1
            : NaN
          : Number(String(item.quantity).replace(',', '.'));
      const unitPrice =
        chargeType === ChargeType.ROOM_RENT && contract?.rentAmount != null
          ? Number(contract.rentAmount)
          : config
            ? Number(config.unitPrice)
            : Number(item.unitPrice ?? item.price ?? amountFallback);
      const amount = roundMoney(quantity * unitPrice);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException(`Quantity is required at item ${index + 1}`);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new BadRequestException(`Unit price is required at item ${index + 1}`);
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException(`Invalid amount at item ${index + 1}`);
      return {
        periodItemConfigId: config?.id ?? null,
        chargeType,
        title: optionalText(item.title) ?? config?.title ?? displayChargeType(chargeType),
        quantity,
        unitPrice,
        unitLabel: optionalText(item.unitLabel) ?? config?.unitLabel ?? (chargeType === ChargeType.ROOM_RENT ? 'ky' : null),
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

  private async isRoomRentCoveredByPaidDeposit(businessId: string, contract: any, period: any) {
    const depositMonths = Number(contract?.depositMonths ?? 1);
    const depositAmount = Number(contract?.depositAmount ?? 0);
    if (!contract?.id || !contract?.startDate || !period || depositMonths < 1 || depositAmount <= 0) return false;
    if (!billingPeriodCoveredByDeposit(contract.startDate, depositMonths, period)) return false;
    const paidDepositCharge = await this.prisma.charge.findFirst({
      where: {
        businessId,
        contractId: contract.id,
        chargeType: ChargeType.DEPOSIT,
        status: { in: [ChargeStatus.PAID, ChargeStatus.OVERPAID] },
      },
      select: { id: true },
    });
    return Boolean(paidDepositCharge);
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
    await this.billingPeriods.autoLockIfNoUnpaidCharges(updated.billingPeriodId);
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

function normalizeChargeScope(value: unknown) {
  return value === 'DEPOSIT' || value === 'PERIOD' ? value : undefined;
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

function normalizeConfigCode(value: unknown) {
  const text = optionalText(value);
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeChargeType(value: unknown) {
  const code = normalizeConfigCode(value);
  if (Object.values(ChargeType).includes(code as ChargeType)) return code as ChargeType;
  return ChargeType.OTHER;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function billingPeriodCoveredByDeposit(startDateValue: Date, depositMonths: number, period: any) {
  const startDate = new Date(startDateValue);
  if (Number.isNaN(startDate.getTime())) return false;
  const periodStart = period?.startDate ? new Date(period.startDate) : null;
  const periodEnd = period?.endDate ? new Date(period.endDate) : null;
  if (periodStart && periodEnd && !Number.isNaN(periodStart.getTime()) && !Number.isNaN(periodEnd.getTime())) {
    const selectedIndex = periodStart.getFullYear() * 12 + periodStart.getMonth();
    const firstCoveredIndex =
      periodStart.getTime() <= startDate.getTime() && startDate.getTime() <= periodEnd.getTime()
        ? selectedIndex
        : startDate.getFullYear() * 12 + startDate.getMonth();
    return selectedIndex >= firstCoveredIndex && selectedIndex < firstCoveredIndex + depositMonths;
  }
  const month = Number(period?.month);
  const year = Number(period?.year);
  if (!Number.isInteger(month) || !Number.isInteger(year)) return false;
  const startMonthIndex = startDate.getFullYear() * 12 + startDate.getMonth();
  const periodMonthIndex = year * 12 + (month - 1);
  return periodMonthIndex >= startMonthIndex && periodMonthIndex < startMonthIndex + depositMonths;
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function defaultDueDateFromContractPeriod(contract: any | null, period: { startDate: Date } | null) {
  if (!contract?.paymentDueDay || !period?.startDate) return null;
  const startDate = new Date(period.startDate);
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const dueDay = Math.min(Math.max(Number(contract.paymentDueDay), 1), lastDay);
  return new Date(year, month, dueDay);
}
