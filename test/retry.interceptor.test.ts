import 'reflect-metadata';
import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { Retryable } from '../src/common/decorators/retryable.decorator';
import { RetryInterceptor } from '../src/common/interceptors/retry.interceptor';

function makeContext(handler: Function, method = 'GET') {
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({ method }),
    }),
  } as any;
}

describe('RetryInterceptor', () => {
  it('retries transient failures and returns the eventual success', async () => {
    class Controller {
      @Retryable({ attempts: 2, delayMs: 1 })
      list() {}
    }
    let calls = 0;
    const interceptor = new RetryInterceptor(new Reflector());
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(Controller.prototype.list), {
        handle: () =>
          defer(() => {
            calls += 1;
            if (calls < 3) return throwError(() => new InternalServerErrorException('temporary'));
            return of({ ok: true });
          }),
      }),
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);
  });

  it('does not retry non-transient 400 errors', async () => {
    class Controller {
      @Retryable({ attempts: 2, delayMs: 1 })
      list() {}
    }
    let calls = 0;
    const interceptor = new RetryInterceptor(new Reflector());

    await assert.rejects(
      () =>
        lastValueFrom(
          interceptor.intercept(makeContext(Controller.prototype.list), {
            handle: () =>
              defer(() => {
                calls += 1;
                return throwError(() => new BadRequestException('bad input'));
              }),
          }),
        ),
      BadRequestException,
    );
    assert.equal(calls, 1);
  });

  it('does not retry POST requests unless the endpoint opts into POST retry', async () => {
    class Controller {
      @Retryable({ attempts: 2, delayMs: 1 })
      create() {}
    }
    let calls = 0;
    const interceptor = new RetryInterceptor(new Reflector());

    await assert.rejects(
      () =>
        lastValueFrom(
          interceptor.intercept(makeContext(Controller.prototype.create, 'POST'), {
            handle: () =>
              defer(() => {
                calls += 1;
                return throwError(() => new InternalServerErrorException('temporary'));
              }),
          }),
        ),
      InternalServerErrorException,
    );
    assert.equal(calls, 1);
  });

  it('can retry POST when explicitly configured for an idempotent endpoint', async () => {
    class Controller {
      @Retryable({ attempts: 1, delayMs: 1, methods: ['POST'] })
      sync() {}
    }
    let calls = 0;
    const interceptor = new RetryInterceptor(new Reflector());
    const result = await lastValueFrom(
      interceptor.intercept(makeContext(Controller.prototype.sync, 'POST'), {
        handle: () =>
          defer(() => {
            calls += 1;
            if (calls === 1) return throwError(() => Object.assign(new Error('db down'), { code: 'P1001' }));
            return of('ok');
          }),
      }),
    );

    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });
});
