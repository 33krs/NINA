const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { verifyContention } = require('./verify-pharmacy-contention.cjs');
const {
  dockerArgs,
  ownedContainerId,
  run,
  validateIsolatedClient,
} = require('./verify-odontogram-postgres.cjs');

function assertUnchanged(before, after) {
  assert.deepEqual(
    after,
    before,
    'Stock, history and prescription state must not change',
  );
}

async function databaseSnapshot(db) {
  // Full business rows, ordered by stable IDs; no volatile query-time fields.
  const rows = await db.$queryRaw`SELECT jsonb_build_object(
    'patients', (SELECT jsonb_agg(t ORDER BY "id") FROM "Patient" t),
    'medications', (SELECT jsonb_agg(t ORDER BY "id") FROM "Medication" t),
    'batches', (SELECT jsonb_agg(t ORDER BY "id") FROM "Batch" t),
    'prescriptions', (SELECT jsonb_agg(t ORDER BY "id") FROM "Prescription" t),
    'items', (SELECT jsonb_agg(t ORDER BY "id") FROM "PrescriptionItem" t),
    'events', (SELECT jsonb_agg(t ORDER BY "id") FROM "PrescriptionDispensing" t),
    'allocations', (SELECT jsonb_agg(t ORDER BY "id") FROM "PrescriptionDispensingAllocation" t)
  ) AS snapshot`;
  return rows[0].snapshot;
}

async function verifyReplayAndRollback(db, service, completed) {
  const replaySnapshot = await databaseSnapshot(db);
  assert.deepEqual(
    await service.dispenseItem(completed.request),
    completed.result,
  );
  assertUnchanged(replaySnapshot, await databaseSnapshot(db));
  for (const [change, message] of [
    [{ quantity: 1 }, /Overdelivery exceeds the prescribed quantity/],
    [{ quantity: 3 }, /Event ID does not match requested delivery/],
    [{ itemId: 'first' }, /Event ID does not match requested delivery/],
    [
      { prescriptionId: 'expired', itemId: 'expired' },
      /Event ID belongs to another prescription/,
    ],
  ]) {
    await assert.rejects(
      service.dispenseItem({ ...completed.request, ...change }),
      message,
    );
    assertUnchanged(replaySnapshot, await databaseSnapshot(db));
  }

  await db.medication.create({
    data: {
      id: 'rollback',
      code: 'rollback',
      name: 'Synthetic',
      activePrinciple: 'Synthetic',
      batches: {
        create: {
          id: 'rollback',
          lotNumber: 'Synthetic',
          expirationDate: new Date('9999-12-31T00:00:00Z'),
          stock: 4,
        },
      },
    },
  });
  await db.prescription.create({
    data: {
      id: 'rollback',
      patientId: 'patient',
      status: 'ISSUED',
      items: {
        create: { id: 'rollback-item', medicationId: 'rollback', quantity: 2 },
      },
    },
  });
  const request = {
    prescriptionId: 'rollback',
    itemId: 'rollback-item',
    quantity: 2,
    eventId: crypto.randomUUID(),
  };
  const beforeFailure = await databaseSnapshot(db);
  try {
    // DDL injects a failure only; the actual service owns every dispensing write.
    await db.$executeRawUnsafe(`CREATE FUNCTION pharmacy_proof_allocation_failure()
      RETURNS trigger LANGUAGE plpgsql AS $proof$
      BEGIN
        IF NEW."prescriptionItemId" = 'rollback-item' THEN
          IF NEW."batchId" <> 'rollback' OR NEW."quantity" <> 2 OR
            (SELECT "stock" FROM "Batch" WHERE "id" = 'rollback') IS DISTINCT FROM 2 THEN
            RAISE EXCEPTION 'PHARMACY_PROOF_WRONG_STOCK_STATE';
          END IF;
          RAISE EXCEPTION USING ERRCODE = 'P0001',
            MESSAGE = 'PHARMACY_PROOF_ROLLBACK_STOCK_VISIBLE';
        END IF;
        RETURN NEW;
      END $proof$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER pharmacy_proof_allocation_failure
      BEFORE INSERT ON "PrescriptionDispensingAllocation"
      FOR EACH ROW EXECUTE FUNCTION pharmacy_proof_allocation_failure()`);
    await assert.rejects(service.dispenseItem(request), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\bPHARMACY_PROOF_ROLLBACK_STOCK_VISIBLE\b/);
      assert.doesNotMatch(error.message, /PHARMACY_PROOF_WRONG_STOCK_STATE/);
      return true;
    });
    assertUnchanged(beforeFailure, await databaseSnapshot(db));
    assert.equal(
      await db.prescriptionDispensing.findUnique({
        where: { id: request.eventId },
      }),
      null,
    );
  } finally {
    try {
      await db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS pharmacy_proof_allocation_failure ON "PrescriptionDispensingAllocation"',
      );
    } finally {
      await db.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS pharmacy_proof_allocation_failure()',
      );
    }
  }
  const objects = await db.$queryRaw`SELECT
    NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_proof_allocation_failure')
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'pharmacy_proof_allocation_failure') AS removed`;
  assert.equal(objects[0].removed, true);
  const result = await service.dispenseItem(request);
  assert.deepEqual(result, {
    eventId: request.eventId,
    allocations: [{ batchId: 'rollback', quantity: 2 }],
  });
  assert.equal(
    (await db.batch.findUniqueOrThrow({ where: { id: 'rollback' } })).stock,
    2,
  );
  assert.equal(
    (await db.prescription.findUniqueOrThrow({ where: { id: 'rollback' } }))
      .status,
    'DISPENSED',
  );
  const saved = await db.prescriptionDispensing.findUniqueOrThrow({
    where: { id: request.eventId },
    include: { allocations: true },
  });
  assert.equal(saved.prescriptionId, request.prescriptionId);
  assert.equal(saved.allocations.length, 1);
  assert.equal(saved.allocations[0].prescriptionItemId, request.itemId);
  assert.equal(saved.allocations[0].batchId, 'rollback');
  assert.equal(saved.allocations[0].quantity, 2);
  assert.equal(await db.prescriptionDispensing.count(), 4);
  assert.equal(await db.prescriptionDispensingAllocation.count(), 4);
}

