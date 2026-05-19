import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ContractStatus, Prisma, RoomStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { orderBy, pagination } from '../common/utils/list-query';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RoomsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    if (query.availableForContract === 'true' || query.availableForContract === true) return this.listAvailableForContract(user, query);
    return super.listItems({
      model: 'room',
      user,
      query,
      searchFields: ['roomCode', 'name', 'floor', 'note'],
      filterFields: ['status', 'floor'],
      sortFields: ['roomCode', 'baseRentAmount', 'area', 'status', 'currentOccupantCount', 'createdAt'],
    });
  }

  private async listAvailableForContract(user: AuthUser, query: any) {
    const businessId = requireBusinessId(user);
    const { page, take, skip } = pagination(query);
    const where: Prisma.RoomWhereInput = {
      businessId,
      status: RoomStatus.AVAILABLE,
      contractRooms: {
        none: {
          contract: { status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] } },
        },
      },
      ...(query.floor ? { floor: String(query.floor) } : {}),
      ...(query.search
        ? {
            OR: [
              { roomCode: containsInsensitive(query.search) },
              { name: containsInsensitive(query.search) },
              { floor: containsInsensitive(query.search) },
              { note: containsInsensitive(query.search) },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.room.findMany({
        where,
        skip,
        take,
        orderBy: orderBy(query, ['roomCode', 'baseRentAmount', 'area', 'status', 'currentOccupantCount', 'createdAt'], 'roomCode'),
      }),
      this.prisma.room.count({ where }),
    ]);
    return { items, meta: { page, take, total, pages: Math.ceil(total / take) } };
  }

  async createRoom(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const data = this.normalizeCreateData(body, businessId);
    const duplicate = await this.findDuplicateRoom(businessId, data.roomCode, data.floor, body.roomCode);
    if (duplicate) return { ...duplicate, alreadyExists: true };
    const room = await this.createRoomRecord(data);
    await this.changed(user, 'CREATE_ROOM', room.id);
    return room;
  }

  async updateRoom(user: AuthUser, id: string, body: any) {
    const current = await this.get('room', user, id);
    const data = this.normalizeUpdateData(body, current);
    await this.assertAllowedStatusChange(current, data.status);
    if (data.roomCode && data.roomCode !== current.roomCode) {
      const duplicate = await this.findDuplicateRoom(current.businessId, data.roomCode, data.floor ?? current.floor, body.roomCode ?? current.roomCode, id);
      if (duplicate) throw new ConflictException('Room code already exists in this floor/area');
    }
    const room = await this.prisma.room.update({ where: { id }, data });
    await this.changed(user, 'UPDATE_ROOM', id);
    return room;
  }

  async removeRoom(user: AuthUser, id: string) {
    const room = await this.get('room', user, id);
    if (room.status === RoomStatus.OCCUPIED) throw new BadRequestException('Cannot delete an occupied room');
    const activeContract = await this.findReservedContractForRoom(id);
    if (activeContract) throw new BadRequestException('Cannot delete room with PENDING or ACTIVE contract');
    await this.prisma.room.delete({ where: { id } });
    await this.changed(user, 'DELETE_ROOM', id);
    return room;
  }

  async changeStatus(user: AuthUser, id: string, status: RoomStatus) {
    return this.updateRoom(user, id, { status });
  }

  private async changed(user: AuthUser, action: string, id: string) {
    if (user.businessId) await this.redis.del(`dashboard:${user.businessId}:*`);
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action, entity: 'Room', entityId: id });
  }

  private normalizeCreateData(body: any, businessId: string) {
    this.assertValidRoomOccupancy(body.maxOccupants);
    this.assertRoomStatusCanBeSetByRoomApi(body.status);
    return {
      businessId,
      roomCode: buildRoomCode(body.roomCode, body.floor),
      name: body.name,
      floor: trimOptional(body.floor),
      area: body.area,
      baseRentAmount: body.baseRentAmount,
      depositAmount: body.depositAmount,
      maxOccupants: body.maxOccupants == null || body.maxOccupants === '' ? 10 : Number(body.maxOccupants),
      currentOccupantCount: 0,
      status: body.status ?? RoomStatus.AVAILABLE,
      note: body.note,
    };
  }

  private normalizeUpdateData(body: any, current: any) {
    this.assertValidRoomOccupancy(body.maxOccupants);
    this.assertRoomStatusCanBeSetByRoomApi(body.status);
    const data = { ...body };
    delete data.businessId;
    const nextFloor = body.floor !== undefined ? body.floor : current.floor;
    if (body.roomCode !== undefined || body.floor !== undefined) data.roomCode = buildRoomCode(body.roomCode ?? current.roomCode, nextFloor);
    if (body.floor !== undefined) data.floor = trimOptional(body.floor);
    if (body.maxOccupants !== undefined && body.maxOccupants !== '') data.maxOccupants = Number(body.maxOccupants);
    if (body.maxOccupants === '') delete data.maxOccupants;
    return data;
  }

  private assertRoomStatusCanBeSetByRoomApi(status?: RoomStatus) {
    if (status === RoomStatus.OCCUPIED) throw new BadRequestException('Occupied status can only be set by an active rental contract');
  }

  private async assertAllowedStatusChange(room: any, nextStatus?: RoomStatus) {
    if (!nextStatus || nextStatus === room.status) return;
    if (room.status !== RoomStatus.OCCUPIED && nextStatus !== RoomStatus.OCCUPIED) return;
    const activeContract = await this.findReservedContractForRoom(room.id);
    if (room.status === RoomStatus.OCCUPIED || activeContract) {
      throw new BadRequestException('Cannot change an occupied room to maintenance or inactive');
    }
  }

  private assertValidRoomOccupancy(value: unknown) {
    if (value === undefined || value === null || value === '') return;
    const numberValue = Number(value);
    if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > 10) {
      throw new BadRequestException('maxOccupants must be an integer from 1 to 10');
    }
  }

  private async findDuplicateRoom(businessId: string, roomCode: string, floor: string | null, rawRoomCode: unknown, exceptId?: string) {
    const rawCode = normalizeCodePart(rawRoomCode);
    return this.prisma.room.findFirst({
      where: {
        businessId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        OR: [
          { roomCode },
          ...(floor && rawCode ? [{ floor, roomCode: rawCode }] : []),
        ],
      },
    });
  }

  private async createRoomRecord(data: any) {
    try {
      return await this.prisma.room.create({ data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const duplicate = await this.prisma.room.findFirst({ where: { businessId: data.businessId, roomCode: data.roomCode } });
        if (duplicate) return { ...duplicate, alreadyExists: true };
      }
      throw error;
    }
  }

  private async findReservedContractForRoom(roomId: string) {
    if ((this.prisma as any).rentalContractRoom?.findFirst) {
      return (this.prisma as any).rentalContractRoom.findFirst({
        where: { roomId, contract: { status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] } } },
      });
    }
    return this.prisma.rentalContract.findFirst({ where: { roomId, status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] } } });
  }
}

function buildRoomCode(roomCode: unknown, floor: unknown) {
  const roomPart = normalizeCodePart(roomCode);
  const floorPart = normalizeCodePart(floor);
  if (!roomPart) throw new BadRequestException('roomCode is required');
  if (!floorPart) throw new BadRequestException('floor or area is required');
  if (roomPart === floorPart || roomPart.startsWith(`${floorPart}-`)) return roomPart;
  return `${floorPart}-${roomPart}`;
}

function normalizeCodePart(value: unknown) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function trimOptional(value: unknown) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

function containsInsensitive(value: unknown) {
  return { contains: String(value), mode: Prisma.QueryMode.insensitive };
}
