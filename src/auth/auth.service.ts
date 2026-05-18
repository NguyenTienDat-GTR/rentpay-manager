import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthSession, Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

type TokenUser = Pick<User, 'id' | 'role' | 'businessId'>;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async login(phone: string, password: string, meta: { userAgent?: string; ipAddress?: string }, res: Response) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid phone or password');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid phone or password');

    const tokens = await this.createSession(user, meta);
    this.setCookies(res, tokens.accessToken, tokens.refreshToken);
    await this.audit.log({ businessId: user.businessId, userId: user.id, action: 'LOGIN', entity: 'AuthSession', entityId: tokens.session.id });
    return this.me(user.id);
  }

  async refresh(refreshToken: string | undefined, res: Response) {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    let payload: { sub: string; sessionId: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET') ?? 'change_me_refresh',
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const session = await this.prisma.authSession.findUnique({ where: { id: payload.sessionId }, include: { user: true } });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh session');
    }

    const matches = await bcrypt.compare(refreshToken, session.refreshTokenHash);
    if (!matches) {
      await this.revokeAll(payload.sub);
      throw new ForbiddenException('Refresh token reuse detected');
    }

    const tokens = await this.rotateSession(session, session.user);
    this.setCookies(res, tokens.accessToken, tokens.refreshToken);
    await this.audit.log({ businessId: session.user.businessId, userId: session.userId, action: 'REFRESH_TOKEN', entity: 'AuthSession', entityId: session.id });
    return this.me(session.userId);
  }

  async logout(userId: string, sessionId: string, res: Response) {
    await this.revokeSession(sessionId);
    this.clearCookies(res);
    await this.audit.log({ userId, action: 'LOGOUT', entity: 'AuthSession', entityId: sessionId });
    return { ok: true };
  }

  async logoutAll(userId: string, res: Response) {
    await this.revokeAll(userId);
    this.clearCookies(res);
    await this.audit.log({ userId, action: 'LOGOUT_ALL', entity: 'AuthSession' });
    return { ok: true };
  }

  async sessions(userId: string) {
    return this.prisma.authSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, expiresAt: true, revokedAt: true, createdAt: true, updatedAt: true },
    });
  }

  async revokeSession(sessionId: string) {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.redis.del(`auth:session:${sessionId}`);
  }

  async revokeAll(userId: string) {
    const sessions = await this.prisma.authSession.findMany({ where: { userId, revokedAt: null }, select: { id: true } });
    await this.prisma.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await Promise.all(sessions.map((session) => this.redis.del(`auth:session:${session.id}`)));
    await this.redis.del(`auth:user_sessions:${userId}`);
  }

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fullName: true, phone: true, role: true, businessId: true, isActive: true, business: true },
    });
  }

  private async createSession(user: TokenUser, meta: { userAgent?: string; ipAddress?: string }) {
    const sessionId = randomUUID();
    const refreshToken = await this.signRefreshToken(user, sessionId);
    const refreshTokenHash = await bcrypt.hash(refreshToken, 12);
    const expiresAt = new Date(Date.now() + this.refreshTtlMs());

    const session = await this.prisma.authSession.create({
      data: { id: sessionId, userId: user.id, refreshTokenHash, userAgent: meta.userAgent, ipAddress: meta.ipAddress, expiresAt },
    });
    await this.mirrorSession(session);

    return {
      accessToken: await this.signAccessToken(user, sessionId),
      refreshToken,
      session,
    };
  }

  private async rotateSession(session: AuthSession, user: TokenUser) {
    const refreshToken = await this.signRefreshToken(user, session.id);
    const refreshTokenHash = await bcrypt.hash(refreshToken, 12);
    const expiresAt = new Date(Date.now() + this.refreshTtlMs());
    const updated = await this.prisma.authSession.update({
      where: { id: session.id },
      data: { refreshTokenHash, expiresAt },
    });
    await this.mirrorSession(updated);
    return {
      accessToken: await this.signAccessToken(user, session.id),
      refreshToken,
    };
  }

  private signAccessToken(user: TokenUser, sessionId: string) {
    return this.jwt.signAsync(
      { sub: user.id, role: user.role, businessId: user.businessId, sessionId },
      {
        secret: this.config.get<string>('JWT_ACCESS_SECRET') ?? 'change_me_access',
        expiresIn: (this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m') as any,
      },
    );
  }

  private signRefreshToken(user: TokenUser, sessionId: string) {
    return this.jwt.signAsync(
      { sub: user.id, role: user.role, sessionId },
      {
        secret: this.config.get<string>('JWT_REFRESH_SECRET') ?? 'change_me_refresh',
        expiresIn: (this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d') as any,
        jwtid: randomUUID(),
      },
    );
  }

  private setCookies(res: Response, accessToken: string, refreshToken: string) {
    const secure = this.config.get<string>('COOKIE_SECURE') === 'true';
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: this.accessTtlMs(),
    });
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/api/auth',
      maxAge: this.refreshTtlMs(),
    });
  }

  private clearCookies(res: Response) {
    res.clearCookie('accessToken', { path: '/' });
    res.clearCookie('refreshToken', { path: '/api/auth' });
  }

  private async mirrorSession(session: AuthSession) {
    const ttl = Math.max(Math.floor((session.expiresAt.getTime() - Date.now()) / 1000), 1);
    await this.redis.setJson(`auth:session:${session.id}`, session, ttl);
    await this.redis.sadd(`auth:user_sessions:${session.userId}`, session.id, ttl);
  }

  private accessTtlMs() {
    return parseDuration(this.config.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m');
  }

  private refreshTtlMs() {
    return parseDuration(this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d');
  }
}

function parseDuration(value: string) {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return 15 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}
