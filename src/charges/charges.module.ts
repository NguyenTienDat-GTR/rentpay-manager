import { Module } from '@nestjs/common';
import { BillingPeriodsModule } from '../billing-periods/billing-periods.module';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { ChargesController } from './charges.controller';
import { ChargesService } from './charges.service';

@Module({ imports: [TenantCreditsModule, BillingPeriodsModule], controllers: [ChargesController], providers: [ChargesService], exports: [ChargesService] })
export class ChargesModule {}
