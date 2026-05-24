ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CREDIT';

CREATE TYPE "CreditLedgerType" AS ENUM ('OVERPAYMENT', 'APPLY_TO_CHARGE', 'REFUND');
CREATE TYPE "CreditLedgerStatus" AS ENUM ('POSTED', 'VOIDED');
CREATE TYPE "RefundMethod" AS ENUM ('CASH', 'BANK_TRANSFER');

CREATE TABLE "CreditLedger" (
  "id" TEXT NOT NULL,
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
  "amount" DECIMAL(14, 2) NOT NULL,
  "refundMethod" "RefundMethod",
  "recipientBankName" TEXT,
  "recipientAccountNumber" TEXT,
  "recipientAccountName" TEXT,
  "transferContent" TEXT,
  "transferredAt" TIMESTAMP(3),
  "bankMatchedAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_sourceChargeId_fkey" FOREIGN KEY ("sourceChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_targetChargeId_fkey" FOREIGN KEY ("targetChargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_sourcePaymentId_fkey" FOREIGN KEY ("sourcePaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_targetPaymentId_fkey" FOREIGN KEY ("targetPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CreditLedger_businessId_tenantId_idx" ON "CreditLedger"("businessId", "tenantId");
CREATE INDEX "CreditLedger_businessId_contractId_idx" ON "CreditLedger"("businessId", "contractId");
CREATE INDEX "CreditLedger_businessId_roomId_idx" ON "CreditLedger"("businessId", "roomId");
CREATE INDEX "CreditLedger_sourceChargeId_status_idx" ON "CreditLedger"("sourceChargeId", "status");
CREATE INDEX "CreditLedger_targetChargeId_idx" ON "CreditLedger"("targetChargeId");
CREATE INDEX "CreditLedger_sourcePaymentId_status_idx" ON "CreditLedger"("sourcePaymentId", "status");
CREATE INDEX "CreditLedger_targetPaymentId_status_idx" ON "CreditLedger"("targetPaymentId", "status");
CREATE INDEX "CreditLedger_bankTransactionId_idx" ON "CreditLedger"("bankTransactionId");
CREATE INDEX "CreditLedger_type_status_idx" ON "CreditLedger"("type", "status");
