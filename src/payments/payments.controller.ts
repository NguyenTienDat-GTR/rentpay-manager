import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.payments.list(user, query);
  }

  @Post('cash')
  cash(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.payments.recordCash(user, body);
  }

  @Patch(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.cancelPayment(user, id);
  }
}
