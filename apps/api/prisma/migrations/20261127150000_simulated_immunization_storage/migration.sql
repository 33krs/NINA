-- Existing patients are not classified as simulated without an explicit decision.
ALTER TABLE "Patient" ADD COLUMN "isSimulated" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Patient_id_isSimulated_key" ON "Patient"("id", "isSimulated");

-- A composite foreign key prevents linking simulations to unclassified patients.
CREATE TABLE "SimulatedImmunization" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "patientSimulated" BOOLEAN NOT NULL DEFAULT true,
    "vaccineCode" TEXT NOT NULL,
    "dateAdministered" TEXT NOT NULL,
    CONSTRAINT "SimulatedImmunization_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SimulatedImmunization_patientSimulated_check" CHECK ("patientSimulated" = true)
);
CREATE INDEX "SimulatedImmunization_patientId_idx" ON "SimulatedImmunization"("patientId");
ALTER TABLE "SimulatedImmunization" ADD CONSTRAINT "SimulatedImmunization_patientId_patientSimulated_fkey"
    FOREIGN KEY ("patientId", "patientSimulated") REFERENCES "Patient"("id", "isSimulated")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
