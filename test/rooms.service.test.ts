import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { RoomStatus } from '@prisma/client';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthUser } from '../src/common/decorators/current-user.decorator';
import { RoomsService } from '../src/rooms/rooms.service';

const user: AuthUser = {
  sub: 'user-1',
  role: 'BUSINESS_OWNER',
  businessId: 'business-1',
  sessionId: 'session-1',
};

function makeService(prismaOverrides: Record<string, any> = {}) {
  const prisma = {
    room: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({ id: 'room-1', ...data }),
      update: async ({ data }: any) => ({ id: 'room-1', businessId: user.businessId, ...data }),
      delete: async () => ({ id: 'room-1' }),
    },
    rentalContract: {
      findFirst: async () => null,
    },
    ...prismaOverrides,
  } as any;
  const audit = { log: async () => undefined } as any;
  const redis = { del: async () => undefined } as any;
  return new RoomsService(prisma, audit, redis);
}

describe('RoomsService', () => {
  it('creates a room code from floor/area plus room code and applies defaults', async () => {
    let createdData: any;
    const service = makeService({
      room: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          createdData = data;
          return { id: 'room-1', ...data };
        },
      },
    });

    const room = await service.createRoom(user, {
      roomCode: '101',
      floor: 'Khu A',
      baseRentAmount: 3500000,
    });

    assert.equal(room.roomCode, 'KHU-A-101');
    assert.equal(createdData.status, RoomStatus.AVAILABLE);
    assert.equal(createdData.maxOccupants, 2);
  });

  it('returns the existing room instead of leaking a unique constraint error on duplicate create', async () => {
    let createCalled = false;
    const existing = { id: 'room-existing', businessId: user.businessId, roomCode: 'A-101' };
    const service = makeService({
      room: {
        findFirst: async () => existing,
        create: async () => {
          createCalled = true;
          return {};
        },
      },
    });

    const room = await service.createRoom(user, { roomCode: '101', floor: 'A', baseRentAmount: 3500000 });

    assert.equal(room.id, existing.id);
    assert.equal((room as any).alreadyExists, true);
    assert.equal(createCalled, false);
  });

  it('treats legacy floor plus raw room code as duplicate but allows the same raw code in another floor', async () => {
    const rooms = [{ id: 'room-a-101', businessId: user.businessId, roomCode: '101', floor: 'A' }];
    const created: any[] = [];
    const service = makeService({
      room: {
        findFirst: async ({ where }: any) =>
          rooms.find((room) => {
            const matchesCode = where.OR?.some((item: any) => item.floor === undefined && item.roomCode === room.roomCode);
            const matchesLegacyFloorCode = where.OR?.some((item: any) => item.floor === room.floor && item.roomCode === room.roomCode);
            return room.businessId === where.businessId && (matchesCode || matchesLegacyFloorCode);
          }) ?? null,
        create: async ({ data }: any) => {
          created.push(data);
          return { id: 'room-created', ...data };
        },
      },
    });

    const duplicate = await service.createRoom(user, { roomCode: '101', floor: 'A', baseRentAmount: 3500000 });
    const otherFloor = await service.createRoom(user, { roomCode: '101', floor: 'B', baseRentAmount: 3500000 });

    assert.equal(duplicate.id, 'room-a-101');
    assert.equal((duplicate as any).alreadyExists, true);
    assert.equal(otherFloor.roomCode, 'B-101');
    assert.equal(created.length, 1);
  });

  it('rejects occupied status and invalid max occupants from the room API', async () => {
    const service = makeService();

    await assert.rejects(
      () => service.createRoom(user, { roomCode: '101', floor: 'A', baseRentAmount: 3500000, status: RoomStatus.OCCUPIED }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createRoom(user, { roomCode: '101', floor: 'A', baseRentAmount: 3500000, maxOccupants: 0 }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.createRoom(user, { roomCode: '101', floor: 'A', baseRentAmount: 3500000, maxOccupants: 11 }),
      BadRequestException,
    );
  });

  it('does not move an occupied room into maintenance or inactive by room status action', async () => {
    const service = makeService({
      room: {
        findFirst: async () => ({ id: 'room-1', businessId: user.businessId, roomCode: 'A-101', floor: 'A', status: RoomStatus.OCCUPIED }),
      },
      rentalContract: {
        findFirst: async () => ({ id: 'contract-1', roomId: 'room-1' }),
      },
    });

    await assert.rejects(() => service.changeStatus(user, 'room-1', RoomStatus.MAINTENANCE), BadRequestException);
    await assert.rejects(() => service.changeStatus(user, 'room-1', RoomStatus.INACTIVE), BadRequestException);
  });
});
