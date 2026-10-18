const assert = require('node:assert/strict');

// This module receives only the runner's guarded, run-owned psql capability.
const legacySnapshot = `SELECT json_build_object(
  'patients', (SELECT json_agg(t ORDER BY "id") FROM "Patient" t),
  'prescriptions', (SELECT json_agg(t ORDER BY "id") FROM "Prescription" t),
  'items', (SELECT json_agg(t ORDER BY "id") FROM "PrescriptionItem" t),
  'medications', (SELECT json_agg(t ORDER BY "id") FROM "Medication" t),
  'batches', (SELECT json_agg(t ORDER BY "id") FROM "Batch" t))`;
const ledgerSnapshot = `SELECT json_build_object(
  'events', (SELECT json_agg(t ORDER BY "id") FROM "PrescriptionDispensing" t),
  'allocations', (SELECT json_agg(t ORDER BY "id") FROM "PrescriptionDispensingAllocation" t))`;

async function seedLegacy(psql) {
  await psql(`
    INSERT INTO "Patient" ("id","rut","firstName","lastName","dateOfBirth","createdAt","updatedAt")
    VALUES ('patient','synthetic-pharmacy','Synthetic','Fixture','1990-01-01','2026-01-02','2026-01-02');
    INSERT INTO "Medication" ("id","code","name","activePrinciple")
    VALUES ('medication','SYNTHETIC','Synthetic medication','Synthetic');
    INSERT INTO "Batch" ("id","medicationId","lotNumber","expirationDate","stock","createdAt")
    VALUES ('batch','medication','SYNTHETIC-LOT','2030-01-02',41,'2026-01-02');
    INSERT INTO "Prescription" ("id","patientId","date","status") VALUES
      ('issued','patient','2026-01-02','ISSUED'),
      ('dispensed','patient','2026-01-03','DISPENSED'),
      ('cancelled','patient','2026-01-04','CANCELLED'),
      ('parent-only','patient','2026-01-05','ISSUED');
    INSERT INTO "PrescriptionItem" ("id","prescriptionId","medicationId","quantity") VALUES
      ('item','issued','medication',10),
      ('legacy-dispensed','dispensed','medication',7),
      ('legacy-cancelled','cancelled','medication',3);
  `);
  return psql(legacySnapshot);
}

function event(id, prescription = 'issued') {
  return `INSERT INTO "PrescriptionDispensing" ("id","prescriptionId") VALUES ('${id}','${prescription}')`;
}

function allocation(
  id,
  dispensing = 'event-1',
  item = 'item',
  batch = 'batch',
  quantity = 2,
) {
  return `INSERT INTO "PrescriptionDispensingAllocation" ("id","dispensingId","prescriptionItemId","batchId","quantity")
    VALUES ('${id}','${dispensing}','${item}','${batch}',${quantity})`;
}

// The failing statement runs in a PL/pgSQL subtransaction. A missing or wrong
// violation fails the entire scenario, rather than accepting a generic error.
function expectedViolation(statement, state, constraint = '', message = '') {
  return `DO $proof$
    DECLARE actual_state text; actual_constraint text; actual_message text; rejected boolean := false;
    BEGIN
      BEGIN
        ${statement};
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE,
          actual_constraint = CONSTRAINT_NAME, actual_message = MESSAGE_TEXT;
        IF actual_state <> '${state}' OR actual_constraint <> '${constraint}'
          ${message ? `OR actual_message <> '${message}'` : ''} THEN
          RAISE EXCEPTION 'Wrong violation: state %, constraint %, message %', actual_state, actual_constraint, actual_message;
        END IF;
        rejected := true;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'Expected ${state} / ${constraint} was not raised'; END IF;
    END $proof$`;
}

