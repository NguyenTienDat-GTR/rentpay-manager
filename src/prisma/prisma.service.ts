import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    await this.ensureChargeItemsTable();
    await this.ensureRoomAreasSchema();
    await this.ensureBillingPeriodCreatorSchema();
    await this.ensureTenantCreditLedgerSchema();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private async ensureChargeItemsTable() {
    await this.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ChargeItem" (
        "id" TEXT NOT NULL,
        "businessId" TEXT NOT NULL,
        "chargeId" TEXT NOT NULL,
        "chargeType" "ChargeType" NOT NULL,
        "title" TEXT NOT NULL,
        "amount" DECIMAL(14,2) NOT NULL,
        "note" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "ChargeItem_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.$executeRawUnsafe(`
      INSERT INTO "ChargeItem" ("id", "businessId", "chargeId", "chargeType", "title", "amount", "createdAt", "updatedAt")
      SELECT concat('ci_', md5(random()::text || clock_timestamp()::text || "id")), "businessId", "id", "chargeType", "title", "amountDue", "createdAt", "updatedAt"
      FROM "Charge"
      WHERE NOT EXISTS (
        SELECT 1
        FROM "ChargeItem"
        WHERE "ChargeItem"."chargeId" = "Charge"."id"
      )
    `);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ChargeItem_businessId_chargeType_idx" ON "ChargeItem"("businessId", "chargeType")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ChargeItem_chargeId_idx" ON "ChargeItem"("chargeId")`);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChargeItem_businessId_fkey') THEN
          ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChargeItem_chargeId_fkey') THEN
          ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
        END IF;
      END $$
    `);
  }

  private async ensureRoomAreasSchema() {
    await this.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "RoomArea" (
        "id" TEXT NOT NULL,
        "businessId" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "RoomArea_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RoomArea_businessId_idx" ON "RoomArea"("businessId")`);
    await this.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "RoomArea_businessId_name_key" ON "RoomArea"("businessId", "name")`);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RoomArea_businessId_fkey') THEN
          ALTER TABLE "RoomArea" ADD CONSTRAINT "RoomArea_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`ALTER TABLE "Room" ADD COLUMN IF NOT EXISTS "roomAreaId" TEXT`);
    await this.backfillRoomAreas();
    await this.$executeRawUnsafe(`DROP INDEX IF EXISTS "Room_businessId_roomCode_key"`);
    await this.syncRoomCodesWithAreas();
    await this.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Room_businessId_roomAreaId_roomCode_key" ON "Room"("businessId", "roomAreaId", "roomCode")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Room_roomAreaId_idx" ON "Room"("roomAreaId")`);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Room_roomAreaId_fkey') THEN
          ALTER TABLE "Room" ADD CONSTRAINT "Room_roomAreaId_fkey" FOREIGN KEY ("roomAreaId") REFERENCES "RoomArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`ALTER TABLE "Room" ALTER COLUMN "roomAreaId" SET NOT NULL`);
    await this.$executeRawUnsafe(`ALTER TABLE "Room" DROP COLUMN IF EXISTS "name"`);
    await this.$executeRawUnsafe(`ALTER TABLE "Room" DROP COLUMN IF EXISTS "floor"`);
  }

  private async ensureBillingPeriodCreatorSchema() {
    await this.$executeRawUnsafe(`ALTER TABLE "BillingPeriod" ADD COLUMN IF NOT EXISTS "createdBy" TEXT`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BillingPeriod_createdBy_idx" ON "BillingPeriod"("createdBy")`);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingPeriod_createdBy_fkey') THEN
          ALTER TABLE "BillingPeriod"
            ADD CONSTRAINT "BillingPeriod_createdBy_fkey"
            FOREIGN KEY ("createdBy") REFERENCES "User"("id")
            ON DELETE SET NULL
            ON UPDATE CASCADE;
        END IF;
      END $$
    `);
  }

  private async ensureTenantCreditLedgerSchema() {
    await this.$executeRawUnsafe(`ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CREDIT'`);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditLedgerType') THEN
          CREATE TYPE "CreditLedgerType" AS ENUM ('OVERPAYMENT', 'APPLY_TO_CHARGE', 'REFUND');
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditLedgerStatus') THEN
          CREATE TYPE "CreditLedgerStatus" AS ENUM ('POSTED', 'VOIDED');
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantCreditActivityType') THEN
          CREATE TYPE "TenantCreditActivityType" AS ENUM ('APPLY_TO_CHARGE', 'REFUND');
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantCreditActivityStatus') THEN
          CREATE TYPE "TenantCreditActivityStatus" AS ENUM ('POSTED', 'VOIDED');
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RefundMethod') THEN
          CREATE TYPE "RefundMethod" AS ENUM ('CASH', 'BANK_TRANSFER');
        END IF;
      END $$
    `);
    await this.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CreditLedger" (
        "id" TEXT NOT NULL,
        "activityId" TEXT,
        "businessId" TEXT NOT NULL,
        "tenantId" TEXT,
        "contractId" TEXT,
        "roomId" TEXT NOT NULL,
        "sourceChargeId" TEXT,
        "targetChargeId" TEXT,
        "sourcePaymentId" TEXT,
        "targetPaymentId" TEXT,
        "bankTransactionId" TEXT,
        "type" "CreditLedgerType" NOT NULL,
        "status" "CreditLedgerStatus" NOT NULL DEFAULT 'POSTED',
        "amount" DECIMAL(14,2) NOT NULL,
        "refundMethod" "RefundMethod",
        "recipientBankName" TEXT,
        "recipientAccountNumber" TEXT,
        "recipientAccountName" TEXT,
        "transferContent" TEXT,
        "transferredAt" TIMESTAMP(3),
        "bankMatchedAt" TIMESTAMP(3),
        "note" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.$executeRawUnsafe(`ALTER TABLE "CreditLedger" ADD COLUMN IF NOT EXISTS "activityId" TEXT`);
    await this.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TenantCreditActivity" (
        "id" TEXT NOT NULL,
        "activityCode" TEXT NOT NULL DEFAULT ('RF-' || to_char(CURRENT_TIMESTAMP, 'YYYYMMDD') || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))),
        "businessId" TEXT NOT NULL,
        "tenantId" TEXT,
        "contractId" TEXT,
        "roomId" TEXT NOT NULL,
        "sourceChargeId" TEXT,
        "targetChargeId" TEXT,
        "ownerBankAccountId" TEXT,
        "bankTransactionId" TEXT,
        "type" "TenantCreditActivityType" NOT NULL,
        "status" "TenantCreditActivityStatus" NOT NULL DEFAULT 'POSTED',
        "amount" DECIMAL(14,2) NOT NULL,
        "refundMethod" "RefundMethod",
        "recipientBankName" TEXT,
        "recipientAccountNumber" TEXT,
        "recipientAccountName" TEXT,
        "transferContent" TEXT,
        "transferredAt" TIMESTAMP(3),
        "bankMatchedAt" TIMESTAMP(3),
        "note" TEXT,
        "createdBy" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "TenantCreditActivity_pkey" PRIMARY KEY ("id")
      )
    `);
    await this.$executeRawUnsafe(`
      ALTER TABLE "TenantCreditActivity"
        ADD COLUMN IF NOT EXISTS "activityCode" TEXT,
        ADD COLUMN IF NOT EXISTS "businessId" TEXT,
        ADD COLUMN IF NOT EXISTS "tenantId" TEXT,
        ADD COLUMN IF NOT EXISTS "contractId" TEXT,
        ADD COLUMN IF NOT EXISTS "roomId" TEXT,
        ADD COLUMN IF NOT EXISTS "sourceChargeId" TEXT,
        ADD COLUMN IF NOT EXISTS "targetChargeId" TEXT,
        ADD COLUMN IF NOT EXISTS "ownerBankAccountId" TEXT,
        ADD COLUMN IF NOT EXISTS "bankTransactionId" TEXT,
        ADD COLUMN IF NOT EXISTS "type" "TenantCreditActivityType" NOT NULL DEFAULT 'REFUND',
        ADD COLUMN IF NOT EXISTS "status" "TenantCreditActivityStatus" NOT NULL DEFAULT 'POSTED',
        ADD COLUMN IF NOT EXISTS "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "refundMethod" "RefundMethod",
        ADD COLUMN IF NOT EXISTS "recipientBankName" TEXT,
        ADD COLUMN IF NOT EXISTS "recipientAccountNumber" TEXT,
        ADD COLUMN IF NOT EXISTS "recipientAccountName" TEXT,
        ADD COLUMN IF NOT EXISTS "transferContent" TEXT,
        ADD COLUMN IF NOT EXISTS "transferredAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "bankMatchedAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "note" TEXT,
        ADD COLUMN IF NOT EXISTS "createdBy" TEXT,
        ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    `);
    await this.$executeRawUnsafe(`
      UPDATE "TenantCreditActivity"
      SET "activityCode" = CASE WHEN "type" = 'REFUND' THEN 'RF-' ELSE 'CR-' END || TO_CHAR("createdAt", 'YYYYMMDD') || '-' || UPPER(SUBSTRING(md5("id") FROM 1 FOR 6))
      WHERE "activityCode" IS NULL
    `);
    await this.$executeRawUnsafe(`ALTER TABLE "TenantCreditActivity" ALTER COLUMN "activityCode" SET NOT NULL`);
    const constraints = [
      ['CreditLedger', 'CreditLedger_businessId_fkey', 'FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_tenantId_fkey', 'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_contractId_fkey', 'FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_roomId_fkey', 'FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_sourceChargeId_fkey', 'FOREIGN KEY ("sourceChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_targetChargeId_fkey', 'FOREIGN KEY ("targetChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_sourcePaymentId_fkey', 'FOREIGN KEY ("sourcePaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_targetPaymentId_fkey', 'FOREIGN KEY ("targetPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_bankTransactionId_fkey', 'FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['CreditLedger', 'CreditLedger_activityId_fkey', 'FOREIGN KEY ("activityId") REFERENCES "TenantCreditActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_businessId_fkey', 'FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_tenantId_fkey', 'FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_contractId_fkey', 'FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_roomId_fkey', 'FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_sourceChargeId_fkey', 'FOREIGN KEY ("sourceChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_targetChargeId_fkey', 'FOREIGN KEY ("targetChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_ownerBankAccountId_fkey', 'FOREIGN KEY ("ownerBankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_createdBy_fkey', 'FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
      ['TenantCreditActivity', 'TenantCreditActivity_bankTransactionId_fkey', 'FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE'],
    ];
    for (const [table, name, definition] of constraints) {
      await this.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
            ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${definition};
          END IF;
        END $$
      `);
    }
    await this.backfillTenantCreditActivities();
    await this.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "TenantCreditActivity_activityCode_key" ON "TenantCreditActivity"("activityCode")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_activityId_idx" ON "CreditLedger"("activityId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_businessId_tenantId_idx" ON "CreditLedger"("businessId", "tenantId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_businessId_contractId_idx" ON "CreditLedger"("businessId", "contractId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_businessId_roomId_idx" ON "CreditLedger"("businessId", "roomId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_sourceChargeId_status_idx" ON "CreditLedger"("sourceChargeId", "status")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_targetChargeId_idx" ON "CreditLedger"("targetChargeId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_sourcePaymentId_status_idx" ON "CreditLedger"("sourcePaymentId", "status")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_targetPaymentId_status_idx" ON "CreditLedger"("targetPaymentId", "status")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_bankTransactionId_idx" ON "CreditLedger"("bankTransactionId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditLedger_type_status_idx" ON "CreditLedger"("type", "status")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_businessId_tenantId_idx" ON "TenantCreditActivity"("businessId", "tenantId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_businessId_contractId_idx" ON "TenantCreditActivity"("businessId", "contractId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_businessId_roomId_idx" ON "TenantCreditActivity"("businessId", "roomId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_sourceChargeId_idx" ON "TenantCreditActivity"("sourceChargeId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_targetChargeId_idx" ON "TenantCreditActivity"("targetChargeId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_ownerBankAccountId_idx" ON "TenantCreditActivity"("ownerBankAccountId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_bankTransactionId_idx" ON "TenantCreditActivity"("bankTransactionId")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_createdBy_idx" ON "TenantCreditActivity"("createdBy")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_type_status_idx" ON "TenantCreditActivity"("type", "status")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_refundMethod_idx" ON "TenantCreditActivity"("refundMethod")`);
    await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TenantCreditActivity_createdAt_idx" ON "TenantCreditActivity"("createdAt")`);
  }

  private async backfillTenantCreditActivities() {
    await this.$executeRawUnsafe(`
      INSERT INTO "TenantCreditActivity" (
        "id",
        "activityCode",
        "businessId",
        "tenantId",
        "contractId",
        "roomId",
        "sourceChargeId",
        "targetChargeId",
        "bankTransactionId",
        "type",
        "status",
        "amount",
        "refundMethod",
        "recipientBankName",
        "recipientAccountNumber",
        "recipientAccountName",
        "transferContent",
        "transferredAt",
        "bankMatchedAt",
        "note",
        "createdAt",
        "updatedAt"
      )
      SELECT
        'tca_' || md5("id"),
        CASE WHEN "type" = 'REFUND' THEN 'RF-' ELSE 'CR-' END || TO_CHAR("createdAt", 'YYYYMMDD') || '-' || UPPER(SUBSTRING(md5("id") FROM 1 FOR 6)),
        "businessId",
        "tenantId",
        "contractId",
        "roomId",
        "sourceChargeId",
        "targetChargeId",
        "bankTransactionId",
        "type"::text::"TenantCreditActivityType",
        "status"::text::"TenantCreditActivityStatus",
        ABS("amount"),
        "refundMethod",
        "recipientBankName",
        "recipientAccountNumber",
        "recipientAccountName",
        "transferContent",
        "transferredAt",
        "bankMatchedAt",
        "note",
        "createdAt",
        "updatedAt"
      FROM "CreditLedger"
      WHERE "type" IN ('APPLY_TO_CHARGE', 'REFUND')
        AND "activityId" IS NULL
      ON CONFLICT ("id") DO NOTHING
    `);
    await this.$executeRawUnsafe(`
      UPDATE "CreditLedger"
      SET "activityId" = 'tca_' || md5("id")
      WHERE "type" IN ('APPLY_TO_CHARGE', 'REFUND')
        AND "activityId" IS NULL
    `);
  }

  private async backfillRoomAreas() {
    const [roomCount] = await this.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT COUNT(*)::bigint AS count FROM "Room"`);
    if (!roomCount || Number(roomCount.count) === 0) return;

    const [{ exists: hasFloorColumn }] = await this.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'Room'
          AND column_name = 'floor'
      )
    `);
    const fallbackAreaSql = hasFloorColumn ? `COALESCE(NULLIF(TRIM("floor"), ''), 'Chưa phân khu')` : `'Chưa phân khu'`;
    const areaCaseSql = `
      CASE
        WHEN TRIM("roomCode") ~ '-' THEN REGEXP_REPLACE(TRIM("roomCode"), '-[^-]+$', '')
        WHEN TRIM("roomCode") ~ '^[[:alpha:]]+[0-9].*$' THEN REGEXP_REPLACE(TRIM("roomCode"), '[0-9].*$', '')
        ELSE ${fallbackAreaSql}
      END
    `;

    await this.$executeRawUnsafe(`
      WITH "NormalizedRoom" AS (
        SELECT "businessId", "createdAt", ${areaCaseSql} AS "areaName"
        FROM "Room"
      )
      INSERT INTO "RoomArea" ("id", "businessId", "name", "createdAt", "updatedAt")
      SELECT
        'room-area-' || md5("businessId" || ':' || "areaName"),
        "businessId",
        "areaName",
        MIN("createdAt"),
        NOW()
      FROM "NormalizedRoom"
      GROUP BY "businessId", "areaName"
      ON CONFLICT ("businessId", "name") DO NOTHING
    `);
    await this.$executeRawUnsafe(`
      WITH "NormalizedRoom" AS (
        SELECT "id", "businessId", ${areaCaseSql} AS "areaName"
        FROM "Room"
      )
      UPDATE "Room"
      SET "roomAreaId" = "RoomArea"."id"
      FROM "NormalizedRoom"
      JOIN "RoomArea"
        ON "RoomArea"."businessId" = "NormalizedRoom"."businessId"
        AND "RoomArea"."name" = "NormalizedRoom"."areaName"
      WHERE "Room"."id" = "NormalizedRoom"."id"
        AND "Room"."roomAreaId" IS NULL
    `);
  }

  private async syncRoomCodesWithAreas() {
    await this.$executeRawUnsafe(`
      WITH "TargetCodes" AS (
        SELECT
          "Room"."id",
          "Room"."businessId",
          "Room"."roomAreaId",
          "Room"."roomCode",
          UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM("RoomArea"."name"), '[\\s_/]+', '-', 'g'), '-+', '-', 'g')) AS "areaPrefix",
          UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM("Room"."roomCode"), '[\\s_/]+', '-', 'g'), '-+', '-', 'g')) AS "normalizedCode"
        FROM "Room"
        JOIN "RoomArea" ON "RoomArea"."id" = "Room"."roomAreaId"
      ),
      "NextCodes" AS (
        SELECT
          "id",
          "businessId",
          "roomAreaId",
          "roomCode",
          "areaPrefix" || '-' ||
            CASE
              WHEN "normalizedCode" = "areaPrefix" THEN "areaPrefix"
              WHEN "normalizedCode" LIKE "areaPrefix" || '-%' THEN SUBSTRING("normalizedCode" FROM LENGTH("areaPrefix") + 2)
              WHEN "normalizedCode" ~ '-' THEN REGEXP_REPLACE("normalizedCode", '^.*-', '')
              WHEN "normalizedCode" LIKE "areaPrefix" || '%' AND SUBSTRING("normalizedCode" FROM LENGTH("areaPrefix") + 1) ~ '^[0-9]+$' THEN SUBSTRING("normalizedCode" FROM LENGTH("areaPrefix") + 1)
              ELSE "normalizedCode"
            END AS "nextRoomCode"
        FROM "TargetCodes"
        WHERE "areaPrefix" <> ''
      ),
      "SafeNextCodes" AS (
        SELECT
          *,
          COUNT(*) OVER (PARTITION BY "businessId", "roomAreaId", "nextRoomCode") AS "duplicateCount"
        FROM "NextCodes"
      )
      UPDATE "Room"
      SET "roomCode" = "SafeNextCodes"."nextRoomCode"
      FROM "SafeNextCodes"
      WHERE "Room"."id" = "SafeNextCodes"."id"
        AND "SafeNextCodes"."duplicateCount" = 1
        AND "Room"."roomCode" <> "SafeNextCodes"."nextRoomCode"
    `);
  }
}
