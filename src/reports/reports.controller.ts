import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('collection-summary')
  @Retryable()
  summary(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.reports.collectionSummary(user, query);
  }

  @Get('debt')
  @Retryable()
  debt(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.reports.debt(user, query);
  }

  @Get('payments')
  @Retryable()
  payments(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.reports.payments(user, query);
  }

  @Get('bank-transactions')
  @Retryable()
  transactions(@CurrentUser() user: AuthUser, @Query() query: any) {
    return this.reports.bankTransactions(user, query);
  }

  @Get('export-excel')
  @RateLimit({ limit: 10, ttlSeconds: 60, keyPrefix: 'reports:export', scope: 'business-or-ip' })
  @Retryable({ attempts: 1 })
  async export(@CurrentUser() user: AuthUser, @Query() query: any, @Res() res: Response) {
    const buffer = await this.reports.exportExcel(user, query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="rentpay-report.xlsx"');
    res.send(Buffer.from(buffer));
  }
}
