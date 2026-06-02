ALTER TYPE "NotificationAction" ADD VALUE IF NOT EXISTS 'BILLING_PERIOD_AUTO_LOCKED';

CREATE TABLE IF NOT EXISTS "BillingPeriodChargeItemConfig" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "billingPeriodId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "unitLabel" TEXT NOT NULL,
  "unitPrice" DECIMAL(14,2) NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPeriodChargeItemConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillingPeriodChargeItemConfig_billingPeriodId_code_key"
  ON "BillingPeriodChargeItemConfig"("billingPeriodId", "code");
CREATE INDEX IF NOT EXISTS "BillingPeriodChargeItemConfig_businessId_idx"
  ON "BillingPeriodChargeItemConfig"("businessId");
CREATE INDEX IF NOT EXISTS "BillingPeriodChargeItemConfig_billingPeriodId_idx"
  ON "BillingPeriodChargeItemConfig"("billingPeriodId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingPeriodChargeItemConfig_businessId_fkey') THEN
    ALTER TABLE "BillingPeriodChargeItemConfig"
      ADD CONSTRAINT "BillingPeriodChargeItemConfig_businessId_fkey"
      FOREIGN KEY ("businessId") REFERENCES "Business"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingPeriodChargeItemConfig_billingPeriodId_fkey') THEN
    ALTER TABLE "BillingPeriodChargeItemConfig"
      ADD CONSTRAINT "BillingPeriodChargeItemConfig_billingPeriodId_fkey"
      FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "ChargeItem"
  ADD COLUMN IF NOT EXISTS "periodItemConfigId" TEXT,
  ADD COLUMN IF NOT EXISTS "quantity" DECIMAL(14,2) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "unitLabel" TEXT;

UPDATE "ChargeItem"
SET "unitPrice" = "amount"
WHERE "unitPrice" = 0;

CREATE INDEX IF NOT EXISTS "ChargeItem_periodItemConfigId_idx" ON "ChargeItem"("periodItemConfigId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChargeItem_periodItemConfigId_fkey') THEN
    ALTER TABLE "ChargeItem"
      ADD CONSTRAINT "ChargeItem_periodItemConfigId_fkey"
      FOREIGN KEY ("periodItemConfigId") REFERENCES "BillingPeriodChargeItemConfig"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