async function ownedConfig(env, inspect) {
  assert.ok(
    env.NINA_PHARMACY_DISPENSING_PG15 === '1',
    'Runner opt-in required',
  );
  assert.ok(env.NINA_ODONTOGRAM_PG15_TESTS === '1', 'Runner opt-in required');
  const proofFile = env.NINA_ODONTOGRAM_PG15_PROOF_FILE;
  assert.ok(
    typeof proofFile === 'string' && path.isAbsolute(proofFile),
    'Private proof required',
  );
  const root = path.dirname(proofFile);
  assert.ok(path.basename(root).startsWith('nina-odontogram-pg15-'));
  assert.equal(proofFile, path.join(root, 'container-proof.json'));
  for (const [file, mode, directory] of [
    [root, 0o700, true],
    [proofFile, 0o600, false],
  ]) {
    const stats = fs.lstatSync(file);
    assert.ok(!stats.isSymbolicLink() && stats.isDirectory() === directory);
    assert.equal(stats.mode & 0o777, mode);
    assert.equal(fs.realpathSync(file), file);
    if (process.getuid) assert.equal(stats.uid, process.getuid());
  }
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  const clientPath = env.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT;
  assert.equal(proof.suite, 'pharmacy-dispensing');
  assert.equal(proof.runId, env.NINA_ODONTOGRAM_PG15_RUN_ID);
  assert.match(
    proof.runId,
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
  );
  assert.equal(proof.owner, 'nina-suite');
  assert.equal(proof.image, 'postgres:15-alpine');
  assert.equal(proof.auth, 'isolated-scram');
  assert.equal(proof.networkIsolated, true);
  assert.equal(proof.networkMembers, 1);
  assert.equal(proof.publishedHost, '127.0.0.1');
  assert.ok(
    Number.isInteger(proof.publishedPort) &&
      proof.publishedPort > 0 &&
      proof.publishedPort <= 65535,
  );
  assert.match(proof.containerId, /^[\da-f]{64}$/);
  assert.match(proof.networkId, /^[\da-f]{64}$/);
  assert.match(proof.imageId, /^sha256:[\da-f]{64}$/);
  assert.equal(
    proof.networkName,
    `nina-odontogram-pg15-${proof.runId.slice(0, 12)}`,
  );
  assert.equal(
    proof.database,
    `nina_${proof.runId.replaceAll('-', '').slice(0, 16)}`,
  );
  assert.equal(
    proof.user,
    `nina_${proof.runId.replaceAll('-', '').slice(16, 28)}`,
  );
  assert.equal(clientPath, path.join(root, 'isolated-client', 'index.js'));
  validateIsolatedClient({
    clientPath,
    tempRoot: root,
    schemaEnvPath: path.join(root, 'prisma', '.env'),
  });
  assert.equal(fs.realpathSync(clientPath), clientPath);
  assert.ok(
    !fs.existsSync(path.join(root, '.env')) &&
      !fs.existsSync(path.join(root, 'prisma', '.env')),
  );
  const databaseUrl = env.DATABASE_URL;
  const url = new URL(databaseUrl);
  const password = url.password;
  assert.ok(/^[\da-f]{64}$/.test(password), 'Fresh credential required');
  assert.ok(
    databaseUrl ===
      `postgresql://${proof.user}:${password}@127.0.0.1:${proof.publishedPort}/${proof.database}?schema=public`,
    'Datasource binding mismatch',
  );
  const config = { root, proof, clientPath, databaseUrl, password };
  const container = (await inspect(['inspect', proof.containerId], config))[0];
  ownedContainerId(container, proof.containerId, proof.runId);
  assert.equal(container.Name, '/' + proof.networkName);
  assert.equal(container.Image, proof.imageId);
  assert.equal(container.State.Status, 'running');
  for (const entry of [
    `POSTGRES_USER=${proof.user}`,
    `POSTGRES_DB=${proof.database}`,
    `POSTGRES_PASSWORD=${password}`,
    'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
  ]) {
    assert.ok(
      container.Config.Env.includes(entry),
      'Owned authentication mismatch',
    );
  }
  assert.equal(container.HostConfig.NetworkMode, proof.networkName);
  assert.ok(container.HostConfig.Tmpfs['/var/lib/postgresql/data']);
  assert.ok(
    container.Mounts.length <= 1 &&
      container.Mounts.every(
        (mount) =>
          mount.Type === 'tmpfs' &&
          mount.Destination === '/var/lib/postgresql/data',
      ),
  );
  assert.deepEqual(container.NetworkSettings.Ports['5432/tcp'], [
    { HostIp: '127.0.0.1', HostPort: String(proof.publishedPort) },
  ]);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [
    proof.networkName,
  ]);
  assert.equal(
    container.NetworkSettings.Networks[proof.networkName].NetworkID,
    proof.networkId,
  );
  const network = (
    await inspect(['network', 'inspect', proof.networkId], config)
  )[0];
  assert.equal(network.Id, proof.networkId);
  assert.equal(network.Name, proof.networkName);
  assert.equal(network.Internal, false);
  assert.equal(
    network.Labels['nina.odontogram-postgres15.owner'],
    'nina-suite',
  );
  assert.equal(network.Labels['nina.odontogram-postgres15.run'], proof.runId);
  assert.deepEqual(Object.keys(network.Containers), [proof.containerId]);
  return config;
}

