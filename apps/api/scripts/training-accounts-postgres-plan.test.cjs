const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, it } = require('node:test');
const recovery = require('./verify-training-accounts-postgres.cjs');
const {
  trainingAccountPostgresCommand,
} = require('./training-accounts-postgres-plan.cjs');

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);
const NETWORK_ID = 'c'.repeat(64);
const roots = new Set();

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function context() {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'postgres-plan-test-'),
  );
  roots.add(temporaryDirectory);
  return recovery.createRecoveryContext({ temporaryDirectory });
}

async function readyContext({ prepared = true } = {}) {
  const authority = context();
  const password = crypto.randomBytes(32).toString('base64url');
  const suffix = authority.runId.replaceAll('-', '').slice(0, 16);
  if (prepared) {
    recovery.writePrivateArtifact(authority, 'proof_sql', 'SELECT 1;');
    recovery.writePrivateArtifact(
      authority,
      'postgres_env',
      `POSTGRES_DB=training_${suffix}\nPOSTGRES_USER=training_${suffix}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\nPGPASSWORD=${password}\n`,
    );
  }
  return {
    authority,
    fixture: Object.freeze({
      database: `training_${suffix}`,
      databaseUser: `training_${suffix}`,
      username: `nina_${authority.runId.replaceAll('-', '').slice(0, 12)}`,
      artifacts: Object.freeze({
        proofSql: path.join(authority.root, 'proof.sql'),
        postgresEnv: path.join(authority.root, 'postgres.env'),
      }),
      assertions: Object.freeze([]),
      expectedRejections: Object.freeze([]),
    }),
  };
}

it('plans fixed image inspection and immutable identity-bound creation commands', async () => {
  const { authority, fixture } = await readyContext();
  const inspect = trainingAccountPostgresCommand(
    authority,
    fixture,
    'inspect_image',
  );
  assert.throws(() =>
    trainingAccountPostgresCommand(authority, fixture, 'create_network'),
  );
  recovery.bindImageIdentity(authority, IMAGE_ID);
  const networkArgs = trainingAccountPostgresCommand(
    authority,
    fixture,
    'create_network',
  );
  await recovery.captureCreation(authority, 'network', async () => NETWORK_ID);
  const containerArgs = trainingAccountPostgresCommand(
    authority,
    fixture,
    'create_container',
  );

  assert.deepEqual(inspect, [
    '--host',
    'unix:///var/run/docker.sock',
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    'postgres:15-alpine',
  ]);
  assert.ok(networkArgs.includes('--label'));
  assert.ok(networkArgs.includes('--internal'));
  assert.ok(containerArgs.includes('--read-only'));
  assert.ok(containerArgs.includes('--pull=never'));
  assert.ok(containerArgs.includes('--user'));
  assert.ok(containerArgs.includes('0'));
  assert.ok(
    containerArgs.includes(
      `type=bind,source=${fixture.artifacts.proofSql},target=/run/nina-proof/proof.sql,readonly`,
    ),
  );
  assert.ok(containerArgs.includes(NETWORK_ID));
  assert.ok(containerArgs.includes(IMAGE_ID));
  assert.equal(containerArgs.includes('-p'), false);
  assert.equal(containerArgs.includes('-v'), false);
  assert.equal(Object.isFrozen(containerArgs), true);
  assert.throws(() =>
    trainingAccountPostgresCommand(authority, fixture, 'create_container', {
      image: 'attacker-controlled',
    }),
  );
  await recovery.captureCreation(
    authority,
    'container',
    async () => CONTAINER_ID,
  );
});

it('plans readiness and SQL execution without exposing credential values', async () => {
  const { authority, fixture } = await readyContext();
  recovery.bindImageIdentity(authority, IMAGE_ID);
  await recovery.captureCreation(authority, 'network', async () => NETWORK_ID);
  await recovery.captureCreation(
    authority,
    'container',
    async () => CONTAINER_ID,
  );
  const readiness = trainingAccountPostgresCommand(
    authority,
    fixture,
    'wait_ready',
  );
  const assertions = trainingAccountPostgresCommand(
    authority,
    fixture,
    'run_assertions',
  );
  const rendered = [...readiness, ...assertions].join(' ');

  assert.ok(readiness.includes(CONTAINER_ID));
  assert.ok(assertions.includes('--user'));
  assert.ok(assertions.includes('0'));
  assert.ok(
    assertions.some((argument) => argument.includes('POSTGRES_PASSWORD')),
  );
  assert.ok(
    assertions.some((argument) =>
      argument.includes('/run/nina-proof/proof.sql'),
    ),
  );
  const psql = assertions.find((argument) => argument.includes('exec psql'));
  assert.match(psql, /psql --quiet --tuples-only --no-align --no-password/);
  assert.match(psql, /--no-psqlrc --set ON_ERROR_STOP=1/);
  assert.equal(psql.includes('--echo-all'), false);
  assert.equal(psql.includes('--echo-queries'), false);
  assert.equal(rendered.includes('POSTGRES_PASSWORD='), false);
  assert.equal(Object.isFrozen(assertions), true);
});

