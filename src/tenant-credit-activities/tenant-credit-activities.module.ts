import { Module } from '@nestjs/common';
import { TenantCreditActivitiesController } from './tenant-credit-activities.controller';
import { TenantCreditActivitiesService } from './tenant-credit-activities.service';

@Module({
  controllers: [TenantCreditActivitiesController],
  providers: [TenantCreditActivitiesService],
  exports: [TenantCreditActivitiesService],
})
export class TenantCreditActivitiesModule {}
