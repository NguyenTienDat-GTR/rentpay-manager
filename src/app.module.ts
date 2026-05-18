import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuditModule } from './audit/audit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { UsersModule } from './users/users.module';
import { BusinessesModule } from './businesses/businesses.module';
import { BankAccountsModule } from './bank-accounts/bank-accounts.module';
import { BankConnectionsModule } from './bank-connections/bank-connections.module';
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
    RoomsModule,
    TenantsModule,
    ContractsModule,
    BillingPeriodsModule,
    ChargesModule,
    PaymentsModule,
    BankTransactionsModule,
    DashboardModule,
    ReportsModule,
    PublicPortalModule,
    NotificationLogsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
