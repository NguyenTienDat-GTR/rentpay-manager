import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function main() {
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'TenantType'
      ) THEN
        ALTER TYPE "TenantType" ADD VALUE IF NOT EXISTS 'ELDERLY';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = 'TenantStatus'
      ) THEN
        ALTER TYPE "TenantStatus" ADD VALUE IF NOT EXISTS 'DEPOSITED';
      END IF;
    END $$;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE IF EXISTS "Tenant"
    ADD COLUMN IF NOT EXISTS "roommateCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "roommateType" "TenantType" NOT NULL DEFAULT 'ADULT',
    ADD COLUMN IF NOT EXISTS "roommatePhone" TEXT;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE IF EXISTS "Tenant"
    DROP COLUMN IF EXISTS "tenantType";
  `);

  const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; column_default: string | null }>>(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Tenant'
      AND column_name IN ('roommateCount', 'roommateType', 'roommatePhone')
    ORDER BY column_name;
  `);

  const tenantTypeColumns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Tenant'
      AND column_name = 'tenantType';
  `);

  console.log(JSON.stringify({ tenantRoommateColumns: columns, tenantTypeColumns }, null, 2));
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
