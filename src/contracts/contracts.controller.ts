import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
    return this.contracts.get('rentalContract', user, id, { room: true, representativeTenant: true, occupants: { include: { tenant: true } } });
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.contracts.createContract(user, body);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.contracts.update('rentalContract', user, id, body);
  }

  @Patch(':id/activate')
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.activate(user, id);
  }

  @Patch(':id/terminate')
  terminate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contracts.terminate(user, id);
  }
}
