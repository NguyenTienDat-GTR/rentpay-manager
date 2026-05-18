import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Response, Request } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RedisService } from '../redis/redis.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = req.ip ?? 'unknown';
    const rate = await this.redis.rateLimit(`rate:login:${ip}`, 10, 60);
    if (!rate.allowed) throw new UnauthorizedException('Too many login attempts');
    return this.auth.login(dto.phone, dto.password, { userAgent: req.headers['user-agent'], ipAddress: ip }, res);
  }

  @Public()
  @Post('refresh')
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req.cookies?.refreshToken, res);
  }

  @Post('logout')
  logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(user.sub, user.sessionId, res);
  }

  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return this.auth.logoutAll(user.sub, res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.sub);
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.sessions(user.sub);
  }

  @Post('sessions/revoke')
  revoke(@Body('sessionId') sessionId: string) {
    return this.auth.revokeSession(sessionId);
  }
}
