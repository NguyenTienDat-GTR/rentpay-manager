UPDATE "Room"
SET "status" = 'OCCUPIED'
WHERE "status" NOT IN ('MAINTENANCE', 'INACTIVE')
  AND "id" IN (
    SELECT DISTINCT rcr."roomId"
    FROM "RentalContractRoom" rcr
    JOIN "RentalContract" rc ON rc."id" = rcr."contractId"
    WHERE rc."status" IN ('PENDING', 'ACTIVE')
  );
