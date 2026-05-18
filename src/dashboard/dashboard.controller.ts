import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @Retryable()
  summary(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.dashboard.summary(user, query);
  }
}
