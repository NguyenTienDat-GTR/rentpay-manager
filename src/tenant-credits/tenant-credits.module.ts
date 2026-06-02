import { Module } from '@nestjs/common';
import { BillingPeriodsModule } from '../billing-periods/billing-periods.module';
import { TenantCreditsController } from './tenant-credits.controller';
import { TenantCreditsService } from './tenant-credits.service';

@Module({
  imports: [BillingPeriodsModule],
  controllers: [TenantCreditsController],
  providers: [TenantCreditsService],
  exports: [TenantCreditsService],
})
export class TenantCreditsModule {}
