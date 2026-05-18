import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RATE_LIMIT_KEY, RateLimitOptions, RateLimitScope } from '../decorators/rate-limit.decorator';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: any }>();
    const response = http.getResponse<Response>();
    const method = request.method?.toUpperCase() ?? 'GET';
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const explicit = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    const options = explicit ?? this.defaultOptions(method, Boolean(isPublic));
    const key = this.buildKey(options, request, method);
    const result = await this.redis.rateLimit(key, options.limit, options.ttlSeconds);

    this.setRateLimitHeaders(response, options.limit, result.remaining, result.resetAt);

    if (!result.allowed) {
      throw new HttpException({
        message: 'Too many requests. Please try again later.',
        limit: options.limit,
        retryAfterSeconds: result.resetAt ? Math.max(Math.ceil((result.resetAt - Date.now()) / 1000), 1) : options.ttlSeconds,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  private defaultOptions(method: string, isPublic: boolean): RateLimitOptions {
    if (isPublic) return { limit: 60, ttlSeconds: 60, keyPrefix: 'public', scope: 'ip' };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return { limit: 120, ttlSeconds: 60, keyPrefix: 'write', scope: 'user-or-ip' };
    }
    return { limit: 300, ttlSeconds: 60, keyPrefix: 'read', scope: 'user-or-ip' };
  }

  private buildKey(options: RateLimitOptions, request: Request & { user?: any }, method: string) {
    const prefix = options.keyPrefix ?? method.toLowerCase();
    const route = request.route?.path ?? request.path ?? request.originalUrl ?? 'unknown-route';
    return ['rate', prefix, method, route, this.identity(options.scope ?? 'user-or-ip', request)].join(':');
  }

  private identity(scope: RateLimitScope, request: Request & { user?: any }) {
    const user = request.user;
    const ip = request.ip ?? request.socket?.remoteAddress ?? 'unknown-ip';
    if (scope === 'ip') return `ip:${ip}`;
    if (scope === 'user') return `user:${user?.sub ?? user?.id ?? 'anonymous'}`;
    if (scope === 'business-or-ip') {
      return user?.businessId ? `business:${user.businessId}` : `ip:${ip}`;
    }
    return user?.sub || user?.id ? `user:${user.sub ?? user.id}` : `ip:${ip}`;
  }

  private setRateLimitHeaders(response: Response, limit: number, remaining: number, resetAt?: number) {
    response.setHeader?.('X-RateLimit-Limit', String(limit));
    response.setHeader?.('X-RateLimit-Remaining', String(remaining));
    if (resetAt) response.setHeader?.('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
  }
}
