import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { BillingPeriodStatus } from '@prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { BillingPeriodsService } from './billing-periods.service';

@Controller('billing-periods')
export class BillingPeriodsController {
  constructor(private readonly periods: BillingPeriodsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.periods.list(user, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.periods.createPeriod(user, body);
  }

  @Patch(':id/status')
  status(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('status') status: BillingPeriodStatus) {
    return this.periods.setStatus(user, id, status);
  }

  @Post(':id/generate-monthly-rent')
  generate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.periods.generateMonthlyRentCharges(user, id);
  }
}
