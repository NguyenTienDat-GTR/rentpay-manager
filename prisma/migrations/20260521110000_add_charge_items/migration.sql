-- CreateTable
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
);

-- Backfill one detail line for existing charges so older data remains auditable.
INSERT INTO "ChargeItem" ("id", "businessId", "chargeId", "chargeType", "title", "amount", "createdAt", "updatedAt")
SELECT concat('ci_', md5(random()::text || clock_timestamp()::text || "id")), "businessId", "id", "chargeType", "title", "amountDue", "createdAt", "updatedAt"
FROM "Charge"
WHERE NOT EXISTS (
    SELECT 1
    FROM "ChargeItem"
    WHERE "ChargeItem"."chargeId" = "Charge"."id"
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChargeItem_businessId_chargeType_idx" ON "ChargeItem"("businessId", "chargeType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChargeItem_chargeId_idx" ON "ChargeItem"("chargeId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ChargeItem_businessId_fkey'
    ) THEN
        ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ChargeItem_chargeId_fkey'
    ) THEN
        ALTER TABLE "ChargeItem" ADD CONSTRAINT "ChargeItem_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
