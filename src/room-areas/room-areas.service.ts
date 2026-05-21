import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RoomAreasService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'roomArea',
      user,
      query,
      searchFields: ['name', 'description'],
      sortFields: ['name', 'createdAt'],
      include: { _count: { select: { rooms: true } } },
    });
  }

  async createRoomArea(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const name = requiredText(body.name, 'Room area name is required');
    try {
      const area = await this.prisma.roomArea.create({
        data: { businessId, name, description: optionalText(body.description) },
      });
      await this.audit.log({ businessId, userId: user.sub, action: 'CREATE_ROOM_AREA', entity: 'RoomArea', entityId: area.id });
      return area;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Room area already exists');
      }
      throw error;
    }
  }

  async updateRoomArea(user: AuthUser, id: string, body: any) {
    const current = await this.get('roomArea', user, id, { rooms: true });
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = requiredText(body.name, 'Room area name is required');
    if (body.description !== undefined) data.description = optionalText(body.description) ?? null;
    try {
      const targetName = String(data.name ?? current.name);
      const nextCodes = nextRoomCodesForAreaRename((current as any).rooms ?? [], current.name, targetName);
      await this.assertRoomAreaRenameIsSafe(current, targetName, nextCodes);
      const area = await this.prisma.$transaction(async (tx) => {
        const updatedArea = await tx.roomArea.update({ where: { id }, data });
        for (const [roomId, roomCode] of nextCodes) {
          const currentRoom = ((current as any).rooms ?? []).find((room: any) => room.id === roomId);
          if (currentRoom?.roomCode !== roomCode) {
            await tx.room.update({ where: { id: roomId }, data: { roomCode } });
          }
        }
        return updatedArea;
      });
      await this.audit.log({ businessId: current.businessId, userId: user.sub, action: 'UPDATE_ROOM_AREA', entity: 'RoomArea', entityId: id });
      return area;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Room area already exists');
      }
      throw error;
    }
  }

  async removeRoomArea(user: AuthUser, id: string) {
    const area = await this.get('roomArea', user, id, { _count: { select: { rooms: true } } });
    if ((area as any)._count?.rooms) throw new BadRequestException('Cannot delete a room area that still has rooms');
    await this.prisma.roomArea.delete({ where: { id } });
    await this.audit.log({ businessId: area.businessId, userId: user.sub, action: 'DELETE_ROOM_AREA', entity: 'RoomArea', entityId: id });
    return area;
  }

  private async assertRoomAreaRenameIsSafe(current: any, nextName: string, nextCodes: Map<string, string>) {
    if (nextName !== current.name) {
      const exists = await this.prisma.roomArea.findFirst({
        where: { businessId: current.businessId, id: { not: current.id }, name: nextName },
        select: { id: true },
      });
      if (exists) throw new ConflictException('Room area already exists');
    }

    const duplicatedCode = firstDuplicate(Array.from(nextCodes.values()));
    if (duplicatedCode) throw new ConflictException(`Room code ${duplicatedCode} would be duplicated after renaming this room area`);

    const roomIds = ((current.rooms ?? []) as Array<{ id: string }>).map((room) => room.id);
    const conflictingRoom = await this.prisma.room.findFirst({
      where: {
        businessId: current.businessId,
        id: { notIn: roomIds },
        roomCode: { in: Array.from(nextCodes.values()) },
      },
      include: { roomArea: true },
    });
    if (conflictingRoom) {
      throw new ConflictException(`Room code ${conflictingRoom.roomCode} already exists in ${(conflictingRoom as any).roomArea.name}`);
    }
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

function nextRoomCodesForAreaRename(rooms: Array<{ id: string; roomCode: string }>, currentName: string, nextName: string) {
  const currentPrefix = normalizeCodePart(currentName);
  const nextPrefix = normalizeCodePart(nextName);
  if (!nextPrefix) throw new BadRequestException('Room area name is required');
  return new Map(
    rooms.map((room) => {
      const currentCode = normalizeCodePart(room.roomCode);
      const suffix = currentPrefix && currentCode.startsWith(`${currentPrefix}-`) ? currentCode.slice(currentPrefix.length + 1) : roomCodeSuffix(currentCode);
      return [room.id, `${nextPrefix}-${suffix}`];
    }),
  );
}

function firstDuplicate(values: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function roomCodeSuffix(roomCode: string) {
  const parts = roomCode.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? roomCode;
}

function normalizeCodePart(value: unknown) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
