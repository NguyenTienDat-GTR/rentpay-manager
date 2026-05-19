import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { TenantsService } from './tenants.service';

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.tenants.list(user, query);
  }

  @Get(':id')
  @Retryable()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tenants.getTenant(user, id);
  }

  @Post()
  create(@CurrentUser() _user: AuthUser, @Body() _body: any) {
    throw new BadRequestException('Tenants must be created from rental contracts');
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.tenants.updateTenant(user, id, body);
  }

  @Patch(':id/left')
  left(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tenants.markLeft(user, id);
  }
}