it('rejects forged fixture paths, invalid operations, and changed artifact identity', async () => {
  const { authority, fixture } = await readyContext();
  assert.throws(() =>
    trainingAccountPostgresCommand(authority, fixture, 'arbitrary'),
  );
  assert.throws(() =>
    trainingAccountPostgresCommand(
      authority,
      {
        ...fixture,
        artifacts: { ...fixture.artifacts, proofSql: '/tmp/foreign.sql' },
      },
      'create_container',
    ),
  );
  const getterFixture = { ...fixture };
  Object.defineProperty(getterFixture, 'database', {
    get() {
      throw new Error('synthetic secret-bearing getter');
    },
  });
  assert.throws(
    () =>
      trainingAccountPostgresCommand(authority, getterFixture, 'inspect_image'),
    { message: 'Training-account PostgreSQL command plan rejected' },
  );
  assert.throws(
    () => trainingAccountPostgresCommand({}, fixture, 'inspect_image'),
    { message: 'Training-account PostgreSQL command plan rejected' },
  );
  fs.chmodSync(fixture.artifacts.proofSql, 0o640);
  assert.throws(() =>
    trainingAccountPostgresCommand(authority, fixture, 'create_container'),
  );
});

it('preserves cached-image inspection but requires artifacts before network setup', async () => {
  const incomplete = await readyContext({ prepared: false });
  assert.doesNotThrow(() =>
    trainingAccountPostgresCommand(
      incomplete.authority,
      incomplete.fixture,
      'inspect_image',
    ),
  );
  recovery.bindImageIdentity(incomplete.authority, IMAGE_ID);
  assert.throws(() =>
    trainingAccountPostgresCommand(
      incomplete.authority,
      incomplete.fixture,
      'create_network',
    ),
  );
});

it('rejects resource and proof plans while finalization is in progress or complete', async () => {
  const active = await readyContext();
  recovery.bindImageIdentity(active.authority, IMAGE_ID);
  await recovery.captureCreation(
    active.authority,
    'network',
    async () => NETWORK_ID,
  );
  await recovery.captureCreation(
    active.authority,
    'container',
    async () => CONTAINER_ID,
  );
  let releaseInspection;
  const inspection = new Promise((resolve) => {
    releaseInspection = resolve;
  });
  const finalizing = recovery.finalizeRecovery(active.authority, {
    execute: async () => {
      await inspection;
      throw new Error('synthetic cleanup inspection failure');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (const operation of ['start_container', 'wait_ready', 'run_assertions']) {
    assert.throws(() =>
      trainingAccountPostgresCommand(
        active.authority,
        active.fixture,
        operation,
      ),
    );
  }
  releaseInspection();
  await finalizing;

  const finalizingNetwork = await readyContext();
  recovery.bindImageIdentity(finalizingNetwork.authority, IMAGE_ID);
  const finishingWithoutResources = recovery.finalizeRecovery(
    finalizingNetwork.authority,
    { execute: async () => '' },
  );
  assert.throws(() =>
    trainingAccountPostgresCommand(
      finalizingNetwork.authority,
      finalizingNetwork.fixture,
      'create_network',
    ),
  );
  await finishingWithoutResources;

  const finalized = await readyContext();
  recovery.bindImageIdentity(finalized.authority, IMAGE_ID);
  await recovery.finalizeRecovery(finalized.authority, {
    execute: async () => {
      throw new Error('synthetic unexpected cleanup command');
    },
  });
  assert.throws(() =>
    trainingAccountPostgresCommand(
      finalized.authority,
      finalized.fixture,
      'create_network',
    ),
  );
});
