import { Module } from '@nestjs/common';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({ imports: [TenantCreditsModule], controllers: [PaymentsController], providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
