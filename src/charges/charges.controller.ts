import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { ChargesService } from './charges.service';

@Controller('charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.charges.list(user, query);
  }

  @Get('context')
  @Retryable()
  context(
    @CurrentUser() user: AuthUser,
    @Query('roomId') roomId?: string,
    @Query('billingPeriodId') billingPeriodId?: string,
    @Query('roomAreaId') roomAreaId?: string,
  ) {
    return this.charges.context(user, roomId, billingPeriodId, roomAreaId);
  }

  @Get(':id')
  @Retryable()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.charges.getCharge(user, id);
  }

  @Get(':id/qr')
  @RateLimit({ limit: 60, ttlSeconds: 60, keyPrefix: 'charges:qr', scope: 'business-or-ip' })
  qr(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.charges.qr(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.charges.createCharge(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.charges.updateCharge(user, id, body);
  }

  @Patch(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.charges.cancel(user, id);
  }
}
