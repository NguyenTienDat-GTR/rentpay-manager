import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthController } from '../src/auth/auth.controller';
import { AuditController } from '../src/audit/audit.controller';
import { BankAccountsController } from '../src/bank-accounts/bank-accounts.controller';
import { BankConnectionsController } from '../src/bank-connections/bank-connections.controller';
import { BankTransactionsController } from '../src/bank-transactions/bank-transactions.controller';
import { BillingPeriodsController } from '../src/billing-periods/billing-periods.controller';
import { BusinessesController } from '../src/businesses/businesses.controller';
import { ChargesController } from '../src/charges/charges.controller';
import { ContractsController } from '../src/contracts/contracts.controller';
import { DashboardController } from '../src/dashboard/dashboard.controller';
import { NotificationLogsController } from '../src/notification-logs/notification-logs.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { PublicPortalController } from '../src/public-portal/public-portal.controller';
import { ReportsController } from '../src/reports/reports.controller';
import { RoomsController } from '../src/rooms/rooms.controller';
import { TenantsController } from '../src/tenants/tenants.controller';
import { UsersController } from '../src/users/users.controller';
import { RATE_LIMIT_KEY, RateLimitOptions } from '../src/common/decorators/rate-limit.decorator';
import { RETRYABLE_KEY } from '../src/common/decorators/retryable.decorator';

describe('Endpoint rate limit and retry policy', () => {
  it('has strict rate limits on high-risk or expensive endpoints', () => {
    assertRate(AuthController, 'login', { limit: 10, ttlSeconds: 60, scope: 'ip' });
    assertRate(AuthController, 'refresh', { limit: 30, ttlSeconds: 60, scope: 'ip' });
    assertRate(PublicPortalController, 'lookup', { limit: 30, ttlSeconds: 900, scope: 'ip' });
    assertRate(PublicPortalController, 'qr', { limit: 60, ttlSeconds: 60, scope: 'ip' });
    assertRate(BankTransactionsController, 'publicWebhook', { limit: 60, ttlSeconds: 60, scope: 'ip' });
    assertRate(ChargesController, 'qr', { limit: 60, ttlSeconds: 60, scope: 'business-or-ip' });
    assertRate(ReportsController, 'export', { limit: 10, ttlSeconds: 60, scope: 'business-or-ip' });
  });

  it('marks read-only endpoint handlers as retryable', () => {
    [
      [AuthController, 'me'],
      [AuthController, 'sessions'],
      [UsersController, 'list'],
      [UsersController, 'staff'],
      [BusinessesController, 'list'],
      [BusinessesController, 'myBusiness'],
      [RoomsController, 'list'],
      [RoomsController, 'get'],
      [TenantsController, 'list'],
      [TenantsController, 'get'],
      [ContractsController, 'list'],
      [ContractsController, 'get'],
      [BillingPeriodsController, 'list'],
      [ChargesController, 'list'],
      [ChargesController, 'get'],
      [PaymentsController, 'list'],
      [BankAccountsController, 'list'],
      [BankConnectionsController, 'list'],
      [BankTransactionsController, 'list'],
      [BankTransactionsController, 'matches'],
      [DashboardController, 'summary'],
      [ReportsController, 'summary'],
      [ReportsController, 'debt'],
      [ReportsController, 'payments'],
      [ReportsController, 'transactions'],
      [ReportsController, 'export'],
      [PublicPortalController, 'business'],
      [NotificationLogsController, 'list'],
      [AuditController, 'list'],
      [AuditController, 'paymentLogs'],
    ].forEach(([controller, method]) => assertRetry(controller as any, method as string));
  });

  it('does not retry known mutation endpoints', () => {
    [
      [AuthController, 'login'],
      [UsersController, 'create'],
      [RoomsController, 'create'],
      [TenantsController, 'update'],
      [ContractsController, 'activate'],
      [BillingPeriodsController, 'generate'],
      [PaymentsController, 'cash'],
      [BankTransactionsController, 'publicWebhook'],
    ].forEach(([controller, method]) => assert.equal(Reflect.getMetadata(RETRYABLE_KEY, (controller as any).prototype[method as string]), undefined));
  });
});

function assertRate(controller: any, method: string, expected: Partial<RateLimitOptions>) {
  const options = Reflect.getMetadata(RATE_LIMIT_KEY, controller.prototype[method]) as RateLimitOptions;
  assert.ok(options, `${controller.name}.${method} missing @RateLimit`);
  Object.entries(expected).forEach(([key, value]) => assert.equal((options as any)[key], value, `${controller.name}.${method}.${key}`));
}

function assertRetry(controller: any, method: string) {
  const options = Reflect.getMetadata(RETRYABLE_KEY, controller.prototype[method]);
  assert.ok(options, `${controller.name}.${method} missing @Retryable`);
}
