import { BadRequestException, Injectable } from '@nestjs/common';
import { ChargeStatus, ChargeType, ContractStatus, OccupantStatus, OccupantType, Prisma, RoomStatus, TenantStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { buildTransferContent, makePaymentCode } from '../common/utils/payment-code';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const PHONE_PATTERN = /^0\d{9}$/;
const IDENTITY_NUMBER_PATTERN = /^\d{12}$/;
const CONTRACT_CLOSE_REASON_CODES = new Set(['TENANT_MOVED_OUT', 'ROOM_CHANGE', 'RULE_VIOLATION', 'MUTUAL_AGREEMENT', 'LEASE_TERM_ENDED', 'OTHER']);

@Injectable()
export class ContractsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {
    super(prisma);
  }

  async list(user: AuthUser, query: any) {
    await this.syncEffectiveActiveContracts(user);
    return super.listItems({
      model: 'rentalContract',
      user,
      query,
      searchFields: ['note'],
      filterFields: ['status', 'roomId', 'representativeTenantId'],
      sortFields: ['startDate', 'endDate', 'rentAmount', 'status', 'createdAt'],
      include: { room: { include: { roomArea: true } }, representativeTenant: true, contractRooms: { include: { room: { include: { roomArea: true } } } }, occupants: true },
    });
  }

  async getContract(user: AuthUser, id: string) {
    await this.syncEffectiveActiveContracts(user);
    const contract = await this.get('rentalContract', user, id, {
      room: { include: { roomArea: true } },
      contractRooms: { include: { room: { include: { roomArea: true } } } },
      representativeTenant: true,
      occupants: true,
    });
    const roomIds = this.contractRoomIds(contract);
    const charges = await this.findContractRelatedCharges(contract.businessId, contract.id, roomIds, contract.representativeTenantId);
    return { ...contract, charges };
  }

  async createContract(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const status = this.normalizeContractStatus(body.status ?? ContractStatus.ACTIVE);
    const startDate = this.normalizeDate(body.startDate, 'Start date is required');
    this.assertContractDateRange(startDate, body.endDate);
    const endDate = this.normalizeOptionalDate(body.endDate, 'Invalid end date');
    const roomIds = this.normalizeRoomIds(body.roomIds ?? body.roomId);
    const rooms = await this.getRoomsForActiveContract(businessId, roomIds, status);
    const representativeData = this.normalizeRepresentative(body.tenant ?? body.representativeTenant ?? body);
    const occupants = this.normalizeOccupants(body.occupants ?? body.roommates ?? [], startDate);
    this.assertOccupantCapacity(rooms, occupants);
    const effective = isEffectiveActiveContract(status, startDate);
    const rentAmount = body.rentAmount ?? sumMoney(rooms.map((room) => room.baseRentAmount));
    const depositAmount = body.depositAmount ?? 0;
    const paymentDueDay = this.normalizePaymentDueDay(body.paymentDueDay ?? startDate.getDate());

    const contract = await this.prisma.$transaction(async (tx) => {
      const representative = await tx.tenant.create({
        data: {
          businessId,
          fullName: representativeData.fullName,
          phone: representativeData.phone,
          identityNumber: representativeData.identityNumber,
          permanentAddress: representativeData.permanentAddress,
          dateOfBirth: representativeData.dateOfBirth,
          note: representativeData.note,
          status: effective ? TenantStatus.STAYING : TenantStatus.DEPOSITED,
        },
      });
      const created = await tx.rentalContract.create({
        data: {
          businessId,
          roomId: roomIds[0],
          representativeTenantId: representative.id,
          startDate,
          endDate,
          rentAmount,
          depositAmount,
          paymentCycle: body.paymentCycle ?? 'MONTHLY',
          paymentDueDay,
          status,
          note: body.note,
        },
      });
      for (const roomId of roomIds) await tx.rentalContractRoom.create({ data: { businessId, contractId: created.id, roomId } });
      await this.createOccupants(tx, businessId, created.id, roomIds[0], occupants, effective ? OccupantStatus.STAYING : OccupantStatus.DEPOSITED);
      await this.createDepositChargeIfNeeded(tx, businessId, created);
      if (isRoomReservedContractStatus(created.status)) {
        if (effective) await this.updateOccupiedRooms(tx, rooms, roomIds[0], occupants);
        else await this.updateReservedRooms(tx, rooms);
      }
      return created;
    });
    await this.changed(user, 'CREATE_CONTRACT', contract.id, businessId);
    return contract;
  }

  async activate(user: AuthUser, id: string) {
    const contract = await this.get('rentalContract', user, id, { occupants: true, room: { include: { roomArea: true } }, contractRooms: { include: { room: { include: { roomArea: true } } } }, representativeTenant: true });
    const rooms = contract.contractRooms?.length ? contract.contractRooms.map((item: any) => item.room) : [contract.room];
    for (const room of rooms) await this.assertRoomCanReceiveActiveContract(contract.businessId, room.id, id);
    const activeOccupants = contract.occupants.filter((occupant: any) => occupant.status !== OccupantStatus.LEFT);
    const effective = isEffectiveActiveContract(ContractStatus.ACTIVE, contract.startDate);
    this.assertOccupantCapacity(rooms, activeOccupants);
    const updated = await this.prisma.$transaction(async (tx) => {
      const active = await tx.rentalContract.update({ where: { id }, data: { status: ContractStatus.ACTIVE } });
      await tx.contractOccupant.updateMany({
        where: { contractId: id, status: { not: OccupantStatus.LEFT } },
        data: { status: effective ? OccupantStatus.STAYING : OccupantStatus.DEPOSITED },
      });
      if (effective) await this.updateOccupiedRooms(tx, rooms, active.roomId, activeOccupants);
      else await this.updateReservedRooms(tx, rooms);
      await tx.tenant.update({ where: { id: active.representativeTenantId }, data: { status: effective ? TenantStatus.STAYING : TenantStatus.DEPOSITED } });
      return active;
    });
    await this.changed(user, 'ACTIVATE_CONTRACT', id, contract.businessId);
    return updated;
  }

  terminate(user: AuthUser, id: string, body: any = {}) {
    return this.closeContract(user, id, ContractStatus.TERMINATED, startOfLocalDay(new Date()), 'TERMINATE_CONTRACT', body, { requireReason: true });
  }

  expire(user: AuthUser, id: string, body: any = {}) {
    return this.closeContract(user, id, ContractStatus.EXPIRED, startOfLocalDay(new Date()), 'EXPIRE_CONTRACT', body, { defaultReasonCode: 'LEASE_TERM_ENDED' });
  }

  cancel(user: AuthUser, id: string, body: any = {}) {
    return this.closeContract(user, id, ContractStatus.CANCELLED, startOfLocalDay(new Date()), 'CANCEL_CONTRACT', body);
  }

  async transferRoom(user: AuthUser, id: string, body: any) {
    const businessId = requireBusinessId(user);
    const transferDate = body.transferDate ? this.normalizeDate(body.transferDate, 'Invalid transferDate') : startOfLocalDay(new Date());
    this.assertDateIsTodayOrLater(transferDate, 'Transfer date must be today or later');

    const oldContract = await this.prisma.rentalContract.findFirst({
      where: { id, businessId },
      include: { occupants: true, representativeTenant: true, room: { include: { roomArea: true } }, contractRooms: { include: { room: { include: { roomArea: true } } } } },
    });
    if (!oldContract) throw new BadRequestException('Contract not found');
    if (oldContract.status !== ContractStatus.ACTIVE) throw new BadRequestException('Only ACTIVE contracts can be transferred');

    const currentRooms: any[] = oldContract.contractRooms.length ? oldContract.contractRooms.map((item) => item.room) : [oldContract.room];
    await this.assertContractChargesClosedBeforeTransfer(businessId, id, currentRooms.map((room) => room.id), oldContract.representativeTenantId);
    const roomTransfers = this.normalizeRoomTransfers(currentRooms, body);
    const newRoomIds = roomTransfers.map((item) => item.newRoomId);
    const newRooms = await this.getRoomsForActiveContract(businessId, newRoomIds, ContractStatus.ACTIVE);
    const newContractEndDate = this.normalizeTransferEndDate(body.endDate ?? oldContract.endDate, transferDate);
    const representativeTenantId = body.representativeTenantId ?? oldContract.representativeTenantId;
    await this.requireRepresentative(businessId, representativeTenantId);

    const stayingOccupants = oldContract.occupants.filter((occupant) => occupant.status !== OccupantStatus.LEFT);
    const transferredRoomIds = new Set<string>(roomTransfers.map((item) => item.oldRoomId));
    if (transferredRoomIds.size > currentRooms.length) throw new BadRequestException('Cannot transfer more rooms than currently rented');
    const representativeMoves = transferredRoomIds.has(oldContract.roomId);
    const targetRepresentativeRoomId = representativeMoves
      ? roomTransfers.find((item) => item.oldRoomId === oldContract.roomId)?.newRoomId ?? roomTransfers[0].newRoomId
      : roomTransfers[0].newRoomId;

    const transferredOccupants = stayingOccupants
      .filter((occupant) => transferredRoomIds.has(occupant.roomId))
      .map((occupant) => {
        const transfer = roomTransfers.find((item) => item.oldRoomId === occupant.roomId);
        return {
          ...occupant,
          oldRoomId: occupant.roomId,
          roomId: transfer?.newRoomId ?? occupant.roomId,
          moveInDate: transferDate,
        };
      });

    this.assertOccupantCapacity(
      newRooms,
      transferredOccupants,
      representativeMoves ? { representativeRoomId: targetRepresentativeRoomId, countRepresentative: true } : { countRepresentative: false },
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const transferEffective = isEffectiveActiveContract(ContractStatus.ACTIVE, transferDate);
      let oldContractRecord: any = oldContract;
      const newContractReason = this.buildCloseReason({
        reasonCode: 'ROOM_CHANGE',
        reasonDetail: body.note,
        transfer: {
          oldContractId: id,
          roomTransfers,
        },
      });

      const remainingRoomIds = currentRooms.map((room) => room.id).filter((roomId) => !transferredRoomIds.has(roomId));
      if (transferEffective) {
        await tx.contractOccupant.updateMany({
          where: { contractId: id, roomId: { in: [...transferredRoomIds] }, status: { not: OccupantStatus.LEFT } },
          data: { status: OccupantStatus.LEFT, moveOutDate: transferDate },
        });

        if (!remainingRoomIds.length) {
          oldContractRecord = await tx.rentalContract.update({
            where: { id },
            data: {
              status: ContractStatus.EXPIRED,
              endDate: transferDate,
              note: body.note ?? oldContract.note,
              reason: newContractReason,
            },
          });
        } else {
          const nextPrimaryRoomId = remainingRoomIds.includes(oldContract.roomId) ? oldContract.roomId : remainingRoomIds[0];
          oldContractRecord = await tx.rentalContract.update({
            where: { id },
            data: {
              roomId: nextPrimaryRoomId,
              updatedAt: new Date(),
            },
          });
          await tx.rentalContractRoom.deleteMany({
            where: { contractId: id, roomId: { in: [...transferredRoomIds] } },
          });
        }

        for (const roomId of [...transferredRoomIds]) {
          const otherOldRoomActive = await tx.rentalContractRoom.findFirst({
            where: { roomId, contract: { businessId, status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] }, id: { not: id } } },
          });
          if (!otherOldRoomActive) await tx.room.update({ where: { id: roomId }, data: { status: RoomStatus.AVAILABLE, currentOccupantCount: 0 } });
        }
      } else {
        oldContractRecord = await tx.rentalContract.update({
          where: { id },
          data: {
            endDate: transferDate,
            note: body.note ?? oldContract.note,
            reason: newContractReason,
          },
        });
      }

      const created = await tx.rentalContract.create({
        data: {
          businessId,
          roomId: targetRepresentativeRoomId,
          representativeTenantId,
          startDate: transferDate,
          endDate: newContractEndDate,
          rentAmount: body.rentAmount ?? sumMoney(newRooms.map((room) => room.baseRentAmount)),
          depositAmount: body.depositAmount ?? 0,
          paymentCycle: body.paymentCycle ?? oldContract.paymentCycle,
          paymentDueDay: Number(body.paymentDueDay ?? oldContract.paymentDueDay),
          status: ContractStatus.ACTIVE,
          note: body.note,
        },
      });
      for (const roomTransfer of roomTransfers) {
        await tx.rentalContractRoom.create({ data: { businessId, contractId: created.id, roomId: roomTransfer.newRoomId } });
      }
      if (!transferEffective) {
        oldContractRecord = await tx.rentalContract.update({
          where: { id },
          data: { reason: { ...(newContractReason as Record<string, unknown>), transfer: { oldContractId: id, newContractId: created.id, roomTransfers } } },
        });
      }
      await this.createOccupants(
        tx,
        businessId,
        created.id,
        targetRepresentativeRoomId,
        transferredOccupants.map((occupant) => ({
          fullName: occupant.fullName,
          phone: occupant.phone,
          identityNumber: occupant.identityNumber,
          dateOfBirth: occupant.dateOfBirth,
          permanentAddress: occupant.permanentAddress,
          occupantType: occupant.occupantType,
          relationship: occupant.relationship,
          roomId: occupant.roomId,
          moveInDate: transferDate,
        })),
        transferEffective ? OccupantStatus.STAYING : OccupantStatus.DEPOSITED,
      );
      await this.createDepositChargeIfNeeded(tx, businessId, created);
      if (transferEffective) {
        await this.updateOccupiedRooms(tx, newRooms, targetRepresentativeRoomId, transferredOccupants, representativeMoves);
      } else {
        await this.updateReservedRooms(tx, newRooms);
      }
      if (transferEffective && remainingRoomIds.length) {
        const remainingRooms = currentRooms.filter((room) => remainingRoomIds.includes(room.id));
        const remainingOccupants = stayingOccupants.filter((occupant) => remainingRoomIds.includes(occupant.roomId));
        if (isEffectiveActiveContract(oldContract.status, oldContract.startDate)) {
          await this.updateOccupiedRooms(
            tx,
            remainingRooms,
            oldContractRecord.roomId,
            remainingOccupants,
            !representativeMoves,
          );
        } else {
          await this.updateReservedRooms(tx, remainingRooms);
        }
      }
      if (transferEffective) {
        await tx.tenant.update({ where: { id: representativeTenantId }, data: { status: TenantStatus.STAYING } });
      }
      if (transferEffective && !remainingRoomIds.length && oldContract.representativeTenantId !== representativeTenantId) {
        await this.markRepresentativeLeftIfNoActiveContract(tx, businessId, oldContract.representativeTenantId, id);
      }

      const oldRooms = await tx.room.findMany({ where: { id: { in: [...transferredRoomIds] } } });
      const updatedNewRooms = await tx.room.findMany({ where: { id: { in: newRoomIds } } });
      return { oldContract: oldContractRecord, newContract: created, oldRooms, newRooms: updatedNewRooms, transferredOccupantIds: transferredOccupants.map((occupant) => occupant.id) };
    });

    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({
      businessId,
      userId: user.sub,
      action: 'TRANSFER_ROOM',
      entity: 'RentalContract',
      entityId: result.newContract.id,
      metadata: {
        roomTransfers,
        oldContractId: id,
        newContractId: result.newContract.id,
        transferredOccupantIds: result.transferredOccupantIds,
      },
    });

    return {
      success: true,
      message: 'Transferred room successfully',
      data: {
        oldContract: result.oldContract,
        newContract: result.newContract,
        oldRooms: result.oldRooms,
        newRooms: result.newRooms,
      },
    };
  }

  private async closeContract(
    user: AuthUser,
    id: string,
    status: ContractStatus,
    endDate: Date,
    action: string,
    body: any = {},
    options: { requireReason?: boolean; defaultReasonCode?: string } = {},
  ) {
    const contract = await this.get('rentalContract', user, id, { occupants: true, contractRooms: true });
    const reason = this.normalizeCloseReason(body, options.defaultReasonCode, options.requireReason);
    const updated = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.rentalContract.update({
        where: { id },
        data: {
          status,
          endDate,
          note: body.note ?? contract.note,
          reason,
        },
      });
      const roomIds = contract.contractRooms?.length ? contract.contractRooms.map((item: any) => item.roomId) : [closed.roomId];
      for (const roomId of roomIds) {
        const otherActive = await tx.rentalContractRoom.findFirst({ where: { roomId, contract: { businessId: closed.businessId, status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] }, id: { not: id } } } });
        if (!otherActive) await tx.room.update({ where: { id: roomId }, data: { status: RoomStatus.AVAILABLE, currentOccupantCount: 0 } });
      }
      await tx.contractOccupant.updateMany({ where: { contractId: id, status: { not: OccupantStatus.LEFT } }, data: { status: OccupantStatus.LEFT, moveOutDate: endDate } });
      await this.markRepresentativeLeftIfNoActiveContract(tx, closed.businessId, closed.representativeTenantId, id);
      return closed;
    });
    await this.changed(user, action, id, contract.businessId);
    return updated;
  }

  private async assertContractChargesClosedBeforeTransfer(businessId: string, contractId: string, roomIds: string[], tenantId: string) {
    const openCharge = await this.prisma.charge.findFirst({
      where: {
        businessId,
        OR: this.contractRelatedChargeOr(contractId, roomIds, tenantId),
        status: { in: [ChargeStatus.UNPAID, ChargeStatus.PARTIAL] },
      },
      select: { id: true },
    });
    if (openCharge) throw new BadRequestException('Contract has open charges. Please pay or cancel them before transferring room.');
  }

  private async findContractRelatedCharges(businessId: string, contractId: string, roomIds: string[], tenantId: string) {
    return this.prisma.charge.findMany({
      where: {
        businessId,
        OR: this.contractRelatedChargeOr(contractId, roomIds, tenantId),
      },
      select: { id: true, title: true, paymentCode: true, amountDue: true, amountPaid: true, status: true, dueDate: true, roomId: true, contractId: true, payerTenantId: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private contractRelatedChargeOr(contractId: string, roomIds: string[], tenantId: string) {
    const uniqueRoomIds = Array.from(new Set(roomIds.filter(Boolean)));
    return [
      { contractId },
      ...(uniqueRoomIds.length ? [{ roomId: { in: uniqueRoomIds } }] : []),
      { payerTenantId: tenantId },
    ];
  }

  private contractRoomIds(contract: any): string[] {
    const roomIds = Array.isArray(contract.contractRooms) && contract.contractRooms.length
      ? contract.contractRooms.map((item: any) => item.roomId ?? item.room?.id)
      : [contract.roomId];
    return Array.from(new Set(roomIds.map((roomId: unknown) => String(roomId ?? '').trim()).filter(Boolean)));
  }

  private async createOccupants(tx: any, businessId: string, contractId: string, roomId: string, occupants: any[], status: OccupantStatus) {
    for (const occupant of occupants) {
      await tx.contractOccupant.create({
        data: {
          businessId,
          contractId,
          roomId: occupant.roomId ?? roomId,
          fullName: occupant.fullName,
          phone: occupant.phone,
          identityNumber: occupant.identityNumber,
          dateOfBirth: occupant.dateOfBirth,
          permanentAddress: occupant.permanentAddress,
          occupantType: occupant.occupantType,
          relationship: occupant.relationship,
          moveInDate: occupant.moveInDate,
          status,
        },
      });
    }
  }

  private normalizeRoomTransfers(currentRooms: any[], body: any) {
    const currentRoomIds = currentRooms.map((room) => String(room.id));
    const currentRoomIdSet = new Set(currentRoomIds);
    const rawTransfers = Array.isArray(body.roomTransfers)
      ? body.roomTransfers
      : Array.isArray(body.transfers)
        ? body.transfers
        : body.oldRoomId || body.newRoomId
          ? [{ oldRoomId: body.oldRoomId ?? currentRoomIds[0], newRoomId: body.newRoomId }]
          : [];

    if (!rawTransfers.length) throw new BadRequestException('At least one room must be selected for transfer');
    if (rawTransfers.length > currentRoomIds.length) throw new BadRequestException('Cannot transfer more rooms than currently rented');

    const transfers = rawTransfers.map((item: any) => ({
      oldRoomId: this.requiredText(item.oldRoomId, 'oldRoomId is required'),
      newRoomId: this.requiredText(item.newRoomId, 'newRoomId is required'),
    }));

    const oldRoomIds = transfers.map((item) => item.oldRoomId);
    const newRoomIds = transfers.map((item) => item.newRoomId);
    if (new Set(oldRoomIds).size !== oldRoomIds.length) throw new BadRequestException('Each transferred room must be selected once');
    if (new Set(newRoomIds).size !== newRoomIds.length) throw new BadRequestException('newRoomId must be unique');

    for (const transfer of transfers) {
      if (!currentRoomIdSet.has(transfer.oldRoomId)) throw new BadRequestException('oldRoomId must belong to the contract');
      if (transfer.oldRoomId === transfer.newRoomId) throw new BadRequestException('newRoomId must not match oldRoomId');
    }

    return transfers;
  }

  private normalizeCloseReason(body: any = {}, defaultReasonCode?: string, requireReason = false) {
    const rawReason = body.reason && typeof body.reason === 'object' ? body.reason : {};
    const reasonCode = this.optionalText(body.reasonCode ?? rawReason.code ?? rawReason.reasonCode ?? defaultReasonCode);
    const reasonDetail = this.optionalText(body.reasonDetail ?? rawReason.detail ?? rawReason.reasonDetail ?? body.customReason);
    if (!reasonCode) {
      if (requireReason) throw new BadRequestException('Close reason is required');
      return undefined;
    }
    return this.buildCloseReason({ reasonCode, reasonDetail });
  }

  private buildCloseReason(input: { reasonCode: unknown; reasonDetail?: unknown; transfer?: unknown }) {
    const code = String(input.reasonCode ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();
    const detail = this.optionalText(input.reasonDetail);
    if (!CONTRACT_CLOSE_REASON_CODES.has(code)) throw new BadRequestException('Contract close reason is invalid');
    if (code === 'OTHER' && !detail) throw new BadRequestException('reasonDetail is required when reason is OTHER');
    return {
      code,
      detail: detail ?? null,
      ...(input.transfer ? { transfer: input.transfer } : {}),
    };
  }

  private normalizeOccupants(occupants: any[], defaultMoveInDate: Date) {
    if (!Array.isArray(occupants)) throw new BadRequestException('Occupants must be an array');
    if (occupants.length > 9) throw new BadRequestException('Total occupants cannot exceed 10 people including representative');
    const normalized = occupants.map((occupant) => {
      const fullName = this.requiredText(occupant.fullName, 'Occupant fullName is required');
      const occupantType = this.normalizeOccupantType(occupant.occupantType);
      const phone = this.optionalPhone(occupant.phone, 'Invalid occupant phone');
      return {
        fullName,
        phone,
        identityNumber: this.optionalIdentityNumber(occupant.identityNumber),
        dateOfBirth: this.normalizeOptionalDate(occupant.dateOfBirth, 'Invalid date of birth'),
        permanentAddress: this.optionalText(occupant.permanentAddress) ?? null,
        occupantType,
        relationship: this.optionalText(occupant.relationship) ?? null,
        roomId: this.optionalText(occupant.roomId) ?? null,
        moveInDate: occupant.moveInDate ? this.normalizeDate(occupant.moveInDate, 'Invalid move in date') : defaultMoveInDate,
      };
    });
    if (normalized.some((occupant) => occupant.occupantType === OccupantType.ADULT) && !normalized.some((occupant) => occupant.phone)) {
      throw new BadRequestException('At least one adult occupant phone is required');
    }
    return normalized;
  }

  private assertOccupantCapacity(
    roomOrRooms: any,
    occupantsOrCount: any[] | number,
    options: { representativeRoomId?: string; countRepresentative?: boolean } = {},
  ) {
    const rooms = Array.isArray(roomOrRooms) ? roomOrRooms : [roomOrRooms];
    const occupants = Array.isArray(occupantsOrCount) ? occupantsOrCount : Array.from({ length: occupantsOrCount }, () => ({ roomId: rooms[0]?.id }));
    const roomIds = new Set(rooms.map((room) => room.id));
    for (const occupant of occupants) {
      if (occupant.roomId && !roomIds.has(occupant.roomId)) throw new BadRequestException('Occupant room must belong to the contract rooms');
    }
    const countRepresentative = options.countRepresentative ?? true;
    if ((countRepresentative ? 1 : 0) + occupants.length > 10) throw new BadRequestException('Total occupants cannot exceed 10 people including representative');
    const counts = new Map<string, number>();
    const representativeRoomId = options.representativeRoomId ?? rooms[0]?.id;
    for (const room of rooms) counts.set(room.id, countRepresentative && room.id === representativeRoomId ? 1 : 0);
    for (const occupant of occupants) {
      const roomId = occupant.roomId ?? rooms[0].id;
      counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
    }
    for (const room of rooms) {
      const count = counts.get(room.id) ?? 0;
      const max = Number(room.maxOccupants ?? 10);
      if (count > max) throw new BadRequestException(`Total occupants exceed max occupants for room ${room.roomCode ?? room.id}`);
    }
  }

  private async updateOccupiedRooms(tx: any, rooms: any[], representativeRoomId: string, occupants: any[], countRepresentative = true) {
    const counts = new Map<string, number>();
    for (const room of rooms) counts.set(room.id, countRepresentative && room.id === representativeRoomId ? 1 : 0);
    for (const occupant of occupants) {
      const roomId = occupant.roomId ?? representativeRoomId;
      counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
    }
    for (const room of rooms) {
      await tx.room.update({
        where: { id: room.id },
        data: { status: RoomStatus.OCCUPIED, currentOccupantCount: counts.get(room.id) ?? 0 },
      });
    }
  }

  private async updateReservedRooms(tx: any, rooms: any[]) {
    for (const room of rooms) {
      await tx.room.update({
        where: { id: room.id },
        data: { status: RoomStatus.DEPOSITED, currentOccupantCount: 0 },
      });
    }
  }

  private async createDepositChargeIfNeeded(tx: any, businessId: string, contract: any) {
    const depositAmount = Number(contract.depositAmount ?? 0);
    if (depositAmount <= 0) return null;
    const bankAccount = await tx.bankAccount.findFirst({ where: { businessId, isDefault: true, status: 'ACTIVE' } });
    if (!bankAccount) throw new BadRequestException('Default active bank account is required to create deposit charge');
    const exists = await tx.charge.findFirst({ where: { businessId, contractId: contract.id, chargeType: ChargeType.DEPOSIT } });
    if (exists) return exists;
    const paymentCode = await this.uniquePaymentCode(tx);
    return tx.charge.create({
      data: {
        businessId,
        roomId: contract.roomId,
        contractId: contract.id,
        payerTenantId: contract.representativeTenantId,
        bankAccountId: bankAccount.id,
        chargeType: ChargeType.DEPOSIT,
        title: 'Tien coc hop dong thue',
        amountDue: depositAmount,
        dueDate: contract.startDate,
        paymentCode,
        transferContent: buildTransferContent(ChargeType.DEPOSIT, paymentCode),
        items: {
          create: {
            businessId,
            chargeType: ChargeType.DEPOSIT,
            title: 'Tien coc',
            amount: depositAmount,
          },
        },
      },
    });
  }

  private normalizeRepresentative(input: any) {
    return {
      fullName: this.requiredText(input.fullName, 'Tenant fullName is required'),
      phone: this.requiredPhone(input.phone, 'Tenant phone is required', 'Invalid tenant phone'),
      identityNumber: this.requiredIdentityNumber(input.identityNumber),
      permanentAddress: this.requiredText(input.permanentAddress, 'Tenant permanent address is required'),
      dateOfBirth: this.normalizeOptionalDate(input.dateOfBirth, 'Invalid date of birth'),
      note: this.optionalText(input.note) ?? null,
    };
  }

  private async requireRepresentative(businessId: string, tenantId: string) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, businessId } });
    if (!tenant) throw new BadRequestException('Representative tenant not found');
    if (!tenant.phone) throw new BadRequestException('Representative tenant must have phone');
    if (!tenant.identityNumber) throw new BadRequestException('Representative tenant must have identity number');
    if (!tenant.permanentAddress) throw new BadRequestException('Representative tenant must have permanent address');
    return tenant;
  }

  private async markRepresentativeLeftIfNoActiveContract(tx: any, businessId: string, tenantId: string, closingContractId: string) {
    const otherActive = await tx.rentalContract.findFirst({
      where: { businessId, representativeTenantId: tenantId, status: ContractStatus.ACTIVE, id: { not: closingContractId } },
    });
    if (!otherActive) await tx.tenant.update({ where: { id: tenantId }, data: { status: TenantStatus.LEFT } });
  }

  private async getRoomForActiveContract(businessId: string, roomId: string, status: ContractStatus) {
    const room = await this.prisma.room.findFirst({ where: { id: roomId, businessId } });
    if (!room) throw new BadRequestException('Room not found');
    if (isRoomReservedContractStatus(status)) await this.assertRoomCanReceiveActiveContract(businessId, roomId);
    return room;
  }

  private normalizeRoomIds(value: unknown) {
    const raw = Array.isArray(value) ? value : [value];
    const roomIds = Array.from(new Set(raw.map((item) => String(item ?? '').trim()).filter(Boolean)));
    if (!roomIds.length) throw new BadRequestException('At least one room is required');
    return roomIds;
  }

  private async getRoomsForActiveContract(businessId: string, roomIds: string[], status: ContractStatus) {
    const rooms = await this.prisma.room.findMany({ where: { businessId, id: { in: roomIds } } });
    if (rooms.length !== roomIds.length) throw new BadRequestException('One or more rooms were not found');
    if (isRoomReservedContractStatus(status)) {
      for (const roomId of roomIds) await this.assertRoomCanReceiveActiveContract(businessId, roomId);
    }
    return roomIds.map((roomId) => rooms.find((room) => room.id === roomId)!);
  }

  private async assertRoomCanReceiveActiveContract(businessId: string, roomId: string, exceptId?: string) {
    const room = await this.prisma.room.findFirst({ where: { id: roomId, businessId } });
    if (!room) throw new BadRequestException('Room not found');
    if (room.status === RoomStatus.MAINTENANCE || room.status === RoomStatus.INACTIVE) throw new BadRequestException('Room must not be MAINTENANCE or INACTIVE');
    const active = await this.prisma.rentalContractRoom.findFirst({
      where: {
        roomId,
        contract: {
          businessId,
          status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] },
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
      },
    });
    if (active) throw new BadRequestException('Room already has a pending or active contract');
    if ((room.status === RoomStatus.OCCUPIED || room.status === RoomStatus.DEPOSITED) && !exceptId) throw new BadRequestException('Room must be AVAILABLE');
  }

  private normalizeContractStatus(value: unknown) {
    if (!Object.values(ContractStatus).includes(value as ContractStatus)) throw new BadRequestException('Invalid contract status');
    return value as ContractStatus;
  }

  private normalizeOccupantType(value: unknown) {
    if (!Object.values(OccupantType).includes(value as OccupantType)) throw new BadRequestException('Invalid occupant type');
    return value as OccupantType;
  }

  private requiredText(value: unknown, message: string) {
    const text = this.optionalText(value);
    if (!text) throw new BadRequestException(message);
    return text;
  }

  private optionalText(value: unknown) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text || undefined;
  }

  private optionalPhone(value: unknown, message: string) {
    const phone = this.optionalText(value);
    if (!phone) return null;
    if (!PHONE_PATTERN.test(phone)) throw new BadRequestException(message);
    return phone;
  }

  private requiredPhone(value: unknown, requiredMessage: string, invalidMessage: string) {
    const phone = this.optionalText(value);
    if (!phone) throw new BadRequestException(requiredMessage);
    if (!PHONE_PATTERN.test(phone)) throw new BadRequestException(invalidMessage);
    return phone;
  }

  private requiredIdentityNumber(value: unknown) {
    const identityNumber = this.requiredText(value, 'Tenant identity number is required');
    if (!IDENTITY_NUMBER_PATTERN.test(identityNumber)) throw new BadRequestException('Tenant identity number must be exactly 12 digits');
    return identityNumber;
  }

  private optionalIdentityNumber(value: unknown) {
    const identityNumber = this.optionalText(value);
    if (!identityNumber) return null;
    if (!IDENTITY_NUMBER_PATTERN.test(identityNumber)) throw new BadRequestException('Occupant identity number must be exactly 12 digits');
    return identityNumber;
  }

  private normalizeDate(value: unknown, message: string) {
    if (!value) throw new BadRequestException(message);
    const date = parseLocalDateOnly(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    return date;
  }

  private normalizeOptionalDate(value: unknown, invalidMessage: string) {
    if (!value) return null;
    const date = parseLocalDateOnly(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(invalidMessage);
    return date;
  }

  private normalizeTransferEndDate(value: unknown, startDate: Date) {
    if (!value) return null;
    const endDate = parseLocalDateOnly(value);
    if (Number.isNaN(endDate.getTime())) throw new BadRequestException('Invalid end date');
    if (startOfLocalDay(endDate).getTime() < startOfLocalDay(startDate).getTime()) {
      throw new BadRequestException('End date must be on or after start date');
    }
    return endDate;
  }

  private assertDateIsTodayOrLater(date: Date, message: string) {
    const today = startOfLocalDay(new Date());
    if (startOfLocalDay(date).getTime() < today.getTime()) throw new BadRequestException(message);
  }

  private assertContractDateRange(startDate: Date, endDateValue: unknown) {
    const today = startOfLocalDay(new Date());
    if (startOfLocalDay(startDate).getTime() < today.getTime()) {
      throw new BadRequestException('Start date must be today or later');
    }
    if (!endDateValue) return;
    const endDate = parseLocalDateOnly(endDateValue);
    if (Number.isNaN(endDate.getTime())) throw new BadRequestException('Invalid end date');
    const minimumEndDate = addMonths(startOfLocalDay(startDate), 1);
    if (startOfLocalDay(endDate).getTime() < minimumEndDate.getTime()) {
      throw new BadRequestException('End date must be at least 1 month after start date');
    }
  }

  private normalizePaymentDueDay(value: unknown) {
    const day = Number(value);
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new BadRequestException('Payment due day must be from 1 to 31');
    return day;
  }

  private async changed(user: AuthUser, action: string, id: string, businessId: string) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'RentalContract', entityId: id });
  }

  private async uniquePaymentCode(tx: any) {
    for (let i = 0; i < 10; i++) {
      const code = makePaymentCode();
      const exists = await tx.charge.findUnique({ where: { paymentCode: code } });
      if (!exists) return code;
    }
    throw new BadRequestException('Unable to generate payment code');
  }

  private async processScheduledRoomTransfers(businessId: string, beforeDate: Date) {
    const contracts = await this.prisma.rentalContract.findMany({
      where: { businessId, status: ContractStatus.ACTIVE, endDate: { lt: beforeDate } },
      include: { occupants: true, room: { include: { roomArea: true } }, contractRooms: { include: { room: { include: { roomArea: true } } } } },
    });
    for (const contract of contracts) {
      const transfer = this.scheduledRoomTransfer(contract.reason);
      if (!transfer?.roomTransfers.length) continue;
      const transferredRoomIds = new Set<string>(transfer.roomTransfers.map((item) => item.oldRoomId));
      const currentRooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      const remainingRoomIds = currentRooms.map((room) => room.id).filter((roomId) => !transferredRoomIds.has(roomId));
      const endDate = contract.endDate ?? new Date();

      await this.prisma.$transaction(async (tx) => {
        await tx.contractOccupant.updateMany({
          where: { contractId: contract.id, roomId: { in: [...transferredRoomIds] }, status: { not: OccupantStatus.LEFT } },
          data: { status: OccupantStatus.LEFT, moveOutDate: endDate },
        });

        if (!remainingRoomIds.length) {
          await tx.rentalContract.update({
            where: { id: contract.id },
            data: { status: ContractStatus.EXPIRED, endDate, reason: contract.reason as any },
          });
        } else {
          const nextPrimaryRoomId = remainingRoomIds.includes(contract.roomId) ? contract.roomId : remainingRoomIds[0];
          await tx.rentalContract.update({
            where: { id: contract.id },
            data: { roomId: nextPrimaryRoomId, endDate: null, reason: Prisma.JsonNull },
          });
          await tx.rentalContractRoom.deleteMany({
            where: { contractId: contract.id, roomId: { in: [...transferredRoomIds] } },
          });
        }

        for (const roomId of [...transferredRoomIds]) {
          const otherActive = await tx.rentalContractRoom.findFirst({
            where: { roomId, contract: { businessId, status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] }, id: { not: contract.id } } },
          });
          if (!otherActive) await tx.room.update({ where: { id: roomId }, data: { status: RoomStatus.AVAILABLE, currentOccupantCount: 0 } });
        }

        if (remainingRoomIds.length) {
          const remainingRooms = currentRooms.filter((room) => remainingRoomIds.includes(room.id));
          const remainingOccupants = contract.occupants.filter((occupant) => remainingRoomIds.includes(occupant.roomId) && occupant.status !== OccupantStatus.LEFT);
          await this.updateOccupiedRooms(tx, remainingRooms, remainingRoomIds.includes(contract.roomId) ? contract.roomId : remainingRoomIds[0], remainingOccupants, remainingRoomIds.includes(contract.roomId));
        } else {
          await this.markRepresentativeLeftIfNoActiveContract(tx, businessId, contract.representativeTenantId, contract.id);
        }
      });
    }
  }

  private scheduledRoomTransfer(reason: unknown): { roomTransfers: Array<{ oldRoomId: string; newRoomId: string }> } | null {
    if (!reason || typeof reason !== 'object') return null;
    const payload = reason as Record<string, any>;
    if (payload.code !== 'ROOM_CHANGE') return null;
    const roomTransfers = Array.isArray(payload.transfer?.roomTransfers)
      ? payload.transfer.roomTransfers
          .map((item: any) => ({ oldRoomId: String(item.oldRoomId ?? ''), newRoomId: String(item.newRoomId ?? '') }))
          .filter((item: any) => item.oldRoomId && item.newRoomId)
      : [];
    return { roomTransfers };
  }

  private async syncEffectiveActiveContracts(user: AuthUser) {
    const businessId = requireBusinessId(user);
    const now = new Date();
    const tomorrow = addDays(startOfLocalDay(now), 1);
    await this.processScheduledRoomTransfers(businessId, tomorrow);
    const contracts = await this.prisma.rentalContract.findMany({
      where: { businessId, status: ContractStatus.ACTIVE, startDate: { lt: tomorrow } },
      include: { occupants: true, room: { include: { roomArea: true } }, contractRooms: { include: { room: { include: { roomArea: true } } } }, representativeTenant: true },
    });
    const pending = contracts.filter((contract) => {
      return contract.representativeTenant.status !== TenantStatus.STAYING || contract.occupants.some((occupant) => occupant.status === OccupantStatus.DEPOSITED);
    });
    for (const contract of pending) {
      const rooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      const activeOccupants = contract.occupants.filter((occupant) => occupant.status !== OccupantStatus.LEFT);
      await this.prisma.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id: contract.representativeTenantId }, data: { status: TenantStatus.STAYING } });
        await tx.contractOccupant.updateMany({
          where: { contractId: contract.id, status: OccupantStatus.DEPOSITED },
          data: { status: OccupantStatus.STAYING },
        });
        await this.updateOccupiedRooms(tx, rooms, contract.roomId, activeOccupants);
      });
    }

    const upcomingContracts = await this.prisma.rentalContract.findMany({
      where: { businessId, status: ContractStatus.ACTIVE, startDate: { gte: tomorrow } },
      include: { occupants: true, representativeTenant: true },
    });
    for (const contract of upcomingContracts) {
      const hasEffectiveContract = await this.prisma.rentalContract.findFirst({
        where: {
          businessId,
          representativeTenantId: contract.representativeTenantId,
          status: ContractStatus.ACTIVE,
          startDate: { lt: tomorrow },
          id: { not: contract.id },
        },
      });
      await this.prisma.$transaction(async (tx) => {
        if (!hasEffectiveContract && contract.representativeTenant.status === TenantStatus.STAYING) {
          await tx.tenant.update({ where: { id: contract.representativeTenantId }, data: { status: TenantStatus.DEPOSITED } });
        }
        await tx.contractOccupant.updateMany({
          where: { contractId: contract.id, status: OccupantStatus.STAYING },
          data: { status: OccupantStatus.DEPOSITED },
        });
      });
    }

    const reservedContracts = await this.prisma.rentalContract.findMany({
      where: { businessId, status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] } },
      include: { room: { include: { roomArea: true } }, contractRooms: { include: { room: { include: { roomArea: true } } } } },
    });
    for (const contract of reservedContracts) {
      if (isEffectiveActiveContract(contract.status, contract.startDate)) continue;
      const rooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      if (rooms.some((room) => room.status !== RoomStatus.DEPOSITED || room.currentOccupantCount !== 0)) {
        await this.prisma.$transaction((tx) => this.updateReservedRooms(tx, rooms));
      }
    }
  }
}

function sumMoney(values: any[]) {
  return values.reduce((sum, value) => sum + Number(value ?? 0), 0);
}

function isEffectiveActiveContract(status: ContractStatus, startDate: Date) {
  return status === ContractStatus.ACTIVE && startOfLocalDay(startDate).getTime() <= startOfLocalDay(new Date()).getTime();
}

function isRoomReservedContractStatus(status: ContractStatus) {
  return status === ContractStatus.PENDING || status === ContractStatus.ACTIVE;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLocalDateOnly(value: unknown) {
  if (value instanceof Date) return startOfLocalDay(value);
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? date : startOfLocalDay(date);
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
