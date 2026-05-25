ALTER TABLE "Tenant"
  ALTER COLUMN "dateOfBirth" TYPE DATE USING "dateOfBirth"::date;

ALTER TABLE "RentalContract"
  ALTER COLUMN "startDate" TYPE DATE USING "startDate"::date,
  ALTER COLUMN "endDate" TYPE DATE USING "endDate"::date;

ALTER TABLE "ContractOccupant"
  ALTER COLUMN "dateOfBirth" TYPE DATE USING "dateOfBirth"::date,
  ALTER COLUMN "moveInDate" TYPE DATE USING "moveInDate"::date,
  ALTER COLUMN "moveOutDate" TYPE DATE USING "moveOutDate"::date;
