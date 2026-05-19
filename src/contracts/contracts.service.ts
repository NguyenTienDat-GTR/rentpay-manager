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

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'rentalContract',
      user,
      query,
      searchFields: ['note'],
      filterFields: ['status', 'roomId', 'representativeTenantId'],
      sortFields: ['startDate', 'endDate', 'rentAmount', 'status', 'createdAt'],
      include: { room: true, representativeTenant: true, occupants: true },
    });
  }

  async createContract(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const status = this.normalizeContractStatus(body.status ?? ContractStatus.ACTIVE);
    const startDate = this.normalizeDate(body.startDate, 'Start date is required');
    const room = await this.getRoomForActiveContract(businessId, body.roomId, status);
    const representative = await this.requireRepresentative(businessId, body.representativeTenantId);
    const occupants = this.normalizeOccupants(body.occupants ?? body.roommates ?? [], startDate);
    this.assertOccupantCapacity(room, occupants.length);

    const contract = await this.prisma.$transaction(async (tx) => {
      const created = await tx.rentalContract.create({
        data: {
          businessId,
          roomId: body.roomId,
          representativeTenantId: representative.id,
          startDate,
          endDate: body.endDate ? new Date(body.endDate) : null,
          rentAmount: body.rentAmount,
          depositAmount: body.depositAmount ?? 0,
          paymentCycle: body.paymentCycle ?? 'MONTHLY',
          paymentDueDay: Number(body.paymentDueDay ?? 5),
          status,
          note: body.note,
        },
      });
      await this.createOccupants(tx, businessId, created.id, body.roomId, occupants);
      if (created.status === ContractStatus.ACTIVE) {
        await tx.room.update({ where: { id: body.roomId }, data: { status: RoomStatus.OCCUPIED, currentOccupantCount: 1 + occupants.length } });
        await tx.tenant.update({ where: { id: representative.id }, data: { status: TenantStatus.STAYING } });
      }
      return created;
    });
    await this.changed(user, 'CREATE_CONTRACT', contract.id, businessId);
    return contract;
  }

  async activate(user: AuthUser, id: string) {
    const contract = await this.get('rentalContract', user, id, { occupants: true, room: true, representativeTenant: true });
    await this.assertRoomCanReceiveActiveContract(contract.businessId, contract.roomId, id);
    this.assertOccupantCapacity(contract.room, contract.occupants.filter((occupant: any) => occupant.status === OccupantStatus.STAYING).length);
    const updated = await this.prisma.$transaction(async (tx) => {
      const active = await tx.rentalContract.update({ where: { id }, data: { status: ContractStatus.ACTIVE } });
      const occupantCount = 1 + contract.occupants.filter((occupant: any) => occupant.status === OccupantStatus.STAYING).length;
      await tx.room.update({ where: { id: active.roomId }, data: { status: RoomStatus.OCCUPIED, currentOccupantCount: occupantCount } });
      await tx.tenant.update({ where: { id: active.representativeTenantId }, data: { status: TenantStatus.STAYING } });
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
      include: { occupants: true, room: true },
    });
    if (!oldContract) throw new BadRequestException('Contract not found');
    if (oldContract.status !== ContractStatus.ACTIVE) throw new BadRequestException('Only ACTIVE contracts can be transferred');

    const newRoom = await this.getRoomForActiveContract(businessId, body.newRoomId, ContractStatus.ACTIVE);
    const representativeTenantId = body.representativeTenantId ?? oldContract.representativeTenantId;
    await this.requireRepresentative(businessId, representativeTenantId);

    const stayingOccupants = oldContract.occupants.filter((occupant) => occupant.status === OccupantStatus.STAYING);
    const occupantIds = Array.isArray(body.occupantIds) ? body.occupantIds.map((item: unknown) => String(item)) : stayingOccupants.map((occupant) => occupant.id);
    const transferredOccupants = stayingOccupants.filter((occupant) => occupantIds.includes(occupant.id));
    if (transferredOccupants.length !== new Set(occupantIds).size) throw new BadRequestException('Transferred occupants must belong to the current active contract');
    this.assertOccupantCapacity(newRoom, transferredOccupants.length);

    const result = await this.prisma.$transaction(async (tx) => {
      const terminated = await tx.rentalContract.update({
        where: { id },
        data: { status: ContractStatus.TERMINATED, endDate: transferDate, note: body.note ?? oldContract.note },
      });
      await tx.contractOccupant.updateMany({
        where: { contractId: id, status: OccupantStatus.STAYING },
        data: { status: OccupantStatus.LEFT, moveOutDate: transferDate },
      });
      const otherOldRoomActive = await tx.rentalContract.findFirst({ where: { businessId, roomId: oldContract.roomId, status: ContractStatus.ACTIVE, id: { not: id } } });
      if (!otherOldRoomActive) await tx.room.update({ where: { id: oldContract.roomId }, data: { status: RoomStatus.AVAILABLE, currentOccupantCount: 0 } });

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
      await this.createOccupants(tx, businessId, created.id, body.newRoomId, transferredOccupants.map((occupant) => ({
        fullName: occupant.fullName,
        phone: occupant.phone,
        identityNumber: occupant.identityNumber,
        dateOfBirth: occupant.dateOfBirth,
        permanentAddress: occupant.permanentAddress,
        occupantType: occupant.occupantType,
        relationship: occupant.relationship,
        moveInDate: transferDate,
      })));
      await tx.room.update({ where: { id: body.newRoomId }, data: { status: RoomStatus.OCCUPIED, currentOccupantCount: 1 + transferredOccupants.length } });
      await tx.tenant.update({ where: { id: representativeTenantId }, data: { status: TenantStatus.STAYING } });
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
    const contract = await this.get('rentalContract', user, id, { occupants: true });
    const updated = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.rentalContract.update({ where: { id }, data: { status, endDate } });
      const otherActive = await tx.rentalContract.findFirst({ where: { businessId: closed.businessId, roomId: closed.roomId, status: ContractStatus.ACTIVE, id: { not: id } } });
      if (!otherActive) await tx.room.update({ where: { id: closed.roomId }, data: { status: RoomStatus.AVAILABLE, currentOccupantCount: 0 } });
      await tx.contractOccupant.updateMany({ where: { contractId: id, status: OccupantStatus.STAYING }, data: { status: OccupantStatus.LEFT, moveOutDate: endDate } });
      await this.markRepresentativeLeftIfNoActiveContract(tx, closed.businessId, closed.representativeTenantId, id);
      return closed;
    });
    await this.changed(user, action, id, contract.businessId);
    return updated;
  }

  private async createOccupants(tx: any, businessId: string, contractId: string, roomId: string, occupants: any[]) {
    for (const occupant of occupants) {
      await tx.contractOccupant.create({
        data: {
          businessId,
          contractId,
          roomId,
          fullName: occupant.fullName,
          phone: occupant.phone,
          identityNumber: occupant.identityNumber,
          dateOfBirth: occupant.dateOfBirth,
          permanentAddress: occupant.permanentAddress,
          occupantType: occupant.occupantType,
          relationship: occupant.relationship,
          moveInDate: occupant.moveInDate,
          status: OccupantStatus.STAYING,
        },
      });
    }
  }

  private normalizeOccupants(occupants: any[], defaultMoveInDate: Date) {
    if (!Array.isArray(occupants)) throw new BadRequestException('Occupants must be an array');
    if (occupants.length > 9) throw new BadRequestException('Total occupants cannot exceed 10 people including representative');
    return occupants.map((occupant) => {
      const fullName = this.requiredText(occupant.fullName, 'Occupant fullName is required');
      const occupantType = this.normalizeOccupantType(occupant.occupantType);
      const phone = this.optionalPhone(occupant.phone, 'Invalid occupant phone');
      if (occupantType === OccupantType.ADULT && !phone) throw new BadRequestException('Adult occupant phone is required');
      return {
        fullName,
        phone,
        identityNumber: this.optionalIdentityNumber(occupant.identityNumber),
        dateOfBirth: occupant.dateOfBirth ? new Date(occupant.dateOfBirth) : null,
        permanentAddress: this.optionalText(occupant.permanentAddress) ?? null,
        occupantType,
        relationship: this.optionalText(occupant.relationship) ?? null,
        moveInDate: occupant.moveInDate ? new Date(occupant.moveInDate) : defaultMoveInDate,
      };
    });
  }

  private assertOccupantCapacity(room: any, contractOccupantCount: number) {
    const total = 1 + contractOccupantCount;
    const max = Math.min(Number(room.maxOccupants ?? 10), 10);
    if (total > max) throw new BadRequestException('Total occupants exceed room max occupants');
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
    if (status === ContractStatus.ACTIVE) await this.assertRoomCanReceiveActiveContract(businessId, roomId);
    return room;
  }

  private async assertRoomCanReceiveActiveContract(businessId: string, roomId: string, exceptId?: string) {
    const room = await this.prisma.room.findFirst({ where: { id: roomId, businessId } });
    if (!room) throw new BadRequestException('Room not found');
    if (room.status !== RoomStatus.AVAILABLE) throw new BadRequestException('Room must be AVAILABLE');
    const active = await this.prisma.rentalContract.findFirst({
      where: { businessId, roomId, status: ContractStatus.ACTIVE, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (active) throw new BadRequestException('Room already has an ACTIVE contract');
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

  private async changed(user: AuthUser, action: string, id: string, businessId: string) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'RentalContract', entityId: id });
  }
}
