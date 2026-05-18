import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { BankAccountsService } from './bank-accounts.service';

@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly accounts: BankAccountsService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.accounts.list(user, query);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.accounts.createAccount(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.accounts.update('bankAccount', user, id, body);
  }

  @Patch(':id/default')
  setDefault(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.setDefault(user, id);
  }
}
