import { Module } from '@nestjs/common';
import { BillingPeriodsModule } from '../billing-periods/billing-periods.module';
import { PaymentsModule } from '../payments/payments.module';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { BankTransactionsController } from './bank-transactions.controller';
import { BankTransactionsService } from './bank-transactions.service';

@Module({
  imports: [PaymentsModule, TenantCreditsModule, BillingPeriodsModule],
  controllers: [BankTransactionsController],
  providers: [BankTransactionsService],
})
export class BankTransactionsModule {}
