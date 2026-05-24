import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { ContractsService } from './contracts.service';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.contracts.list(user, query);
  }

  @Get(':id')
  @Retryable()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.getContract(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.contracts.createContract(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() _user: AuthUser, @Param('id') _id: string, @Body() _body: any) {
    throw new BadRequestException('Rental contracts cannot be edited directly');
  }

  @Patch(':id/activate')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.activate(user, id);
  }

  @Patch(':id/terminate')
  terminate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.contracts.terminate(user, id, body);
  }

  @Patch(':id/expire')
  expire(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.contracts.expire(user, id, body);
  }

  @Patch(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.contracts.cancel(user, id, body);
  }

  @Post(':id/transfer-room')
  transferRoom(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.contracts.transferRoom(user, id, body);
  }
}
