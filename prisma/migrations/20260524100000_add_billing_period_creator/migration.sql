ALTER TABLE "BillingPeriod"
ADD COLUMN IF NOT EXISTS "createdBy" TEXT;

CREATE INDEX IF NOT EXISTS "BillingPeriod_createdBy_idx" ON "BillingPeriod"("createdBy");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingPeriod_createdBy_fkey') THEN
    ALTER TABLE "BillingPeriod"
      ADD CONSTRAINT "BillingPeriod_createdBy_fkey"
      FOREIGN KEY ("createdBy") REFERENCES "User"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
