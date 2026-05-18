import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChargesModule } from '../charges/charges.module';
import { PublicPortalController } from './public-portal.controller';
import { PublicPortalService } from './public-portal.service';

@Module({
  imports: [JwtModule.register({}), ChargesModule],
  controllers: [PublicPortalController],
  providers: [PublicPortalService],
})
export class PublicPortalModule {}
