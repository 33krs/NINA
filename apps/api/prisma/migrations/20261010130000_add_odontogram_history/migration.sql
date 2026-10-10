-- Add the current version counter and preserve each existing state as baseline version zero.
ALTER TABLE "Odontogram"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OdontogramRevision" (
    "id" TEXT NOT NULL,
    "odontogramId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "teethStates" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OdontogramRevision_pkey" PRIMARY KEY ("id")
);

INSERT INTO "OdontogramRevision" ("id", "odontogramId", "version", "teethStates", "createdAt")
SELECT 'baseline-' || "id", "id", 0, "teethStates", "updatedAt"
FROM "Odontogram";

CREATE UNIQUE INDEX "OdontogramRevision_odontogramId_version_key"
ON "OdontogramRevision"("odontogramId", "version");

ALTER TABLE "OdontogramRevision"
ADD CONSTRAINT "OdontogramRevision_odontogramId_fkey"
FOREIGN KEY ("odontogramId") REFERENCES "Odontogram"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
