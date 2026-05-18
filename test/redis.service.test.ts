import { ConfigService } from '@nestjs/config';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RedisService } from '../src/redis/redis.service';

describe('RedisService rateLimit fallback', () => {
  it('enforces limits in memory when Redis is not configured', async () => {
    const service = new RedisService({ get: () => undefined } as unknown as ConfigService);

    assert.deepEqual(pick(await service.rateLimit('test:key', 2, 60)), { allowed: true, remaining: 1 });
    assert.deepEqual(pick(await service.rateLimit('test:key', 2, 60)), { allowed: true, remaining: 0 });
    assert.deepEqual(pick(await service.rateLimit('test:key', 2, 60)), { allowed: false, remaining: 0 });
  });

  it('resets the in-memory bucket after ttl expires', async () => {
    const service = new RedisService({ get: () => undefined } as unknown as ConfigService);

    await service.rateLimit('test:ttl', 1, 1);
    assert.equal((await service.rateLimit('test:ttl', 1, 1)).allowed, false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await service.rateLimit('test:ttl', 1, 1)).allowed, true);
  });
});

function pick(value: { allowed: boolean; remaining: number }) {
  return { allowed: value.allowed, remaining: value.remaining };
}
