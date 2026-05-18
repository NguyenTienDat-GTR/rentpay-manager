import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UsersService } from './users.service';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Roles(Role.SUPER_ADMIN, Role.BUSINESS_OWNER)
  @Get('users')
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.users.list(user, query);
  }

  @Roles(Role.SUPER_ADMIN, Role.BUSINESS_OWNER)
  @Post('users')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.users.createUser(user, body);
  }

  @Roles(Role.SUPER_ADMIN, Role.BUSINESS_OWNER)
  @Patch('users/:id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    return this.users.updateUser(user, id, body);
  }

  @Roles(Role.BUSINESS_OWNER)
  @Get('staff')
  @Retryable()
  staff(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.users.list(user, { ...query, role: Role.STAFF });
  }

  @Roles(Role.BUSINESS_OWNER)
  @Post('staff')
  createStaff(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.users.createUser(user, { ...body, role: Role.STAFF });
  }
}
