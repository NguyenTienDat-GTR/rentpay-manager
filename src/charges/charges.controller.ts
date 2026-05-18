import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ChargesService } from './charges.service';

@Controller('charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.charges.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.charges.get('charge', user, id, { room: true, payerTenant: true, payments: true, bankAccount: true });
  }

  @Get(':id/qr')
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