async function inspectOwned(args, config) {
  return JSON.parse(
    await run('docker', dockerArgs(args), {
      env: { PATH: process.env.PATH, HOME: config.root },
      redactions: [config.databaseUrl, config.password],
    }),
  );
}

function bindRuntime({ clientPath }) {
  const apiRoot = path.resolve(__dirname, '..');
  const servicePath = path.join(
    apiRoot,
    'dist/modules/pharmacy/pharmacy-dispensing.service.js',
  );
  const prismaPath = path.join(apiRoot, 'dist/prisma/prisma.service.js');
  const entries = [servicePath, prismaPath].map((file) =>
    require.resolve('@prisma/client', { paths: [path.dirname(file)] }),
  );
  assert.equal(
    entries[0],
    entries[1],
    'Direct and transitive client imports must match',
  );
  assert.ok(
    !require.cache[entries[0]],
    'Installed generated client must not be loaded',
  );
  const isolated = require(clientPath);
  // Bind this one dependency to the real generated module; never fake transactions.
  const binding = new Module(entries[0]);
  binding.filename = entries[0];
  binding.loaded = true;
  binding.exports = isolated;
  require.cache[entries[0]] = binding;
  const { PharmacyDispensingService } = require(servicePath);
  const { PrismaService } = require(prismaPath);
  assert.equal(Object.getPrototypeOf(PrismaService), isolated.PrismaClient);
  return { PrismaClient: isolated.PrismaClient, PharmacyDispensingService };
}

