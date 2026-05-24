import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { TenantCreditsService } from './tenant-credits.service';

@Controller('tenant-credits')
export class TenantCreditsController {
  constructor(private readonly tenantCredits: TenantCreditsService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.tenantCredits.list(user, query);
  }

  @Get('summary')
  @Retryable()
  summary(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.tenantCredits.summary(user, query);
  }

  @Post('apply')
  apply(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.tenantCredits.apply(user, body);
  }

  @Post('refund')
  refund(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.tenantCredits.refund(user, body);
  }
}
