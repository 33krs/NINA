const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

function assertPrescriptionCollision(error) {
  // Resolve lazily: the guarded child binds the actual isolated module before this call.
  const { Prisma } = require('@prisma/client');
  assert.ok(error instanceof Prisma.PrismaClientKnownRequestError);
  assert.equal(error.code, 'P2002');
  assert.equal(error.meta?.modelName, 'PrescriptionDispensing');
  assert.deepEqual(error.meta?.target, ['id']);
}

function observedWaiters(rows, identities, table) {
  if (!['Prescription', 'Batch'].includes(table)) return false;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (byPid.size !== rows.length || rows.length !== 3) return false;
  if (new Set(identities.map(({ pid }) => pid)).size !== 3) return false;
  if (
    identities.some(({ pid, started }) => byPid.get(pid)?.started !== started)
  )
    return false;
  const [blocker, ...writers] = identities;
  function reachesBlocker(pid, visited) {
    if (pid === blocker.pid) return true;
    if (visited.has(pid) || !writers.some((writer) => writer.pid === pid))
      return false;
    const blockers = byPid.get(pid)?.blockers;
    return (
      Array.isArray(blockers) &&
      blockers.length > 0 &&
      blockers.every((parent) =>
        reachesBlocker(parent, new Set([...visited, pid])),
      )
    );
  }
  return writers.every(({ pid }) => {
    const row = byPid.get(pid);
    return (
      row.state === 'active' &&
      row.wait === 'Lock' &&
      typeof row.query === 'string' &&
      row.query.includes(`FROM "${table}"`) &&
      /\bFOR UPDATE\b/.test(row.query) &&
      reachesBlocker(pid, new Set())
    );
  });
}

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function outcome(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

async function deadline(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Contention gate timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function identity(client) {
  const rows = await client.$queryRaw`SELECT pid, backend_start::text AS started
    FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
  assert.equal(rows.length, 1);
  return rows[0];
}

async function race(
  { blocker, monitor, writers, services },
  table,
  id,
  requests,
) {
  const ready = gate();
  const release = gate();
  const tasks = [];
  let held;
  let observation;
  try {
    const captured = await Promise.allSettled(writers.map(identity));
    assert.ok(captured.every((result) => result.status === 'fulfilled'));
    const writerIdentities = captured.map((result) => result.value);
    held = outcome(
      blocker.$transaction(async (tx) => {
        const locked =
          table === 'Prescription'
            ? await tx.$queryRaw`SELECT "id" FROM "Prescription" WHERE "id" = ${id} FOR UPDATE`
            : await tx.$queryRaw`SELECT "id" FROM "Batch" WHERE "id" = ${id} FOR UPDATE`;
        assert.equal(locked.length, 1);
        ready.resolve(await identity(tx));
        await release.promise;
      }),
    );
    const blockerIdentity = await deadline(
      Promise.race([
        ready.promise,
        held.then((result) => {
          if (result.status === 'rejected') throw result.reason;
          throw new Error('Blocker released before observation');
        }),
      ]),
      3000,
    );
    const identities = [blockerIdentity, ...writerIdentities];
    for (const [index, service] of services.entries()) {
      tasks.push(
        outcome(
          Promise.resolve().then(() => service.dispenseItem(requests[index])),
        ),
      );
    }
    const expires = performance.now() + 3000;
    while (performance.now() < expires) {
      const rows =
        await monitor.$queryRaw`SELECT pid, backend_start::text AS started,
        state, wait_event_type AS wait, query, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE datname = current_database()
          AND pid IN (${blockerIdentity.pid}, ${writerIdentities[0].pid}, ${writerIdentities[1].pid})`;
      if (
        performance.now() < expires &&
        observedWaiters(rows, identities, table)
      ) {
        observation = rows;
        break;
      }
      await pause(25); // Observation cadence only; successful evidence releases the gate.
    }
    assert.ok(
      observation,
      'Both identified writers must wait on the held lock',
    );
  } finally {
    release.resolve(); // Also release on observation/setup failure; never abandon transactions.
    const settled = await Promise.all([...tasks, ...(held ? [held] : [])]);
    if (held)
      assert.equal(
        settled.at(-1).status,
        'fulfilled',
        'Blocker transaction failed',
      );
  }
  const results = await Promise.all(tasks);
  return results;
}

async function fixture(db, name, stock, quantities) {
  await db.medication.create({
    data: {
      id: name,
      code: name,
      name: 'Synthetic',
      activePrinciple: 'Synthetic',
      batches: {
        create: {
          id: name,
          lotNumber: 'Synthetic',
          stock,
          expirationDate: new Date('9999-12-31T00:00:00Z'),
        },
      },
    },
  });
  const requests = [];
  for (const [index, quantity] of quantities.entries()) {
    const id = `${name}-${index}`;
    await db.prescription.create({
      data: {
        id,
        patientId: 'patient',
        status: 'ISSUED',
        items: { create: { id, medicationId: name, quantity } },
      },
    });
    requests.push({
      prescriptionId: id,
      itemId: id,
      quantity: 4,
      eventId: crypto.randomUUID(),
    });
  }
  return requests;
}

async function verifyRace(
  db,
  context,
  name,
  table,
  stock,
  quantities,
  rejection,
  winnerStatus,
) {
  const requests = await fixture(db, name, stock, quantities);
  if (table === 'Prescription') {
    requests.push({ ...requests[0], eventId: crypto.randomUUID() });
  }
  const before = await db.prescription.findMany({
    where: { id: { in: requests.map((request) => request.prescriptionId) } },
    include: { items: true },
    orderBy: { id: 'asc' },
  });
  const results = await race(
    context,
    table,
    table === 'Prescription' ? requests[0].prescriptionId : name,
    requests,
  );
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  );
  const winner = results.findIndex((result) => result.status === 'fulfilled');
  const loser = 1 - winner;
  assert.match(results[loser].reason.message, rejection);
  assert.deepEqual(results[winner].value, {
    eventId: requests[winner].eventId,
    allocations: [{ batchId: name, quantity: 4 }],
  });
  const saved = await db.prescriptionDispensing.findMany({
    where: {
      prescriptionId: { in: requests.map((request) => request.prescriptionId) },
    },
    include: { allocations: true },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, requests[winner].eventId);
  assert.equal(saved[0].prescriptionId, requests[winner].prescriptionId);
  assert.equal(saved[0].allocations.length, 1);
  const allocation = saved[0].allocations[0];
  assert.equal(allocation.dispensingId, saved[0].id);
  assert.equal(allocation.prescriptionItemId, requests[winner].itemId);
  assert.equal(allocation.batchId, name);
  assert.equal(allocation.quantity, 4);
  assert.equal(
    await db.prescriptionDispensing.findUnique({
      where: { id: requests[loser].eventId },
    }),
    null,
  );
  assert.equal(
    (await db.batch.findUniqueOrThrow({ where: { id: name } })).stock,
    stock - 4,
  );
  for (const prescription of before) {
    const after = await db.prescription.findUniqueOrThrow({
      where: { id: prescription.id },
      include: { items: true },
    });
    assert.deepEqual(after, {
      ...prescription,
      status:
        prescription.id === requests[winner].prescriptionId
          ? winnerStatus
          : 'ISSUED',
    });
  }
  const history = await db.prescriptionDispensingAllocation.findMany({
    where: {
      prescriptionItemId: { in: requests.map((request) => request.itemId) },
    },
  });
  assert.deepEqual(history, saved[0].allocations);
}

async function verifyContention(db, context) {
  // The guarded caller owns real clients; this import-only module discovers no datasource.
  await context.monitor.$executeRaw`SET statement_timeout = '1000ms'`;
  await verifyRace(
    db,
    context,
    'contention-prescription',
    'Prescription',
    10,
    [5],
    /^Requested quantity exceeds pending quantity$/,
    'ISSUED',
  );
  await verifyRace(
    db,
    context,
    'contention-stock',
    'Batch',
    5,
    [4, 4],
    /^Insufficient stock$/,
    'DISPENSED',
  );
  await verifyIdempotency(db, context);
}

async function idempotencyState(db, requests, batchId) {
  const prescriptionIds = [
    ...new Set(requests.map(({ prescriptionId }) => prescriptionId)),
  ];
  return {
    batch: await db.batch.findUniqueOrThrow({ where: { id: batchId } }),
    prescriptions: await db.prescription.findMany({
      where: { id: { in: prescriptionIds } },
      include: { items: true },
      orderBy: { id: 'asc' },
    }),
    events: await db.prescriptionDispensing.findMany({
      where: { prescriptionId: { in: prescriptionIds } },
      include: { allocations: true },
      orderBy: { id: 'asc' },
    }),
    allocations: await db.prescriptionDispensingAllocation.findMany({
      where: {
        prescriptionItemId: { in: requests.map(({ itemId }) => itemId) },
      },
      orderBy: { id: 'asc' },
    }),
  };
}

async function assertCommittedPortion(db, requests, name, before, winner) {
  const after = await idempotencyState(db, requests, name);
  assert.deepEqual(after.batch, {
    ...before.batch,
    stock: before.batch.stock - 4,
  });
  assert.deepEqual(
    after.prescriptions,
    before.prescriptions.map((prescription) => ({
      ...prescription,
      status:
        prescription.id === requests[winner].prescriptionId
          ? 'DISPENSED'
          : prescription.status,
    })),
  );
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].id, requests[winner].eventId);
  assert.equal(after.events[0].prescriptionId, requests[winner].prescriptionId);
  assert.equal(after.allocations.length, 1);
  assert.deepEqual(after.events[0].allocations, after.allocations);
  assert.equal(after.allocations[0].dispensingId, requests[winner].eventId);
  assert.equal(
    after.allocations[0].prescriptionItemId,
    requests[winner].itemId,
  );
  assert.equal(after.allocations[0].batchId, name);
  assert.equal(after.allocations[0].quantity, 4);
}

async function verifyIdempotency(db, context) {
  const replay = await fixture(db, 'contention-replay', 8, [4]);
  replay.push({ ...replay[0] });
  const beforeReplay = await idempotencyState(db, replay, 'contention-replay');
  assert.deepEqual(beforeReplay.events, []);
  assert.deepEqual(beforeReplay.allocations, []);
  const replayResults = await race(
    context,
    'Prescription',
    replay[0].prescriptionId,
    replay,
  );
  for (const result of replayResults) {
    assert.equal(result.status, 'fulfilled');
    assert.deepEqual(result.value, {
      eventId: replay[0].eventId,
      allocations: [{ batchId: 'contention-replay', quantity: 4 }],
    });
  }
  assert.deepEqual(replayResults[0].value, replayResults[1].value);
  await assertCommittedPortion(
    db,
    replay,
    'contention-replay',
    beforeReplay,
    0,
  );

  const collision = await fixture(db, 'contention-collision', 12, [4, 4]);
  collision[1].eventId = collision[0].eventId;
  assert.equal(
    await db.prescriptionDispensing.findUnique({
      where: { id: collision[0].eventId },
    }),
    null,
  );
  const beforeCollision = await idempotencyState(
    db,
    collision,
    'contention-collision',
  );
  assert.deepEqual(beforeCollision.events, []);
  assert.deepEqual(beforeCollision.allocations, []);
  // Both observed Batch waits occur after absent replay lookups, before either event insert.
  const results = await race(
    context,
    'Batch',
    'contention-collision',
    collision,
  );
  assert.equal(
    results.filter(({ status }) => status === 'fulfilled').length,
    1,
  );
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  const winner = results.findIndex(({ status }) => status === 'fulfilled');
  const error = results[1 - winner].reason;
  assertPrescriptionCollision(error);
  assert.deepEqual(results[winner].value, {
    eventId: collision[winner].eventId,
    allocations: [{ batchId: 'contention-collision', quantity: 4 }],
  });
  await assertCommittedPortion(
    db,
    collision,
    'contention-collision',
    beforeCollision,
    winner,
  );
}

module.exports = {
  observedWaiters,
  verifyContention,
  assertPrescriptionCollision,
};
