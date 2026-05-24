import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { BankTransactionsController } from './bank-transactions.controller';
import { BankTransactionsService } from './bank-transactions.service';

@Module({
  imports: [PaymentsModule, TenantCreditsModule],
  controllers: [BankTransactionsController],
  providers: [BankTransactionsService],
})
export class BankTransactionsModule {}