async function verifyLedger(psql, legacy) {
  assert.equal(
    await psql(legacySnapshot),
    legacy,
    'migration preserves every legacy value',
  );
  assert.equal(
    await psql(`SELECT (SELECT count(*) FROM "PrescriptionDispensing") || ':' ||
    (SELECT count(*) FROM "PrescriptionDispensingAllocation")`),
    '0:0',
    'no invented ledger history',
  );
  await psql(`${event('event-1')}; ${event('event-2')}; ${event('event-parent', 'parent-only')};
    ${allocation('allocation-1')}; ${allocation('allocation-2', 'event-2', 'item', 'batch', 3)};`);
  assert.equal(
    await psql(`SELECT count(*) = 3 AND bool_and("dispensedAt" BETWEEN
    CURRENT_TIMESTAMP - interval '5 minutes' AND CURRENT_TIMESTAMP + interval '5 minutes')
    FROM "PrescriptionDispensing"`),
    't',
    'events receive default timestamps',
  );
  assert.equal(
    await psql(
      `SELECT count(*) || ':' || sum("quantity") FROM "PrescriptionDispensingAllocation"`,
    ),
    '2:5',
    'multiple events accept the same item and batch',
  );
  const ledger = await psql(ledgerSnapshot);
  let rejections = 0;
  const reject = async (
    statement,
    state,
    constraint,
    message,
    isolateTrigger = false,
  ) => {
    const proof = expectedViolation(statement, state, constraint, message);
    // The dispensing trigger masks its restrictive FK. Disable only that trigger
    // in a rolled-back fixture transaction to independently exercise the FK.
    await psql(
      isolateTrigger
        ? `BEGIN;
      ALTER TABLE "PrescriptionDispensing" DISABLE TRIGGER "PrescriptionDispensing_append_only";
      ${proof}; ROLLBACK;`
        : proof,
    );
    assert.equal(
      await psql(ledgerSnapshot),
      ledger,
      'rejection preserves the complete ledger',
    );
    assert.equal(
      await psql(legacySnapshot),
      legacy,
      'rejection preserves legacy records',
    );
    rejections++;
  };
  await reject(
    event('missing-prescription', 'missing'),
    '23503',
    'PrescriptionDispensing_prescriptionId_fkey',
  );
  for (const [name, dispensing, item, batch] of [
    ['dispensingId', 'missing', 'item', 'batch'],
    ['prescriptionItemId', 'event-1', 'missing', 'batch'],
    ['batchId', 'event-1', 'item', 'missing'],
  ]) {
    await reject(
      allocation(`missing-${name}`, dispensing, item, batch),
      '23503',
      `PrescriptionDispensingAllocation_${name}_fkey`,
    );
  }
  for (const quantity of [0, -1]) {
    await reject(
      allocation(
        `quantity-${quantity}`,
        'event-2',
        'legacy-dispensed',
        'batch',
        quantity,
      ),
      '23514',
      'PrescriptionDispensingAllocation_quantity_positive',
    );
  }
  await reject(
    allocation('duplicate-tuple'),
    '23505',
    'PrescriptionDispensingAllocation_dispensing_item_batch_key',
  );
  for (const [table, id] of [
    ['PrescriptionDispensing', 'event-1'],
    ['PrescriptionDispensingAllocation', 'allocation-1'],
  ]) {
    for (const operation of ['UPDATE', 'DELETE']) {
      const statement =
        operation === 'UPDATE'
          ? `UPDATE "${table}" SET "id" = 'changed' WHERE "id" = '${id}'`
          : `DELETE FROM "${table}" WHERE "id" = '${id}'`;
      await reject(
        statement,
        '55000',
        '',
        `${table} is append-only: ${operation} is not allowed`,
      );
    }
  }
  for (const [table, id, constraint] of [
    [
      'Prescription',
      'parent-only',
      'PrescriptionDispensing_prescriptionId_fkey',
    ],
    [
      'PrescriptionItem',
      'item',
      'PrescriptionDispensingAllocation_prescriptionItemId_fkey',
    ],
    ['Batch', 'batch', 'PrescriptionDispensingAllocation_batchId_fkey'],
    [
      'PrescriptionDispensing',
      'event-1',
      'PrescriptionDispensingAllocation_dispensingId_fkey',
    ],
  ]) {
    for (const operation of ['UPDATE', 'DELETE']) {
      const statement =
        operation === 'UPDATE'
          ? `UPDATE "${table}" SET "id" = 'changed' WHERE "id" = '${id}'`
          : `DELETE FROM "${table}" WHERE "id" = '${id}'`;
      await reject(
        statement,
        '23503',
        constraint,
        '',
        table === 'PrescriptionDispensing',
      );
    }
  }
  // Verify the temporary FK isolation restored the append-only guard too.
  await reject(
    `DELETE FROM "PrescriptionDispensing" WHERE "id" = 'event-1'`,
    '55000',
    '',
    'PrescriptionDispensing is append-only: DELETE is not allowed',
  );
  console.log(
    `PHARMACY_LEDGER_TESTS legacy=unchanged backfill=none events=3 allocations=2 rejections=${rejections}`,
  );
}

module.exports = { seedLegacy, verifyLedger };
