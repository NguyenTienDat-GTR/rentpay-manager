import { Module } from '@nestjs/common';
import { BillingPeriodsController } from './billing-periods.controller';
import { BillingPeriodsService } from './billing-periods.service';

@Module({ controllers: [BillingPeriodsController], providers: [BillingPeriodsService] })
export class BillingPeriodsModule {}
