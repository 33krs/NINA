-- Add an optional source appointment to preserve existing unlinked encounters.
ALTER TABLE "Encounter" ADD COLUMN "appointmentId" TEXT;

CREATE INDEX "Encounter_appointmentId_idx" ON "Encounter"("appointmentId");

ALTER TABLE "Encounter"
ADD CONSTRAINT "Encounter_appointmentId_fkey"
FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
