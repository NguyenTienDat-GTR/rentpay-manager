import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Observable, retry, timer } from 'rxjs';
import { RETRYABLE_KEY, RetryableOptions } from '../decorators/retryable.decorator';

@Injectable()
export class RetryInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<RetryableOptions>(RETRYABLE_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method?.toUpperCase() ?? 'GET';
    const methods = (options.methods ?? ['GET']).map((item) => item.toUpperCase());
    if (!methods.includes(method)) return next.handle();

    const attempts = options.attempts ?? 2;
    const delayMs = options.delayMs ?? 100;
    if (attempts <= 0) return next.handle();

    return next.handle().pipe(
      retry({
        count: attempts,
        delay: (error, retryCount) => {
          if (!this.isTransient(error)) throw error;
          return timer(delayMs * retryCount);
        },
      }),
    );
  }

  private isTransient(error: any) {
    const status = Number(error?.status ?? error?.response?.statusCode ?? error?.response?.status);
    if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;

    const code = String(error?.code ?? '');
    return ['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
  }
}
