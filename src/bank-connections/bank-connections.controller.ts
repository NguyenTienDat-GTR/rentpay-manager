import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { BankConnectionsService } from './bank-connections.service';

@Controller('bank-connections')
export class BankConnectionsController {
  constructor(private readonly connections: BankConnectionsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.connections.list(user, query);
  }

  @Post('connect-mock')
  connectMock(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.connections.connectMock(user, body);
  }

  @Patch(':id/disconnect')
  disconnect(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.connections.disconnect(user, id);
  }
}
