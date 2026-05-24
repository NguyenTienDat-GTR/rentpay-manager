import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RetryInterceptor } from './common/interceptors/retry.interceptor';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuditModule } from './audit/audit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { UsersModule } from './users/users.module';
import { BusinessesModule } from './businesses/businesses.module';
import { BankAccountsModule } from './bank-accounts/bank-accounts.module';
import { BankConnectionsModule } from './bank-connections/bank-connections.module';
import { RoomAreasModule } from './room-areas/room-areas.module';
import { RoomsModule } from './rooms/rooms.module';
import { TenantsModule } from './tenants/tenants.module';
import { ContractsModule } from './contracts/contracts.module';
import { BillingPeriodsModule } from './billing-periods/billing-periods.module';
import { ChargesModule } from './charges/charges.module';
import { PaymentsModule } from './payments/payments.module';
import { BankTransactionsModule } from './bank-transactions/bank-transactions.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReportsModule } from './reports/reports.module';
import { PublicPortalModule } from './public-portal/public-portal.module';
import { NotificationLogsModule } from './notification-logs/notification-logs.module';
import { TenantCreditsModule } from './tenant-credits/tenant-credits.module';
import { TenantCreditActivitiesModule } from './tenant-credit-activities/tenant-credit-activities.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    PrismaModule,
    RedisModule,
    AuditModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    BusinessesModule,
    BankAccountsModule,
    BankConnectionsModule,
    RoomAreasModule,
    RoomsModule,
    TenantsModule,
    ContractsModule,
    BillingPeriodsModule,
    ChargesModule,
    PaymentsModule,
    TenantCreditsModule,
    TenantCreditActivitiesModule,
    BankTransactionsModule,
    DashboardModule,
    ReportsModule,
    PublicPortalModule,
    NotificationLogsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: RetryInterceptor },
  ],
})
export class AppModule {}
