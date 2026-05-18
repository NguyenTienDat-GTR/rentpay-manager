import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { Retryable } from '../common/decorators/retryable.decorator';
import { PublicPortalService } from './public-portal.service';

@Public()
@Controller('public/pay/:businessSlug')
export class PublicPortalController {
  constructor(private readonly portal: PublicPortalService) {}

  @Get()
  @Retryable()
  business(@Param('businessSlug') businessSlug: string) {
    return this.portal.business(businessSlug);
  }

  @Post('lookup')
  @RateLimit({ limit: 30, ttlSeconds: 900, keyPrefix: 'public:lookup', scope: 'ip' })
  lookup(@Param('businessSlug') businessSlug: string, @Body() body: any, @Req() req: Request) {
    return this.portal.lookup(businessSlug, body, req.ip);
  }

  @Get('charges/:chargeId/qr')
  @RateLimit({ limit: 60, ttlSeconds: 60, keyPrefix: 'public:charge-qr', scope: 'ip' })
  qr(@Param('businessSlug') businessSlug: string, @Param('chargeId') chargeId: string, @Headers('x-portal-access-token') token?: string) {
    return this.portal.chargeQr(businessSlug, chargeId, token);
  }
}
