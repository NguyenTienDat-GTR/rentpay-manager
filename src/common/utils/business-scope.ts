import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser } from '../decorators/current-user.decorator';

export function requireBusinessId(user: AuthUser, requestedBusinessId?: string) {
  if (user.role === Role.SUPER_ADMIN) {
    if (!requestedBusinessId) throw new BadRequestException('businessId is required for SUPER_ADMIN');
    return requestedBusinessId;
  }
  if (!user.businessId) throw new ForbiddenException('User is not assigned to a business');
  return user.businessId;
}

export function scopedWhere(user: AuthUser, extra: Record<string, unknown> = {}) {
  if (user.role === Role.SUPER_ADMIN) return extra;
  if (!user.businessId) throw new ForbiddenException('User is not assigned to a business');
  return { ...extra, businessId: user.businessId };
}

export function scopedData(user: AuthUser, body: Record<string, unknown>) {
  if (user.role === Role.SUPER_ADMIN) return body;
  if (!user.businessId) throw new ForbiddenException('User is not assigned to a business');
  return { ...body, businessId: user.businessId };
}
