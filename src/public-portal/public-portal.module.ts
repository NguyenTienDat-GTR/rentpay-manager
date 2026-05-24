import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChargesModule } from '../charges/charges.module';
import { TenantCreditsModule } from '../tenant-credits/tenant-credits.module';
import { PublicPortalController } from './public-portal.controller';
import { PublicPortalService } from './public-portal.service';

@Module({
  imports: [JwtModule.register({}), ChargesModule, TenantCreditsModule],
  controllers: [PublicPortalController],
  providers: [PublicPortalService],
})
export class PublicPortalModule {}
