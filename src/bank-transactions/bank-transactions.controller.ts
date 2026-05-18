import { Body, Controller, Get, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RedisService } from '../redis/redis.service';
import { BankTransactionsService } from './bank-transactions.service';

@Controller()
export class BankTransactionsController {
  constructor(
    private readonly transactions: BankTransactionsService,
    private readonly redis: RedisService,
  ) {}

  @Get('bank-transactions')
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.transactions.list(user, query);
  }

  @Get('payment-matches')
  matches(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.transactions.listMatches(user, query);
  }

  @Post('webhook-demo')
  webhookForLoggedInUser(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.transactions.receiveWebhook(body, user);
  }

  @Public()
  @Post('bank-webhook/demo')
  async publicWebhook(@Req() req: Request, @Body() body: any) {
    const rate = await this.redis.rateLimit(`rate:webhook:${req.ip}`, 60, 60);
    if (!rate.allowed) throw new UnauthorizedException('Too many requests');
    return this.transactions.receiveWebhook(body);
  }
}
