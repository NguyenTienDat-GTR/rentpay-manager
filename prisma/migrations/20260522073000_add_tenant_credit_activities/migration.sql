DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantCreditActivityType') THEN
    CREATE TYPE "TenantCreditActivityType" AS ENUM ('APPLY_TO_CHARGE', 'REFUND');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantCreditActivityStatus') THEN
    CREATE TYPE "TenantCreditActivityStatus" AS ENUM ('POSTED', 'VOIDED');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "CreditLedger" ADD COLUMN IF NOT EXISTS "activityId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TenantCreditActivity" (
  "id" TEXT NOT NULL,
  "activityCode" TEXT NOT NULL,
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
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantCreditActivity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TenantCreditActivity" ADD COLUMN IF NOT EXISTS "activityCode" TEXT;
ALTER TABLE "TenantCreditActivity" ADD COLUMN IF NOT EXISTS "ownerBankAccountId" TEXT;

-- Backfill one activity per legacy apply/refund ledger.
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
  AND "activityId" IS NULL;

UPDATE "CreditLedger"
SET "activityId" = 'tca_' || md5("id")
WHERE "type" IN ('APPLY_TO_CHARGE', 'REFUND')
  AND "activityId" IS NULL;

UPDATE "TenantCreditActivity"
SET "activityCode" = CASE WHEN "type" = 'REFUND' THEN 'RF-' ELSE 'CR-' END || TO_CHAR("createdAt", 'YYYYMMDD') || '-' || UPPER(SUBSTRING(md5("id") FROM 1 FOR 6))
WHERE "activityCode" IS NULL;

ALTER TABLE "TenantCreditActivity" ALTER COLUMN "activityCode" SET NOT NULL;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_businessId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_tenantId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_contractId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_roomId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_sourceChargeId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_sourceChargeId_fkey" FOREIGN KEY ("sourceChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_targetChargeId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_targetChargeId_fkey" FOREIGN KEY ("targetChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_ownerBankAccountId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_ownerBankAccountId_fkey" FOREIGN KEY ("ownerBankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_createdBy_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantCreditActivity_bankTransactionId_fkey') THEN
    ALTER TABLE "TenantCreditActivity" ADD CONSTRAINT "TenantCreditActivity_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditLedger_activityId_fkey') THEN
    ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "TenantCreditActivity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TenantCreditActivity_activityCode_key" ON "TenantCreditActivity"("activityCode");
CREATE INDEX IF NOT EXISTS "CreditLedger_activityId_idx" ON "CreditLedger"("activityId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_businessId_tenantId_idx" ON "TenantCreditActivity"("businessId", "tenantId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_businessId_contractId_idx" ON "TenantCreditActivity"("businessId", "contractId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_businessId_roomId_idx" ON "TenantCreditActivity"("businessId", "roomId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_sourceChargeId_idx" ON "TenantCreditActivity"("sourceChargeId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_targetChargeId_idx" ON "TenantCreditActivity"("targetChargeId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_ownerBankAccountId_idx" ON "TenantCreditActivity"("ownerBankAccountId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_bankTransactionId_idx" ON "TenantCreditActivity"("bankTransactionId");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_createdBy_idx" ON "TenantCreditActivity"("createdBy");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_type_status_idx" ON "TenantCreditActivity"("type", "status");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_refundMethod_idx" ON "TenantCreditActivity"("refundMethod");
CREATE INDEX IF NOT EXISTS "TenantCreditActivity_createdAt_idx" ON "TenantCreditActivity"("createdAt");
