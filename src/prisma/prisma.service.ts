import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
    await this.ensureChargeItemsTable();
    await this.ensureRoomAreasSchema();
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
