import { SetMetadata } from '@nestjs/common';

export type RateLimitScope = 'ip' | 'user' | 'user-or-ip' | 'business-or-ip';

export interface RateLimitOptions {
  limit: number;
  ttlSeconds: number;
  keyPrefix?: string;
  scope?: RateLimitScope;
}

export const RATE_LIMIT_KEY = 'rateLimit';
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
