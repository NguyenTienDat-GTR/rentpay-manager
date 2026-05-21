CREATE TABLE "RoomArea" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomArea_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RoomArea_businessId_idx" ON "RoomArea"("businessId");
CREATE UNIQUE INDEX "RoomArea_businessId_name_key" ON "RoomArea"("businessId", "name");

ALTER TABLE "RoomArea" ADD CONSTRAINT "RoomArea_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

WITH "NormalizedRoom" AS (
    SELECT
        "businessId",
        "createdAt",
        CASE
            WHEN TRIM("roomCode") ~ '-' THEN REGEXP_REPLACE(TRIM("roomCode"), '-[^-]+$', '')
            WHEN TRIM("roomCode") ~ '^[[:alpha:]]+[0-9].*$' THEN REGEXP_REPLACE(TRIM("roomCode"), '[0-9].*$', '')
            ELSE COALESCE(NULLIF(TRIM("floor"), ''), 'Chưa phân khu')
        END AS "areaName"
    FROM "Room"
)
INSERT INTO "RoomArea" ("id", "businessId", "name", "createdAt", "updatedAt")
SELECT
    'room-area-' || md5("businessId" || ':' || "areaName"),
    "businessId",
    "areaName" AS "name",
    MIN("createdAt") AS "createdAt",
    NOW() AS "updatedAt"
FROM "NormalizedRoom"
GROUP BY "businessId", "areaName"
ON CONFLICT ("businessId", "name") DO NOTHING;

ALTER TABLE "Room" ADD COLUMN "roomAreaId" TEXT;

WITH "NormalizedRoom" AS (
    SELECT
        "id",
        "businessId",
        CASE
            WHEN TRIM("roomCode") ~ '-' THEN REGEXP_REPLACE(TRIM("roomCode"), '-[^-]+$', '')
            WHEN TRIM("roomCode") ~ '^[[:alpha:]]+[0-9].*$' THEN REGEXP_REPLACE(TRIM("roomCode"), '[0-9].*$', '')
            ELSE COALESCE(NULLIF(TRIM("floor"), ''), 'Chưa phân khu')
        END AS "areaName"
    FROM "Room"
)
UPDATE "Room"
SET "roomAreaId" = "RoomArea"."id"
FROM "NormalizedRoom"
JOIN "RoomArea"
    ON "RoomArea"."businessId" = "NormalizedRoom"."businessId"
    AND "RoomArea"."name" = "NormalizedRoom"."areaName"
WHERE "Room"."id" = "NormalizedRoom"."id";

ALTER TABLE "Room" ALTER COLUMN "roomAreaId" SET NOT NULL;

DROP INDEX IF EXISTS "Room_businessId_roomCode_key";

CREATE UNIQUE INDEX "Room_businessId_roomAreaId_roomCode_key" ON "Room"("businessId", "roomAreaId", "roomCode");
CREATE INDEX "Room_roomAreaId_idx" ON "Room"("roomAreaId");

ALTER TABLE "Room" ADD CONSTRAINT "Room_roomAreaId_fkey" FOREIGN KEY ("roomAreaId") REFERENCES "RoomArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Room" DROP COLUMN "name";
ALTER TABLE "Room" DROP COLUMN "floor";
