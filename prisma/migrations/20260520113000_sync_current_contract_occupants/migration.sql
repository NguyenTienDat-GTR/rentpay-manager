UPDATE "Tenant" t
SET "status" = 'STAYING'
WHERE EXISTS (
  SELECT 1
  FROM "RentalContract" rc
  WHERE rc."representativeTenantId" = t."id"
    AND rc."businessId" = t."businessId"
    AND rc."status" = 'ACTIVE'
    AND rc."startDate" <= NOW()
);

UPDATE "ContractOccupant" co
SET "status" = 'STAYING'
FROM "RentalContract" rc
WHERE rc."id" = co."contractId"
  AND co."businessId" = rc."businessId"
  AND rc."status" = 'ACTIVE'
  AND rc."startDate" <= NOW()
  AND co."status" = 'DEPOSITED';

UPDATE "Room" r
SET "status" = 'OCCUPIED',
    "currentOccupantCount" = active_counts.count
FROM (
  SELECT room_counts."roomId", SUM(room_counts.count)::integer AS count
  FROM (
    SELECT rc."id" AS "contractId", rc."roomId", 1 AS count
    FROM "RentalContract" rc
    WHERE rc."status" = 'ACTIVE'
      AND rc."startDate" <= NOW()
    UNION ALL
    SELECT co."contractId", co."roomId", COUNT(*)::integer AS count
    FROM "ContractOccupant" co
    JOIN "RentalContract" rc ON rc."id" = co."contractId"
    WHERE rc."status" = 'ACTIVE'
      AND rc."startDate" <= NOW()
      AND co."status" = 'STAYING'
    GROUP BY co."contractId", co."roomId"
  ) room_counts
  GROUP BY room_counts."roomId"
) active_counts
WHERE r."id" = active_counts."roomId";
