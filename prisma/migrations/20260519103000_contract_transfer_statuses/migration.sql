DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantStatus_new') THEN
    CREATE TYPE "TenantStatus_new" AS ENUM ('DEPOSITED', 'STAYING', 'LEFT');
  END IF;
END $$;

ALTER TABLE "Tenant"
ADD COLUMN IF NOT EXISTS "tenantType" "TenantType" NOT NULL DEFAULT 'ADULT';

ALTER TABLE "Tenant"
ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Tenant"
ALTER COLUMN "status" TYPE "TenantStatus_new"
USING (
  CASE
    WHEN "status"::text = 'ACTIVE' THEN 'STAYING'
    WHEN "status"::text = 'DEPOSITED' THEN 'DEPOSITED'
    WHEN "status"::text = 'LEFT' THEN 'LEFT'
    ELSE 'DEPOSITED'
  END
)::"TenantStatus_new";

ALTER TABLE "Tenant"
ALTER COLUMN "status" SET DEFAULT 'DEPOSITED';

DROP TYPE IF EXISTS "TenantStatus";
ALTER TYPE "TenantStatus_new" RENAME TO "TenantStatus";

ALTER TYPE "ContractStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "Tenant"
DROP COLUMN IF EXISTS "roommateCount",
DROP COLUMN IF EXISTS "roommateType",
DROP COLUMN IF EXISTS "roommatePhone";
