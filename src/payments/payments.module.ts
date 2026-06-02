import { Module } from '@nestjs/common';
import { BillingPeriodsModule } from '../billing-periods/billing-periods.module';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({ imports: [TenantCreditsModule, BillingPeriodsModule], controllers: [PaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
