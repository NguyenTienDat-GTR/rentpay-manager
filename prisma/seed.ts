import { PrismaClient, Role, ContractStatus, RoomStatus, BillingPeriodStatus, OccupantRole, OccupantStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('123456', 12);

  await prisma.user.upsert({
    where: { phone: '0900000000' },
    update: {},
    create: {
      fullName: 'Super Admin',
      phone: '0900000000',
      passwordHash,
      role: Role.SUPER_ADMIN,
    },
  });

  const business = await prisma.business.upsert({
    where: { businessSlug: 'hkd-nha-tro-minh-an' },
    update: {},
    create: {
      businessName: 'HKD Nha tro Minh An',
      businessSlug: 'hkd-nha-tro-minh-an',
      ownerName: 'Chu ho Minh An',
      address: 'Quan 1, TP HCM',
    },
  });

  await prisma.user.upsert({
    where: { phone: '0901000000' },
    update: { businessId: business.id },
    create: {
      fullName: 'Chu ho Minh An',
      phone: '0901000000',
      passwordHash,
      role: Role.BUSINESS_OWNER,
      businessId: business.id,
    },
  });

  const bankAccount = await prisma.bankAccount.create({
    data: {
      businessId: business.id,
      bankCode: 'MBB',
      bankName: 'MB Bank',
      accountNumber: '123456789',
      accountName: 'HKD NHA TRO MINH AN',
      isDefault: true,
    },
  }).catch(async () => {
    const existing = await prisma.bankAccount.findFirst({ where: { businessId: business.id, accountNumber: '123456789' } });
    if (!existing) throw new Error('Unable to seed bank account');
    return existing;
  });

  const room101 = await prisma.room.upsert({
    where: { businessId_roomCode: { businessId: business.id, roomCode: 'P101' } },
    update: {},
    create: { businessId: business.id, roomCode: 'P101', baseRentAmount: 3500000, depositAmount: 3500000, status: RoomStatus.OCCUPIED },
  });
  const room102 = await prisma.room.upsert({
    where: { businessId_roomCode: { businessId: business.id, roomCode: 'P102' } },
    update: {},
    create: { businessId: business.id, roomCode: 'P102', baseRentAmount: 3800000, depositAmount: 3800000, status: RoomStatus.OCCUPIED },
  });

  const tenantAn = await prisma.tenant.create({
    data: { businessId: business.id, fullName: 'Nguyen Van An', phone: '0901000001' },
  }).catch(() => prisma.tenant.findFirstOrThrow({ where: { businessId: business.id, phone: '0901000001' } }));
  const tenantBinh = await prisma.tenant.create({
    data: { businessId: business.id, fullName: 'Tran Thi Binh', phone: '0901000002' },
  }).catch(() => prisma.tenant.findFirstOrThrow({ where: { businessId: business.id, phone: '0901000002' } }));

  await seedContract(room101.id, tenantAn.id, 3500000);
  await seedContract(room102.id, tenantBinh.id, 3800000);

  await prisma.billingPeriod.upsert({
    where: { businessId_month_year: { businessId: business.id, month: 5, year: 2026 } },
    update: {},
    create: {
      businessId: business.id,
      month: 5,
      year: 2026,
      startDate: new Date('2026-05-01T00:00:00.000Z'),
      endDate: new Date('2026-05-31T23:59:59.999Z'),
      status: BillingPeriodStatus.OPEN,
    },
  });

  console.log('Seed completed');

  async function seedContract(roomId: string, tenantId: string, rentAmount: number) {
    const existing = await prisma.rentalContract.findFirst({ where: { businessId: business.id, roomId, status: ContractStatus.ACTIVE } });
    if (existing) return existing;
    const contract = await prisma.rentalContract.create({
      data: {
        businessId: business.id,
        roomId,
        representativeTenantId: tenantId,
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        rentAmount,
        depositAmount: rentAmount,
        paymentDueDay: 5,
        status: ContractStatus.ACTIVE,
      },
    });
    await prisma.contractOccupant.create({
      data: {
        businessId: business.id,
        contractId: contract.id,
        roomId,
        tenantId,
        role: OccupantRole.REPRESENTATIVE,
        moveInDate: contract.startDate,
        status: OccupantStatus.STAYING,
      },
    });
    return contract;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
