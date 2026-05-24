import { Module } from '@nestjs/common';
import { TenantCreditsController } from './tenant-credits.controller';
import { TenantCreditsService } from './tenant-credits.service';

@Module({
  controllers: [TenantCreditsController],
  providers: [TenantCreditsService],
  exports: [TenantCreditsService],
})
export class TenantCreditsModule {}
