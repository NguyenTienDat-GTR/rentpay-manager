CREATE TABLE "RentalContractRoom" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RentalContractRoom_pkey" PRIMARY KEY ("id")
);

INSERT INTO "RentalContractRoom" ("id", "businessId", "contractId", "roomId")
SELECT CONCAT('cr_', "id"), "businessId", "id", "roomId"
FROM "RentalContract"
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "RentalContractRoom_contractId_roomId_key" ON "RentalContractRoom"("contractId", "roomId");
CREATE INDEX "RentalContractRoom_businessId_idx" ON "RentalContractRoom"("businessId");
CREATE INDEX "RentalContractRoom_roomId_idx" ON "RentalContractRoom"("roomId");

ALTER TABLE "RentalContractRoom"
ADD CONSTRAINT "RentalContractRoom_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RentalContractRoom"
ADD CONSTRAINT "RentalContractRoom_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "RentalContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RentalContractRoom"
ADD CONSTRAINT "RentalContractRoom_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
