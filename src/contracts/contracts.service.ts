import { BadRequestException, Injectable } from '@nestjs/common';
import { ContractStatus, OccupantStatus, OccupantType, RoomStatus, TenantStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const PHONE_PATTERN = /^0\d{9}$/;
const IDENTITY_NUMBER_PATTERN = /^\d{12}$/;

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
      include: { room: true, representativeTenant: true, contractRooms: { include: { room: true } }, occupants: true },
    });
  }

  async getContract(user: AuthUser, id: string) {
    await this.syncEffectiveActiveContracts(user);
    return this.get('rentalContract', user, id, { room: true, contractRooms: { include: { room: true } }, representativeTenant: true, occupants: true });
  }

  async createContract(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const status = this.normalizeContractStatus(body.status ?? ContractStatus.ACTIVE);
    const startDate = this.normalizeDate(body.startDate, 'Start date is required');
    this.assertContractDateRange(startDate, body.endDate);
    const endDate = body.endDate ? new Date(body.endDate) : null;
    const roomIds = this.normalizeRoomIds(body.roomIds ?? body.roomId);
    const rooms = await this.getRoomsForActiveContract(businessId, roomIds, status);
    const representativeData = this.normalizeRepresentative(body.tenant ?? body.representativeTenant ?? body);
    const occupants = this.normalizeOccupants(body.occupants ?? body.roommates ?? [], startDate);
    this.assertOccupantCapacity(rooms, occupants);
    const effective = isEffectiveActiveContract(status, startDate);
    const rentAmount = body.rentAmount ?? sumMoney(rooms.map((room) => room.baseRentAmount));
    const depositAmount = body.depositAmount ?? sumMoney(rooms.map((room) => room.depositAmount ?? 0));
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
    const contract = await this.get('rentalContract', user, id, { occupants: true, room: true, contractRooms: { include: { room: true } }, representativeTenant: true });
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

  terminate(user: AuthUser, id: string) {
    return this.closeContract(user, id, ContractStatus.TERMINATED, new Date(), 'TERMINATE_CONTRACT');
  }

  expire(user: AuthUser, id: string) {
    return this.closeContract(user, id, ContractStatus.EXPIRED, new Date(), 'EXPIRE_CONTRACT');
  }

  cancel(user: AuthUser, id: string) {
    return this.closeContract(user, id, ContractStatus.CANCELLED, new Date(), 'CANCEL_CONTRACT');
  }

  async transferRoom(user: AuthUser, id: string, body: any) {
    const businessId = requireBusinessId(user);
    if (!body.newRoomId) throw new BadRequestException('newRoomId is required');
    const transferDate = body.transferDate ? new Date(body.transferDate) : new Date();
    if (Number.isNaN(transferDate.getTime())) throw new BadRequestException('Invalid transferDate');

    const oldContract = await this.prisma.rentalContract.findFirst({
      where: { id, businessId },
      include: { occupants: true, room: true, contractRooms: { include: { room: true } } },
    });
    if (!oldContract) throw new BadRequestException('Contract not found');
    if (oldContract.status !== ContractStatus.ACTIVE) throw new BadRequestException('Only ACTIVE contracts can be transferred');

    const newRoom = await this.getRoomForActiveContract(businessId, body.newRoomId, ContractStatus.ACTIVE);
    const representativeTenantId = body.representativeTenantId ?? oldContract.representativeTenantId;
    await this.requireRepresentative(businessId, representativeTenantId);

    const stayingOccupants = oldContract.occupants.filter((occupant) => occupant.status !== OccupantStatus.LEFT);
    const occupantIds = Array.isArray(body.occupantIds) ? body.occupantIds.map((item: unknown) => String(item)) : stayingOccupants.map((occupant) => occupant.id);
    const transferredOccupants = stayingOccupants.filter((occupant) => occupantIds.includes(occupant.id));
    if (transferredOccupants.length !== new Set(occupantIds).size) throw new BadRequestException('Transferred occupants must belong to the current active contract');
    this.assertOccupantCapacity(newRoom, transferredOccupants.map((occupant) => ({ ...occupant, roomId: body.newRoomId })));

    const result = await this.prisma.$transaction(async (tx) => {
      const terminated = await tx.rentalContract.update({
        where: { id },
        data: { status: ContractStatus.TERMINATED, endDate: transferDate, note: body.note ?? oldContract.note },
      });
      await tx.contractOccupant.updateMany({
        where: { contractId: id, status: { not: OccupantStatus.LEFT } },
        data: { status: OccupantStatus.LEFT, moveOutDate: transferDate },
      });
      const oldRoomIds = oldContract.contractRooms.length ? oldContract.contractRooms.map((item) => item.roomId) : [oldContract.roomId];
      for (const roomId of oldRoomIds) {
        const otherOldRoomActive = await tx.rentalContractRoom.findFirst({
          where: { roomId, contract: { businessId, status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] }, id: { not: id } } },
        });
        if (!otherOldRoomActive) await tx.room.update({ where: { id: roomId }, data: { status: RoomStatus.AVAILABLE, currentOccupantCount: 0 } });
      }

      const created = await tx.rentalContract.create({
        data: {
          businessId,
          roomId: body.newRoomId,
          representativeTenantId,
          startDate: transferDate,
          rentAmount: body.rentAmount ?? newRoom.baseRentAmount,
          depositAmount: body.depositAmount ?? newRoom.depositAmount ?? 0,
          paymentCycle: body.paymentCycle ?? oldContract.paymentCycle,
          paymentDueDay: Number(body.paymentDueDay ?? oldContract.paymentDueDay),
          status: ContractStatus.ACTIVE,
          note: body.note,
        },
      });
      await tx.rentalContractRoom.create({ data: { businessId, contractId: created.id, roomId: body.newRoomId } });
      const transferEffective = isEffectiveActiveContract(ContractStatus.ACTIVE, transferDate);
      await this.createOccupants(tx, businessId, created.id, body.newRoomId, transferredOccupants.map((occupant) => ({
        fullName: occupant.fullName,
        phone: occupant.phone,
        identityNumber: occupant.identityNumber,
        dateOfBirth: occupant.dateOfBirth,
        permanentAddress: occupant.permanentAddress,
        occupantType: occupant.occupantType,
        relationship: occupant.relationship,
        roomId: body.newRoomId,
        moveInDate: transferDate,
      })), transferEffective ? OccupantStatus.STAYING : OccupantStatus.DEPOSITED);
      await tx.room.update({ where: { id: body.newRoomId }, data: { status: RoomStatus.OCCUPIED, currentOccupantCount: transferEffective ? 1 + transferredOccupants.length : 0 } });
      await tx.tenant.update({ where: { id: representativeTenantId }, data: { status: transferEffective ? TenantStatus.STAYING : TenantStatus.DEPOSITED } });
      if (oldContract.representativeTenantId !== representativeTenantId) await this.markRepresentativeLeftIfNoActiveContract(tx, businessId, oldContract.representativeTenantId, id);

      const oldRoom = await tx.room.findUnique({ where: { id: oldContract.roomId } });
      const updatedNewRoom = await tx.room.findUnique({ where: { id: body.newRoomId } });
      return { oldContract: terminated, newContract: created, oldRoom, newRoom: updatedNewRoom, transferredOccupantIds: transferredOccupants.map((occupant) => occupant.id) };
    });

    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({
      businessId,
      userId: user.sub,
      action: 'TRANSFER_ROOM',
      entity: 'RentalContract',
      entityId: result.newContract.id,
      metadata: {
        oldRoomId: oldContract.roomId,
        newRoomId: body.newRoomId,
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
        oldRoom: result.oldRoom,
        newRoom: result.newRoom,
      },
    };
  }

  private async closeContract(user: AuthUser, id: string, status: ContractStatus, endDate: Date, action: string) {
    const contract = await this.get('rentalContract', user, id, { occupants: true, contractRooms: true });
    const updated = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.rentalContract.update({ where: { id }, data: { status, endDate } });
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
        dateOfBirth: occupant.dateOfBirth ? new Date(occupant.dateOfBirth) : null,
        permanentAddress: this.optionalText(occupant.permanentAddress) ?? null,
        occupantType,
        relationship: this.optionalText(occupant.relationship) ?? null,
        roomId: this.optionalText(occupant.roomId) ?? null,
        moveInDate: occupant.moveInDate ? new Date(occupant.moveInDate) : defaultMoveInDate,
      };
    });
    if (normalized.some((occupant) => occupant.occupantType === OccupantType.ADULT) && !normalized.some((occupant) => occupant.phone)) {
      throw new BadRequestException('At least one adult occupant phone is required');
    }
    return normalized;
  }

  private assertOccupantCapacity(roomOrRooms: any, occupantsOrCount: any[] | number) {
    const rooms = Array.isArray(roomOrRooms) ? roomOrRooms : [roomOrRooms];
    const occupants = Array.isArray(occupantsOrCount) ? occupantsOrCount : Array.from({ length: occupantsOrCount }, () => ({ roomId: rooms[0]?.id }));
    const roomIds = new Set(rooms.map((room) => room.id));
    for (const occupant of occupants) {
      if (occupant.roomId && !roomIds.has(occupant.roomId)) throw new BadRequestException('Occupant room must belong to the contract rooms');
    }
    if (1 + occupants.length > 10) throw new BadRequestException('Total occupants cannot exceed 10 people including representative');
    const counts = new Map<string, number>();
    for (const room of rooms) counts.set(room.id, room.id === rooms[0].id ? 1 : 0);
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

  private async updateOccupiedRooms(tx: any, rooms: any[], representativeRoomId: string, occupants: any[]) {
    const counts = new Map<string, number>();
    for (const room of rooms) counts.set(room.id, room.id === representativeRoomId ? 1 : 0);
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
        data: { status: RoomStatus.OCCUPIED, currentOccupantCount: 0 },
      });
    }
  }

  private normalizeRepresentative(input: any) {
    return {
      fullName: this.requiredText(input.fullName, 'Tenant fullName is required'),
      phone: this.requiredPhone(input.phone, 'Tenant phone is required', 'Invalid tenant phone'),
      identityNumber: this.requiredIdentityNumber(input.identityNumber),
      permanentAddress: this.requiredText(input.permanentAddress, 'Tenant permanent address is required'),
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
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
    if (active) throw new BadRequestException('Room already has an ACTIVE contract');
    if (room.status === RoomStatus.OCCUPIED && !exceptId) throw new BadRequestException('Room must be AVAILABLE');
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
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date');
    return date;
  }

  private assertContractDateRange(startDate: Date, endDateValue: unknown) {
    const today = startOfLocalDay(new Date());
    if (startOfLocalDay(startDate).getTime() < today.getTime()) {
      throw new BadRequestException('Start date must be today or later');
    }
    if (!endDateValue) return;
    const endDate = new Date(String(endDateValue));
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

  private async syncEffectiveActiveContracts(user: AuthUser) {
    const businessId = requireBusinessId(user);
    const now = new Date();
    const tomorrow = addDays(startOfLocalDay(now), 1);
    const contracts = await this.prisma.rentalContract.findMany({
      where: { businessId, status: ContractStatus.ACTIVE, startDate: { lt: tomorrow } },
      include: { occupants: true, room: true, contractRooms: { include: { room: true } }, representativeTenant: true },
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
      include: { room: true, contractRooms: { include: { room: true } } },
    });
    for (const contract of reservedContracts) {
      if (isEffectiveActiveContract(contract.status, contract.startDate)) continue;
      const rooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      if (rooms.some((room) => room.status !== RoomStatus.OCCUPIED || room.currentOccupantCount !== 0)) {
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
