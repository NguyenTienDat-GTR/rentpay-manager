ALTER TYPE "PaymentMatchStatus" ADD VALUE IF NOT EXISTS 'MANUAL_MATCHED';
ALTER TYPE "PaymentMatchStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "PaymentMatch"
  ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewDecision" JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'PaymentMatch_reviewedBy_fkey'
  ) THEN
    ALTER TABLE "PaymentMatch"
      ADD CONSTRAINT "PaymentMatch_reviewedBy_fkey"
      FOREIGN KEY ("reviewedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "PaymentMatch_reviewedBy_idx" ON "PaymentMatch"("reviewedBy");
