import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { BankTransactionsService } from './bank-transactions.service';

@Controller()
export class BankTransactionsController {
  constructor(private readonly transactions: BankTransactionsService) {}

  @Get('bank-transactions')
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.transactions.list(user, query);
  }

  @Get('payment-matches')
  @Retryable()
  matches(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.transactions.listMatches(user, query);
  }

  @Get('payment-matches/:id/review-context')
  @Retryable()
  reviewContext(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transactions.reviewContext(user, id);
  }

  @Post('payment-matches/:id/confirm')
  confirmMatch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.transactions.confirmMatch(user, id, body);
  }

  @Post('payment-matches/:id/reject')
  rejectMatch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.transactions.rejectMatch(user, id, body);
  }

  @Post('webhook-demo')
  webhookForLoggedInUser(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.transactions.receiveWebhook(body, user);
  }

  @Public()
  @RateLimit({ limit: 60, ttlSeconds: 60, keyPrefix: 'bank:webhook', scope: 'ip' })
  @Post('bank-webhook/demo')
  async publicWebhook(@Req() req: Request, @Body() body: any) {
    return this.transactions.receiveWebhook(body);
  }
}
