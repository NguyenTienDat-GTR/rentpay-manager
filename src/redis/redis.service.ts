import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client?: Redis;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) return;

    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.client.on('error', (error) => this.logger.warn(`Redis unavailable: ${error.message}`));
    this.client.connect().catch((error) => this.logger.warn(`Redis connect skipped: ${error.message}`));
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const value = await this.client.get(key);
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number) {
    if (!this.client) return;
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds) await this.client.set(key, payload, 'EX', ttlSeconds);
      else await this.client.set(key, payload);
    } catch {
      return;
    }
  }

  async del(patternOrKey: string) {
    if (!this.client) return;
    try {
      if (!patternOrKey.includes('*')) {
        await this.client.del(patternOrKey);
        return;
      }
      const keys = await this.client.keys(patternOrKey);
      if (keys.length) await this.client.del(keys);
    } catch {
      return;
    }
  }

  async sadd(key: string, value: string, ttlSeconds?: number) {
    if (!this.client) return;
    try {
      await this.client.sadd(key, value);
      if (ttlSeconds) await this.client.expire(key, ttlSeconds);
    } catch {
      return;
    }
  }

  async srem(key: string, value: string) {
    if (!this.client) return;
    try {
      await this.client.srem(key, value);
    } catch {
      return;
    }
  }

  async rateLimit(key: string, limit: number, ttlSeconds: number) {
    if (!this.client) return { allowed: true, remaining: limit };
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, ttlSeconds);
    return { allowed: count <= limit, remaining: Math.max(limit - count, 0) };
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }
}
