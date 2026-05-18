import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('collection-summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.reports.collectionSummary(user);
  }

  @Get('debt')
  debt(@CurrentUser() user: AuthUser) {
    return this.reports.debt(user);
  }

  @Get('payments')
  payments(@CurrentUser() user: AuthUser) {
    return this.reports.payments(user);
  }

  @Get('bank-transactions')
  transactions(@CurrentUser() user: AuthUser) {
    return this.reports.bankTransactions(user);
  }

  @Get('export-excel')
  async export(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const buffer = await this.reports.exportExcel(user);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="rentpay-report.xlsx"');
    res.send(Buffer.from(buffer));
  }
}
