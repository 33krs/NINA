-- Add dispensing provenance without changing legacy data, statuses or stock.
CREATE TABLE "PrescriptionDispensing" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "dispensedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrescriptionDispensing_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrescriptionDispensingAllocation" (
    "id" TEXT NOT NULL,
    "dispensingId" TEXT NOT NULL,
    "prescriptionItemId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "PrescriptionDispensingAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PrescriptionDispensingAllocation_quantity_positive" CHECK ("quantity" > 0)
);

CREATE INDEX "PrescriptionDispensing_prescriptionId_dispensedAt_idx"
ON "PrescriptionDispensing"("prescriptionId", "dispensedAt");

CREATE UNIQUE INDEX "PrescriptionDispensingAllocation_dispensing_item_batch_key"
ON "PrescriptionDispensingAllocation"("dispensingId", "prescriptionItemId", "batchId");

CREATE INDEX "PrescriptionDispensingAllocation_prescriptionItemId_idx"
ON "PrescriptionDispensingAllocation"("prescriptionItemId");

CREATE INDEX "PrescriptionDispensingAllocation_batchId_idx"
ON "PrescriptionDispensingAllocation"("batchId");

ALTER TABLE "PrescriptionDispensing"
ADD CONSTRAINT "PrescriptionDispensing_prescriptionId_fkey"
FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "PrescriptionDispensingAllocation"
ADD CONSTRAINT "PrescriptionDispensingAllocation_dispensingId_fkey"
FOREIGN KEY ("dispensingId") REFERENCES "PrescriptionDispensing"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "PrescriptionDispensingAllocation"
ADD CONSTRAINT "PrescriptionDispensingAllocation_prescriptionItemId_fkey"
FOREIGN KEY ("prescriptionItemId") REFERENCES "PrescriptionItem"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "PrescriptionDispensingAllocation"
ADD CONSTRAINT "PrescriptionDispensingAllocation_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "Batch"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Reject ordinary row mutations; this is not a privileged-user/TRUNCATE barrier.
CREATE FUNCTION "reject_prescription_dispensing_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "PrescriptionDispensing_append_only"
BEFORE UPDATE OR DELETE ON "PrescriptionDispensing"
FOR EACH ROW EXECUTE FUNCTION "reject_prescription_dispensing_mutation"();

CREATE TRIGGER "PrescriptionDispensingAllocation_append_only"
BEFORE UPDATE OR DELETE ON "PrescriptionDispensingAllocation"
FOR EACH ROW EXECUTE FUNCTION "reject_prescription_dispensing_mutation"();
