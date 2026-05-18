import { BadRequestException, Injectable } from '@nestjs/common';
import { ContractStatus, RoomStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RoomsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {
    super(prisma);
  }

  list(user: AuthUser, query: any) {
    return super.listItems({
      model: 'room',
      user,
      query,
      searchFields: ['roomCode', 'name', 'floor', 'note'],
      filterFields: ['status', 'floor'],
      sortFields: ['roomCode', 'baseRentAmount', 'area', 'status', 'createdAt'],
    });
  }

  async createRoom(user: AuthUser, body: any) {
    const room = await super.create('room', user, body);
    await this.changed(user, 'CREATE_ROOM', room.id);
    return room;
  }

  async updateRoom(user: AuthUser, id: string, body: any) {
    const room = await super.update('room', user, id, body);
    await this.changed(user, 'UPDATE_ROOM', id);
    return room;
  }

  async removeRoom(user: AuthUser, id: string) {
    const activeContract = await this.prisma.rentalContract.findFirst({ where: { roomId: id, status: ContractStatus.ACTIVE } });
    if (activeContract) throw new BadRequestException('Cannot delete room with ACTIVE contract');
    const room = await super.remove('room', user, id);
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
}
