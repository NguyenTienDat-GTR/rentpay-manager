import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BusinessStatus, ChargeStatus, ContractStatus, NotificationAction } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ChargesService } from '../charges/charges.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TenantCreditsService } from '../tenant-credits/tenant-credits.service';

@Injectable()
export class PublicPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly charges: ChargesService,
    private readonly tenantCredits: TenantCreditsService,
  ) {}

  async business(slug: string) {
    const business = await this.prisma.business.findUnique({ where: { businessSlug: slug } });
    if (!business || business.status !== BusinessStatus.ACTIVE) throw new BadRequestException('Payment portal is not available');
    return { businessName: business.businessName, businessSlug: business.businessSlug };
  }

  async lookup(slug: string, body: any, ip?: string) {
    const genericError = new BadRequestException('Không tìm thấy thông tin thanh toán phù hợp');
    const business = await this.prisma.business.findUnique({ where: { businessSlug: slug } });
    if (!business || business.status !== BusinessStatus.ACTIVE) throw genericError;
    const room = await this.prisma.room.findFirst({ where: { businessId: business.id, roomCode: body.roomCode }, include: { roomArea: true } });
    if (!room) throw genericError;
    const contract = await this.prisma.rentalContract.findFirst({
      where: {
        businessId: business.id,
        roomId: room.id,
        status: ContractStatus.ACTIVE,
        representativeTenant: { phone: body.representativePhone },
      },
      include: { representativeTenant: true },
    });
    if (!contract) throw genericError;

    const charges = await this.prisma.charge.findMany({
      where: { businessId: business.id, roomId: room.id, contractId: contract.id },
      include: { items: true },
      orderBy: { dueDate: 'asc' },
    });
    const tokenId = randomUUID();
    const portalAccessToken = await this.jwt.signAsync(
      { tokenId, businessId: business.id, roomId: room.id, contractId: contract.id },
      { secret: this.portalSecret(), expiresIn: '30m' },
    );
    await this.redis.setJson(`portal:${tokenId}`, { businessId: business.id, roomId: room.id, contractId: contract.id }, 1800);
    await this.prisma.notificationLog.create({
      data: {
        businessId: business.id,
        roomId: room.id,
        tenantId: contract.representativeTenantId,
        action: NotificationAction.PUBLIC_LOOKUP,
        metadata: { maskedPhone: maskPhone(body.representativePhone) },
      },
    });
    const enrichedCharges = await this.tenantCredits.enrichCharges(charges);
    return {
      portalAccessToken,
      business: { businessName: business.businessName, businessSlug: business.businessSlug },
      room: { roomCode: room.roomCode, roomArea: room.roomArea },
      charges: enrichedCharges.map((charge) => ({
        ...charge,
        isOverdue: Boolean(charge.dueDate && charge.dueDate < new Date() && ([ChargeStatus.UNPAID, ChargeStatus.PARTIAL] as ChargeStatus[]).includes(charge.status)),
      })),
    };
  }

  async chargeQr(slug: string, chargeId: string, token?: string) {
    const payload = await this.verifyPortalToken(token);
    const business = await this.prisma.business.findUnique({ where: { businessSlug: slug } });
    if (!business || business.id !== payload.businessId) throw new UnauthorizedException('Invalid portal token');
    const charge = await this.prisma.charge.findFirst({
      where: { id: chargeId, businessId: payload.businessId, roomId: payload.roomId, contractId: payload.contractId },
      include: { bankAccount: true },
    });
    if (!charge) throw new BadRequestException('Charge not found');
    if (charge.status === ChargeStatus.PAID || charge.status === ChargeStatus.CANCELLED) {
      throw new BadRequestException(charge.status === ChargeStatus.PAID ? 'Charge is paid' : 'Charge was cancelled');
    }
    return this.charges.renderQr(charge);
  }

  private async verifyPortalToken(token?: string) {
    if (!token) throw new UnauthorizedException('Missing portal token');
    try {
      const payload = await this.jwt.verifyAsync(token, { secret: this.portalSecret() });
      const cached = await this.redis.getJson(`portal:${payload.tokenId}`);
      if (cached) return payload;
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid portal token');
    }
  }

  private portalSecret() {
    return this.config.get<string>('JWT_ACCESS_SECRET') ?? 'change_me_access';
  }
}

function maskPhone(phone = '') {
  return phone.length < 6 ? '***' : `${phone.slice(0, 3)}***${phone.slice(-3)}`;
}