async function main(
  env = process.env,
  inspect = inspectOwned,
  bind = bindRuntime,
) {
  const config = await ownedConfig(env, inspect);
  const { PrismaClient, PharmacyDispensingService } = bind(config);
  const clients = [];
  try {
    for (let index = 0; index < 2; index++) {
      clients.push(new PrismaClient({ datasourceUrl: config.databaseUrl }));
    }
    const [db, writer] = clients;
    const identity =
      await db.$queryRaw`SELECT current_database() AS database, current_user AS username, current_setting('server_version') AS version`;
    assert.equal(identity[0].database, config.proof.database);
    assert.equal(identity[0].username, config.proof.user);
    assert.match(identity[0].version, /^15\./);
    await db.patient.create({
      data: {
        id: 'patient',
        rut: 'synthetic-pharmacy-service',
        firstName: 'Synthetic',
        lastName: 'Fixture',
        dateOfBirth: new Date('1990-01-01T00:00:00Z'),
      },
    });
    for (const [id, stock, expiration] of [
      ['available', 8, '9999-12-31'],
      ['expired', 7, '2000-01-01'],
    ]) {
      await db.medication.create({
        data: {
          id,
          code: id,
          name: 'Synthetic',
          activePrinciple: 'Synthetic',
          batches: {
            create: {
              id,
              lotNumber: 'Synthetic',
              expirationDate: new Date(`${expiration}T00:00:00Z`),
              stock,
            },
          },
        },
      });
    }
    await db.prescription.create({
      data: {
        id: 'partial',
        patientId: 'patient',
        status: 'ISSUED',
        items: {
          create: [
            { id: 'first', medicationId: 'available', quantity: 3 },
            { id: 'second', medicationId: 'available', quantity: 2 },
          ],
        },
      },
    });
    await db.prescription.create({
      data: {
        id: 'expired',
        patientId: 'patient',
        status: 'ISSUED',
        items: {
          create: { id: 'expired', medicationId: 'expired', quantity: 1 },
        },
      },
    });
    const service = new PharmacyDispensingService(writer);
    let completed;
    for (const [itemId, quantity, stock, status, count, delivered] of [
      ['first', 2, 6, 'ISSUED', 1, 2],
      ['first', 1, 5, 'ISSUED', 2, 3],
      ['second', 2, 3, 'DISPENSED', 3, 5],
    ]) {
      const request = {
        prescriptionId: 'partial',
        itemId,
        quantity,
        eventId: crypto.randomUUID(),
      };
      const result = await service.dispenseItem(request);
      completed = { request, result };
      assert.deepEqual(result.allocations, [
        { batchId: 'available', quantity },
      ]);
      assert.equal(
        (await db.batch.findUniqueOrThrow({ where: { id: 'available' } }))
          .stock,
        stock,
      );
      const saved = await db.prescription.findUniqueOrThrow({
        where: { id: 'partial' },
        include: { dispensings: { include: { allocations: true } } },
      });
      assert.equal(saved.status, status);
      assert.equal(saved.dispensings.length, count);
      assert.equal(
        saved.dispensings
          .flatMap((event) => event.allocations)
          .reduce((sum, allocation) => sum + allocation.quantity, 0),
        delivered,
      );
      const event = saved.dispensings.find(
        (event) => event.id === result.eventId,
      );
      assert.ok(event);
      assert.equal(event.allocations.length, 1);
      assert.equal(event.allocations[0].prescriptionItemId, itemId);
      assert.equal(event.allocations[0].batchId, 'available');
      assert.equal(event.allocations[0].quantity, quantity);
    }
    await assert.rejects(
      service.dispenseItem({
        prescriptionId: 'expired',
        itemId: 'expired',
        quantity: 1,
        eventId: crypto.randomUUID(),
      }),
      /Insufficient stock/,
    );
    assert.equal(
      (await db.batch.findUniqueOrThrow({ where: { id: 'expired' } })).stock,
      7,
    );
    assert.equal(
      (await db.prescription.findUniqueOrThrow({ where: { id: 'expired' } }))
        .status,
      'ISSUED',
    );
    assert.equal(await db.prescriptionDispensing.count(), 3);
    assert.equal(await db.prescriptionDispensingAllocation.count(), 3);
    await verifyReplayAndRollback(db, service, completed);
    // Derive pooling options only after the canonical private datasource passes its guard.
    const singleConnection = new URL(config.databaseUrl);
    singleConnection.searchParams.set('connection_limit', '1');
    const contenders = [];
    for (let index = 0; index < 4; index++) {
      const client = new PrismaClient({
        datasourceUrl: singleConnection.toString(),
        transactionOptions: { timeout: 15000 },
      });
      clients.push(client);
      contenders.push(client);
    }
    const [blocker, monitor, ...writers] = contenders;
    await verifyContention(db, {
      blocker,
      monitor,
      writers,
      services: writers.map((client) => new PharmacyDispensingService(client)),
    });
  } finally {
    const disconnected = await Promise.allSettled(
      clients.map((client) => client.$disconnect()),
    );
    assert.ok(
      disconnected.every((result) => result.status === 'fulfilled'),
      'Client cleanup failed',
    );
  }
  console.log(
    // Keep the shared runner's baseline summary stable; extra proofs must pass first.
    'PHARMACY_SERVICE_BASELINE_PASSED deliveries=3 expiry_rejections=1',
  );
}

if (require.main === module)
  main().catch(() => {
    console.error('PHARMACY_SERVICE_FAILED');
    process.exitCode = 1;
  });
module.exports = { main, ownedConfig, bindRuntime, assertUnchanged };
