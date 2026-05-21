import { BadRequestException, Injectable } from '@nestjs/common';
import { ContractStatus, OccupantStatus, TenantStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { BaseCrudService } from '../common/base-crud.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

const PHONE_PATTERN = /^0\d{9}$/;
const IDENTITY_NUMBER_PATTERN = /^\d{12}$/;
const CREATE_STATUSES: readonly TenantStatus[] = [TenantStatus.DEPOSITED, TenantStatus.STAYING];
const UPDATE_STATUSES: readonly TenantStatus[] = [TenantStatus.DEPOSITED, TenantStatus.STAYING, TenantStatus.LEFT];
const TENANT_SELECT = {
  id: true,
  businessId: true,
  fullName: true,
  phone: true,
  identityNumber: true,
  dateOfBirth: true,
  permanentAddress: true,
  note: true,
  status: true,
  createdAt: true,
  updatedAt: true,
};

@Injectable()
export class TenantsService extends BaseCrudService {
  constructor(prisma: PrismaService, private readonly audit: AuditService) {
    super(prisma);
  }

  async list(user: AuthUser, query: any) {
    await this.syncContractDrivenStatuses(user);
    const result = await super.listItems({
      model: 'tenant',
      user,
      query,
      searchFields: ['fullName', 'phone', 'identityNumber', 'permanentAddress'],
      filterFields: ['status'],
      sortFields: ['fullName', 'phone', 'createdAt'],
      select: TENANT_SELECT,
    });
    const ids = result.items.map((item: any) => item.id).filter(Boolean);
    if (!ids.length) return result;
    const contracts = await this.prisma.rentalContract.findMany({
      where: {
        businessId: this.requireBusinessId(user),
        representativeTenantId: { in: ids },
        status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] },
      },
      select: {
        representativeTenantId: true,
        occupants: { where: { status: { not: OccupantStatus.LEFT } }, select: { id: true } },
      },
    });
    const activeContracts = await this.getEffectiveContractsForTenants(this.requireBusinessId(user), ids);
    const roommateCounts = new Map<string, number>();
    for (const contract of contracts) {
      roommateCounts.set(contract.representativeTenantId, (roommateCounts.get(contract.representativeTenantId) ?? 0) + contract.occupants.length);
    }
    const roomsByTenantId = this.mapCurrentRoomsByTenant(activeContracts);
    return {
      ...result,
      items: result.items.map((item: any) => ({
        ...item,
        roommateCount: roommateCounts.get(item.id) ?? 0,
        currentRooms: roomsByTenantId.get(item.id) ?? [],
      })),
    };
  }

  async getTenant(user: AuthUser, id: string) {
    await this.syncContractDrivenStatuses(user);
    const tenant = await this.get('tenant', user, id, undefined, true, TENANT_SELECT);
    if (!(this.prisma as any).contractOccupant?.count) return tenant;
    const businessId = this.requireBusinessId(user);
    const [roommateCount, activeContracts, roommates] = await Promise.all([
      this.prisma.contractOccupant.count({
        where: {
          contract: {
            businessId,
            representativeTenantId: id,
            status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] },
          },
          status: { not: OccupantStatus.LEFT },
        },
      }),
      this.getEffectiveContractsForTenants(businessId, [id]),
      this.getRoommatesForTenant(businessId, id),
    ]);
    const roomsByTenantId = this.mapCurrentRoomsByTenant(activeContracts);
    return { ...tenant, roommateCount, currentRooms: roomsByTenantId.get(id) ?? [], roommates };
  }

  async createTenant(user: AuthUser, body: any) {
    const data = this.normalizeTenantPayload(body, true);
    const tenant = await this.prisma.tenant.create({ data: { ...data, businessId: this.requireBusinessId(user) } as any, select: TENANT_SELECT });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'CREATE_TENANT', entity: 'Tenant', entityId: tenant.id });
    return tenant;
  }

  async updateTenant(user: AuthUser, id: string, body: any) {
    const existing = await this.getTenant(user, id);
    const data = this.normalizeTenantPayload(body, false, existing);
    const tenant = await this.prisma.tenant.update({ where: { id }, data, select: TENANT_SELECT });
    await this.audit.log({ businessId: user.businessId, userId: user.sub, action: 'UPDATE_TENANT', entity: 'Tenant', entityId: id });
    return tenant;
  }

  markLeft(user: AuthUser, id: string) {
    return this.updateTenant(user, id, { status: TenantStatus.LEFT });
  }

  private normalizeTenantPayload(body: Record<string, any>, isCreate: boolean, _existing?: Record<string, any>) {
    const data: Record<string, any> = {};

    if (body.fullName !== undefined) data.fullName = this.requiredText(body.fullName, 'Full name is required');
    if (body.phone !== undefined || isCreate) data.phone = this.requiredPhone(body.phone, 'Phone is required', 'Invalid phone');
    if (body.identityNumber !== undefined || isCreate) data.identityNumber = this.requiredIdentityNumber(body.identityNumber);
    if (body.permanentAddress !== undefined || isCreate) data.permanentAddress = this.requiredText(body.permanentAddress, 'Permanent address is required');
    if (body.note !== undefined) data.note = this.optionalText(body.note) ?? null;
    if (body.dateOfBirth !== undefined) data.dateOfBirth = this.normalizeDateOfBirth(body.dateOfBirth);

    const status = body.status ?? (isCreate ? TenantStatus.DEPOSITED : undefined);
    if (status !== undefined) data.status = this.normalizeStatus(status, isCreate);

    if (isCreate && !data.fullName) throw new BadRequestException('Full name is required');
    return data;
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

  private requiredPhone(value: unknown, requiredMessage: string, invalidMessage: string) {
    const phone = this.optionalText(value);
    if (!phone) throw new BadRequestException(requiredMessage);
    if (!PHONE_PATTERN.test(phone)) throw new BadRequestException(invalidMessage);
    return phone;
  }

  private requiredIdentityNumber(value: unknown) {
    const identityNumber = this.requiredText(value, 'Identity number is required');
    if (!IDENTITY_NUMBER_PATTERN.test(identityNumber)) throw new BadRequestException('Identity number must be exactly 12 digits');
    return identityNumber;
  }

  private normalizeDateOfBirth(value: unknown) {
    const text = this.optionalText(value);
    if (!text) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Invalid date of birth');
    if (!isAtLeastAgeByYear(date, 18)) throw new BadRequestException('Tenant must be at least 18 years old');
    return date;
  }

  private normalizeStatus(value: unknown, isCreate: boolean) {
    const normalized = value === 'ACTIVE' ? TenantStatus.STAYING : value;
    const allowed = isCreate ? CREATE_STATUSES : UPDATE_STATUSES;
    if (!allowed.includes(normalized as TenantStatus)) {
      throw new BadRequestException(isCreate ? 'Tenant cannot be created with left status' : 'Invalid tenant status');
    }
    return normalized as TenantStatus;
  }

  private requireBusinessId(user: AuthUser) {
    if (!user.businessId) throw new BadRequestException('Business scope is required');
    return user.businessId;
  }

  private getEffectiveContractsForTenants(businessId: string, tenantIds: string[]) {
    return this.prisma.rentalContract.findMany({
      where: {
        businessId,
        representativeTenantId: { in: tenantIds },
        status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] },
      },
      select: {
        representativeTenantId: true,
        room: { select: { id: true, roomCode: true, roomArea: true } },
        contractRooms: { select: { room: { select: { id: true, roomCode: true, roomArea: true } } } },
      },
    });
  }

  private async getRoommatesForTenant(businessId: string, tenantId: string) {
    const contracts = await this.prisma.rentalContract.findMany({
      where: {
        businessId,
        representativeTenantId: tenantId,
        status: { in: [ContractStatus.PENDING, ContractStatus.ACTIVE] },
      },
      select: {
        id: true,
        status: true,
        startDate: true,
        endDate: true,
        room: { select: { id: true, roomCode: true, roomArea: true } },
        contractRooms: { select: { room: { select: { id: true, roomCode: true, roomArea: true } } } },
        occupants: {
          where: { status: { not: OccupantStatus.LEFT } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            roomId: true,
            fullName: true,
            phone: true,
            identityNumber: true,
            dateOfBirth: true,
            permanentAddress: true,
            occupantType: true,
            relationship: true,
            moveInDate: true,
            moveOutDate: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    return contracts.flatMap((contract) => {
      const rooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      const roomById = new Map(rooms.map((room) => [room.id, room]));
      return contract.occupants.map((occupant) => ({
        ...occupant,
        contractId: contract.id,
        contractStatus: contract.status,
        contractStartDate: contract.startDate,
        contractEndDate: contract.endDate,
        room: roomById.get(occupant.roomId) ?? null,
      }));
    });
  }

  private mapCurrentRoomsByTenant(contracts: Awaited<ReturnType<TenantsService['getEffectiveContractsForTenants']>>) {
    const roomsByTenantId = new Map<string, Array<{ id: string; roomCode: string; roomArea: { name: string } | null }>>();
    for (const contract of contracts) {
      const existing = roomsByTenantId.get(contract.representativeTenantId) ?? [];
      const seen = new Set(existing.map((room) => room.id));
      const rooms = contract.contractRooms.length ? contract.contractRooms.map((item) => item.room) : [contract.room];
      for (const room of rooms) {
        if (seen.has(room.id)) continue;
        seen.add(room.id);
        existing.push(room);
      }
      roomsByTenantId.set(contract.representativeTenantId, existing);
    }
    return roomsByTenantId;
  }

  private async syncContractDrivenStatuses(user: AuthUser) {
    if (!(this.prisma as any).rentalContract?.findMany || !(this.prisma as any).contractOccupant?.updateMany) return;
    const businessId = this.requireBusinessId(user);
    const now = new Date();
    const tomorrow = addDays(startOfLocalDay(now), 1);
    const effectiveContracts = await this.prisma.rentalContract.findMany({
      where: { businessId, status: ContractStatus.ACTIVE, startDate: { lt: tomorrow } },
      select: { id: true, representativeTenantId: true },
    });
    const effectiveTenantIds = Array.from(new Set(effectiveContracts.map((contract) => contract.representativeTenantId)));
    const effectiveContractIds = effectiveContracts.map((contract) => contract.id);
    if (effectiveTenantIds.length) {
      await this.prisma.tenant.updateMany({
        where: { businessId, id: { in: effectiveTenantIds }, status: { not: TenantStatus.STAYING } },
        data: { status: TenantStatus.STAYING },
      });
    }
    if (effectiveContractIds.length) {
      await this.prisma.contractOccupant.updateMany({
        where: { businessId, contractId: { in: effectiveContractIds }, status: OccupantStatus.DEPOSITED },
        data: { status: OccupantStatus.STAYING },
      });
    }

    const reservedContracts = await this.prisma.rentalContract.findMany({
      where: {
        businessId,
        OR: [
          { status: ContractStatus.PENDING },
          { status: ContractStatus.ACTIVE, startDate: { gte: tomorrow } },
        ],
      },
      select: { id: true, representativeTenantId: true },
    });
    for (const contract of reservedContracts) {
      const hasEffectiveContract = effectiveTenantIds.includes(contract.representativeTenantId);
      if (!hasEffectiveContract) {
        await this.prisma.tenant.updateMany({
          where: { businessId, id: contract.representativeTenantId, status: TenantStatus.STAYING },
          data: { status: TenantStatus.DEPOSITED },
        });
      }
      await this.prisma.contractOccupant.updateMany({
        where: { businessId, contractId: contract.id, status: OccupantStatus.STAYING },
        data: { status: OccupantStatus.DEPOSITED },
      });
    }
  }
}

function isAtLeastAgeByYear(date: Date, age: number) {
  return new Date().getFullYear() - date.getFullYear() >= age;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
