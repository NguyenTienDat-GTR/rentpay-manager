import { Controller, Get, Param, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { TenantCreditActivitiesService } from './tenant-credit-activities.service';

@Controller('tenant-credit-activities')
export class TenantCreditActivitiesController {
  constructor(private readonly activities: TenantCreditActivitiesService) {}

  @Get()
  @Retryable()
  list(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.activities.list(user, query);
  }

  @Get(':id')
  @Retryable()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.activities.get(user, id);
  }
}
