import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type AuthUser = {
  sub: string;
  role: 'SUPER_ADMIN' | 'BUSINESS_OWNER' | 'STAFF';
  businessId?: string | null;
  sessionId: string;
};

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
