import { BadRequestException, Injectable } from '@nestjs/common';
import { ContractStatus, OccupantRole, OccupantStatus, RoomStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { requireBusinessId } from '../common/utils/business-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

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
      filterFields: ['status', 'roomId'],
      sortFields: ['startDate', 'endDate', 'rentAmount', 'status', 'createdAt'],
      include: { room: true, representativeTenant: true },
    });
  }

  async createContract(user: AuthUser, body: any) {
    const businessId = requireBusinessId(user, body.businessId);
    const representative = await this.prisma.tenant.findFirst({ where: { id: body.representativeTenantId, businessId } });
    if (!representative?.phone) throw new BadRequestException('Representative tenant must have phone');
    if (body.status === ContractStatus.ACTIVE) await this.assertNoActiveRoomContract(businessId, body.roomId);

    const contract = await this.prisma.$transaction(async (tx) => {
      const created = await tx.rentalContract.create({
        data: {
          businessId,
          roomId: body.roomId,
          representativeTenantId: body.representativeTenantId,
          startDate: new Date(body.startDate),
          endDate: body.endDate ? new Date(body.endDate) : null,
          rentAmount: body.rentAmount,
          depositAmount: body.depositAmount ?? 0,
          paymentCycle: body.paymentCycle ?? 'MONTHLY',
          paymentDueDay: Number(body.paymentDueDay ?? 5),
          status: body.status ?? ContractStatus.PENDING,
          note: body.note,
        },
      });
      await tx.contractOccupant.create({
        data: {
          businessId,
          contractId: created.id,
          roomId: body.roomId,
          tenantId: body.representativeTenantId,
          role: OccupantRole.REPRESENTATIVE,
          moveInDate: new Date(body.startDate),
          status: OccupantStatus.STAYING,
        },
      });
      for (const occupant of body.roommates ?? []) {
        await tx.contractOccupant.create({
          data: {
            businessId,
            contractId: created.id,
            roomId: body.roomId,
            tenantId: occupant.tenantId,
            role: OccupantRole.ROOMMATE,
            relationship: occupant.relationship,
            moveInDate: occupant.moveInDate ? new Date(occupant.moveInDate) : new Date(body.startDate),
          },
        });
      }
      if (created.status === ContractStatus.ACTIVE) await tx.room.update({ where: { id: body.roomId }, data: { status: RoomStatus.OCCUPIED } });
      return created;
    });
    await this.changed(user, 'CREATE_CONTRACT', contract.id, businessId);
    return contract;
  }

  async activate(user: AuthUser, id: string) {
    const contract = await this.get('rentalContract', user, id);
    await this.assertNoActiveRoomContract(contract.businessId, contract.roomId, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const active = await tx.rentalContract.update({ where: { id }, data: { status: ContractStatus.ACTIVE } });
      await tx.room.update({ where: { id: active.roomId }, data: { status: RoomStatus.OCCUPIED } });
      return active;
    });
    await this.changed(user, 'ACTIVATE_CONTRACT', id, contract.businessId);
    return updated;
  }

  async terminate(user: AuthUser, id: string) {
    const contract = await this.get('rentalContract', user, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const terminated = await tx.rentalContract.update({ where: { id }, data: { status: ContractStatus.TERMINATED, endDate: new Date() } });
      const otherActive = await tx.rentalContract.findFirst({ where: { roomId: terminated.roomId, status: ContractStatus.ACTIVE, id: { not: id } } });
      if (!otherActive) await tx.room.update({ where: { id: terminated.roomId }, data: { status: RoomStatus.AVAILABLE } });
      await tx.contractOccupant.updateMany({ where: { contractId: id, status: OccupantStatus.STAYING }, data: { status: OccupantStatus.LEFT, moveOutDate: new Date() } });
      return terminated;
    });
    await this.changed(user, 'TERMINATE_CONTRACT', id, contract.businessId);
    return updated;
  }

  private async assertNoActiveRoomContract(businessId: string, roomId: string, exceptId?: string) {
    const active = await this.prisma.rentalContract.findFirst({
      where: { businessId, roomId, status: ContractStatus.ACTIVE, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (active) throw new BadRequestException('Room already has an ACTIVE contract');
  }

  private async changed(user: AuthUser, action: string, id: string, businessId: string) {
    await this.redis.del(`dashboard:${businessId}:*`);
    await this.audit.log({ businessId, userId: user.sub, action, entity: 'RentalContract', entityId: id });
  }
}
