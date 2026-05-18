import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { PublicPortalService } from './public-portal.service';

@Public()
@Controller('public/pay/:businessSlug')
export class PublicPortalController {
  constructor(private readonly portal: PublicPortalService) {}

  @Get()
  business(@Param('businessSlug') businessSlug: string) {
    return this.portal.business(businessSlug);
  }

  @Post('lookup')
  lookup(@Param('businessSlug') businessSlug: string, @Body() body: any, @Req() req: Request) {
    return this.portal.lookup(businessSlug, body, req.ip);
  }

  @Get('charges/:chargeId/qr')
  qr(@Param('businessSlug') businessSlug: string, @Param('chargeId') chargeId: string, @Headers('x-portal-access-token') token?: string) {
    return this.portal.chargeQr(businessSlug, chargeId, token);
  }
}
