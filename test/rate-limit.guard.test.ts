import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimit } from '../src/common/decorators/rate-limit.decorator';
import { RateLimitGuard } from '../src/common/guards/rate-limit.guard';

function makeContext(handler: Function, request: any, response: any = {}) {
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as any;
}

describe('RateLimitGuard', () => {
  it('allows requests under the explicit endpoint limit and writes headers', async () => {
    class Controller {
      @RateLimit({ limit: 2, ttlSeconds: 60, keyPrefix: 'auth:login', scope: 'ip' })
      login() {}
    }
    const headers: Record<string, string> = {};
    const redis = {
      rateLimit: async (key: string, limit: number, ttlSeconds: number) => {
        assert.match(key, /rate:auth:login:POST/);
        assert.equal(limit, 2);
        assert.equal(ttlSeconds, 60);
        return { allowed: true, remaining: 1, resetAt: 1_900_000_000_000 };
      },
    };
    const guard = new RateLimitGuard(new Reflector(), redis as any);
    const context = makeContext(Controller.prototype.login, { method: 'POST', ip: '127.0.0.1', route: { path: '/auth/login' } }, {
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
    });

    assert.equal(await guard.canActivate(context), true);
    assert.equal(headers['X-RateLimit-Limit'], '2');
    assert.equal(headers['X-RateLimit-Remaining'], '1');
    assert.equal(headers['X-RateLimit-Reset'], '1900000000');
  });

  it('throws 429 when the configured rate limit is exceeded', async () => {
    class Controller {
      @RateLimit({ limit: 1, ttlSeconds: 30, keyPrefix: 'auth:login', scope: 'ip' })
      login() {}
    }
    const guard = new RateLimitGuard(new Reflector(), { rateLimit: async () => ({ allowed: false, remaining: 0, resetAt: Date.now() + 30_000 }) } as any);
    const context = makeContext(Controller.prototype.login, { method: 'POST', ip: '10.0.0.1', route: { path: '/auth/login' } }, { setHeader: () => undefined });

    await assert.rejects(
      () => guard.canActivate(context),
      (error: HttpException) => error instanceof HttpException && error.getStatus() === HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('uses the authenticated user identity for default protected reads', async () => {
    let capturedKey = '';
    const guard = new RateLimitGuard(new Reflector(), {
      rateLimit: async (key: string) => {
        capturedKey = key;
        return { allowed: true, remaining: 299, resetAt: Date.now() + 60_000 };
      },
    } as any);
    const context = makeContext(function list() {}, { method: 'GET', ip: '10.0.0.2', user: { sub: 'user-1' }, route: { path: '/rooms' } }, { setHeader: () => undefined });

    await guard.canActivate(context);

    assert.match(capturedKey, /^rate:read:GET:\/rooms:user:user-1$/);
  });

  it('uses business identity for business-scoped explicit limits', async () => {
    class Controller {
      @RateLimit({ limit: 10, ttlSeconds: 60, keyPrefix: 'reports:export', scope: 'business-or-ip' })
      export() {}
    }
    let capturedKey = '';
    const guard = new RateLimitGuard(new Reflector(), {
      rateLimit: async (key: string) => {
        capturedKey = key;
        return { allowed: true, remaining: 9, resetAt: Date.now() + 60_000 };
      },
    } as any);
    const context = makeContext(Controller.prototype.export, { method: 'GET', ip: '10.0.0.3', user: { businessId: 'biz-1' }, route: { path: '/reports/export-excel' } }, { setHeader: () => undefined });

    await guard.canActivate(context);

    assert.match(capturedKey, /business:biz-1$/);
  });
});
