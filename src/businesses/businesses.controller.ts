import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { BusinessesService } from './businesses.service';

@Controller()
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Roles(Role.SUPER_ADMIN)
  @Get('businesses')
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.businesses.list(user, query);
  }

  @Roles(Role.SUPER_ADMIN)
  @Post('business-owners')
  createOwner(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.businesses.createBusinessOwner(user, body);
  }

  @Get('business')
  @Retryable()
  myBusiness(@CurrentUser() user: AuthUser) {
    return this.businesses.getMyBusiness(user);
  }

  @Patch('business')
  updateMyBusiness(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.businesses.updateMyBusiness(user, body);
  }
}
