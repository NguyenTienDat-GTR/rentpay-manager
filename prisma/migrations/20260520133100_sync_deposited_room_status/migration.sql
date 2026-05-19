UPDATE "Room" r
SET "status" = 'DEPOSITED'
WHERE "status" = 'OCCUPIED'
  AND EXISTS (
    SELECT 1
    FROM "RentalContractRoom" rcr
    JOIN "RentalContract" rc ON rc."id" = rcr."contractId"
    WHERE rcr."roomId" = r."id"
      AND rc."status" IN ('PENDING', 'ACTIVE')
      AND (rc."status" = 'PENDING' OR rc."startDate"::date > CURRENT_DATE)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "RentalContractRoom" rcr
    JOIN "RentalContract" rc ON rc."id" = rcr."contractId"
    WHERE rcr."roomId" = r."id"
      AND rc."status" = 'ACTIVE'
      AND rc."startDate"::date <= CURRENT_DATE
  );
