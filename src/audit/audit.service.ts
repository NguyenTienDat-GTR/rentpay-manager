import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: {
    businessId?: string | null;
    userId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    metadata?: unknown;
  }) {
    await this.prisma.auditLog.create({
      data: {
        businessId: input.businessId ?? undefined,
        userId: input.userId ?? undefined,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? undefined,
        metadata: input.metadata as object,
      },
    });
  }
}
