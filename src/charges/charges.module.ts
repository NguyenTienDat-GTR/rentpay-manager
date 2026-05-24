import { Module } from '@nestjs/common';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { ChargesController } from './charges.controller';
import { ChargesService } from './charges.service';

@Module({ imports: [TenantCreditsModule], controllers: [ChargesController], providers: [ChargesService], exports: [ChargesService] })
export class ChargesModule {}
