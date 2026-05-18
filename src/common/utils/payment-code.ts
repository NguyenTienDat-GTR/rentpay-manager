import { randomBytes } from 'crypto';
import { ChargeType } from '@prisma/client';

export function makePaymentCode() {
  return `RTP-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
}

export function transferPrefix(type: ChargeType) {
  const map: Record<ChargeType, string> = {
    ROOM_RENT: 'THUE',
    DEPOSIT: 'COC',
    ELECTRICITY: 'DIEN',
    WATER: 'NUOC',
    PARKING: 'XE',
    INTERNET: 'NET',
    GARBAGE: 'RAC',
    CLEANING: 'VS',
    DAMAGE_FEE: 'DENBU',
    OTHER: 'KHAC',
  };
  return map[type] ?? 'KHAC';
}

export function buildTransferContent(type: ChargeType, paymentCode: string) {
  return `${transferPrefix(type)} ${paymentCode}`;
}
