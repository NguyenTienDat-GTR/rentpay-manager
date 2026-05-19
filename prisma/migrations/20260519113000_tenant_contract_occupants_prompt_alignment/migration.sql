CREATE TYPE "OccupantType" AS ENUM ('ADULT', 'CHILD', 'ELDERLY');

ALTER TABLE "Room"
ADD COLUMN IF NOT EXISTS "currentOccupantCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Tenant"
DROP COLUMN IF EXISTS "tenantType";

UPDATE "Tenant"
SET
  "phone" = COALESCE(NULLIF("phone", ''), '0900000000'),
  "identityNumber" = COALESCE(NULLIF("identityNumber", ''), '000000000000'),
  "permanentAddress" = COALESCE(NULLIF("permanentAddress", ''), 'Chưa cập nhật');

ALTER TABLE "Tenant"
ALTER COLUMN "phone" SET NOT NULL,
ALTER COLUMN "identityNumber" SET NOT NULL,
ALTER COLUMN "permanentAddress" SET NOT NULL;

ALTER TABLE "ContractOccupant"
ADD COLUMN IF NOT EXISTS "fullName" TEXT,
ADD COLUMN IF NOT EXISTS "phone" TEXT,
ADD COLUMN IF NOT EXISTS "identityNumber" TEXT,
ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "permanentAddress" TEXT,
ADD COLUMN IF NOT EXISTS "occupantType" "OccupantType" NOT NULL DEFAULT 'ADULT';

UPDATE "ContractOccupant" co
SET
  "fullName" = COALESCE(t."fullName", 'Người ở cùng'),
  "phone" = t."phone",
  "identityNumber" = t."identityNumber",
  "dateOfBirth" = t."dateOfBirth",
  "permanentAddress" = t."permanentAddress"
FROM "Tenant" t
WHERE co."tenantId" = t."id";

DELETE FROM "ContractOccupant"
WHERE "role" = 'REPRESENTATIVE';

UPDATE "ContractOccupant"
SET "fullName" = COALESCE(NULLIF("fullName", ''), 'Người ở cùng');

ALTER TABLE "ContractOccupant"
ALTER COLUMN "fullName" SET NOT NULL;

ALTER TABLE "ContractOccupant"
DROP CONSTRAINT IF EXISTS "ContractOccupant_tenantId_fkey";

ALTER TABLE "ContractOccupant"
DROP COLUMN IF EXISTS "tenantId",
DROP COLUMN IF EXISTS "role";

UPDATE "Room" r
SET "currentOccupantCount" = active_counts.count
FROM (
  SELECT rc."roomId", 1 + COUNT(co."id")::int AS count
  FROM "RentalContract" rc
  LEFT JOIN "ContractOccupant" co ON co."contractId" = rc."id" AND co."status" = 'STAYING'
  WHERE rc."status" = 'ACTIVE'
  GROUP BY rc."roomId"
) active_counts
WHERE r."id" = active_counts."roomId";
