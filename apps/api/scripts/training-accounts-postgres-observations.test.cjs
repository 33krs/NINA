const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, it } = require('node:test');
const recovery = require('./verify-training-accounts-postgres.cjs');
const {
  validateTrainingPostgresImage,
  validateTrainingPostgresNetwork,
  validateTrainingPostgresMounts,
} = require('./training-accounts-postgres-observations.cjs');

const NETWORK_ID = 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const PROOF_PATH = '/run/nina-proof/proof.sql';
const NETWORK_REJECTION =
  'Training-account PostgreSQL network observation rejected';
const roots = new Set();

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function image(overrides = {}) {
  return {
    Id: `sha256:${'a'.repeat(64)}`,
    RepoTags: ['postgres:15-alpine'],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      Env: [
        'PATH=/usr/local/bin',
        'PG_MAJOR=15',
        'PG_VERSION=15.19',
        'PGDATA=/var/lib/postgresql/data',
      ],
      Entrypoint: ['docker-entrypoint.sh'],
      Cmd: ['postgres'],
      User: '',
    },
    ...overrides,
  };
}

function observe(value, architecture = 'amd64') {
  return validateTrainingPostgresImage(JSON.stringify(value), architecture);
}

function networkContext() {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'postgres-network-observation-test-'),
  );
  roots.add(temporaryDirectory);
  return recovery.createRecoveryContext({ temporaryDirectory });
}

function mountObservation(context) {
  const { proofSql } = recovery.validatePreparedArtifacts(context);
  return {
    HostConfig: {
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=16m',
        '/run/postgresql': 'rw,noexec,nosuid,size=16m',
        '/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m',
      },
      Mounts: [
        { Type: 'bind', Source: proofSql, Target: PROOF_PATH, ReadOnly: true },
      ],
    },
    Mounts: [
      {
        Type: 'bind',
        Source: proofSql,
        Destination: PROOF_PATH,
        RW: false,
        Mode: 'ro',
      },
    ],
  };
}

async function registerNetwork(context, networkId = NETWORK_ID) {
  await recovery.captureCreation(context, 'network', async () => networkId);
}

async function registerContainer(context, containerId = CONTAINER_ID) {
  recovery.bindImageIdentity(context, IMAGE_ID);
  await recovery.captureCreation(context, 'container', async () => containerId);
}

function endpoint(name, overrides = {}) {
  return {
    Name: name,
    EndpointID: 'd'.repeat(64),
    MacAddress: '02:42:ac:12:00:02',
    IPv4Address: '172.18.0.2/16',
    IPv6Address: '',
    ...overrides,
  };
}

function networkObservation(context, overrides = {}) {
  return {
    Id: NETWORK_ID,
    Name: context.name,
    Driver: 'bridge',
    Internal: true,
    Labels: {
      'nina.training-postgres.owner': 'nina-suite',
      'nina.training-postgres.run': context.runId,
    },
    Containers: {},
    ...overrides,
  };
}

function validateNetwork(context, value, phase = 'created') {
  return validateTrainingPostgresNetwork(context, JSON.stringify(value), phase);
}

function assertNetworkRejected(context, value, phase = 'created') {
  assert.throws(() => validateNetwork(context, value, phase), {
    message: NETWORK_REJECTION,
  });
}

it('returns only frozen safe metadata for one compatible official-tag observation', () => {
  const observed = observe(image());
  assert.deepEqual(observed, {
    imageId: `sha256:${'a'.repeat(64)}`,
    architecture: 'amd64',
    major: '15',
    version: '15.19',
  });
  assert.equal(Object.isFrozen(observed), true);
});

it('accepts only the explicit supported architecture and matching expectation', () => {
  const arm = image({ Architecture: 'arm64' });
  assert.equal(observe(arm, 'arm64').architecture, 'arm64');
  for (const expected of ['x64', 'arm64v8', 'amd64;secret']) {
    assert.throws(() => observe(image(), expected), {
      message: 'Training-account PostgreSQL image observation rejected',
    });
  }
  assert.throws(() => observe(arm, 'amd64'));
});

it('rejects malformed, oversized, non-object, and multi-image observations generically', () => {
  for (const source of [
    '',
    '{secret-shaped bad JSON',
    'null',
    '[]',
    '1',
    ' '.repeat(262145),
  ]) {
    assert.throws(() => validateTrainingPostgresImage(source, 'amd64'), {
      message: 'Training-account PostgreSQL image observation rejected',
    });
  }
  assert.throws(() => observe([image()]));
  const withUnreturnedMetadata = observe({
    ...image(),
    leaked: 'synthetic-secret-value',
  });
  assert.equal(Object.hasOwn(withUnreturnedMetadata, 'leaked'), false);
});

it('rejects wrong identity, tag, operating system, and architecture metadata', () => {
  const base = image();
  const cases = [
    { ...base, Id: 'sha256:ABC' },
    { ...base, Id: 'a'.repeat(64) },
    { ...base, RepoTags: ['postgres:15'] },
    { ...base, Os: 'windows' },
    { ...base, Architecture: 's390x' },
  ];
  for (const value of cases) assert.throws(() => observe(value));
});

it('rejects missing, malformed, duplicate, conflicting, or wrong PostgreSQL config metadata', () => {
  const base = image();
  const cases = [
    {
      ...base,
      Config: {
        ...base.Config,
        Env: ['PG_VERSION=15.19', 'PGDATA=/var/lib/postgresql/data'],
      },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PG_MAJOR=15'] },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PG_VERSION=15.18'] },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PGDATA='] },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PG_VERSION=18.1'] },
    },
    {
      ...base,
      Config: {
        ...base.Config,
        Env: [...base.Config.Env, 'PGDATA=/var/lib/postgresql/18/docker'],
      },
    },
    { ...base, Config: { ...base.Config, Entrypoint: ['/custom-entrypoint'] } },
    { ...base, Config: { ...base.Config, Cmd: ['bash'] } },
    { ...base, Config: { ...base.Config, User: 'postgres' } },
  ];
  for (const value of cases) assert.throws(() => observe(value));
});

it('does not disclose rejected source content or expected-architecture input', () => {
  const secret = 'synthetic-observation-secret';
  const source = JSON.stringify({
    ...image(),
    Config: {
      ...image().Config,
      Env: [...image().Config.Env, `PG_VERSION=${secret}`],
    },
  });
  assert.throws(
    () => validateTrainingPostgresImage(source, 'amd64'),
    (error) => {
      assert.equal(
        error.message,
        'Training-account PostgreSQL image observation rejected',
      );
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

it('confirms a registered isolated bridge with no members before container creation', async () => {
  const context = networkContext();
  await registerNetwork(context);
  const result = validateNetwork(context, networkObservation(context));
  assert.deepEqual(result, {
    name: context.name,
    phase: 'created',
    driver: 'bridge',
    internal: true,
    memberCount: 0,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.hasOwn(result, 'networkId'), false);
  assert.equal(Object.hasOwn(result, 'labels'), false);
});

it('allows only an optionally attached registered member during network creation', async () => {
  const context = networkContext();
  await registerNetwork(context);
  const withoutContainer = networkObservation(context);
  assert.equal(validateNetwork(context, withoutContainer).memberCount, 0);

  await registerContainer(context);
  const attached = networkObservation(context, {
    Containers: { [CONTAINER_ID]: endpoint(context.name) },
  });
  assert.equal(validateNetwork(context, attached).memberCount, 1);
  assert.equal(validateNetwork(context, attached, 'running').memberCount, 1);
  assertNetworkRejected(context, withoutContainer, 'running');
});

it('requires exactly the registered owned container member in the running phase', async () => {
  const context = networkContext();
  await registerNetwork(context);
  await registerContainer(context);
  const observation = networkObservation(context, {
    Containers: { [CONTAINER_ID]: endpoint(context.name) },
  });
  assert.deepEqual(validateNetwork(context, observation, 'running'), {
    name: context.name,
    phase: 'running',
    driver: 'bridge',
    internal: true,
    memberCount: 1,
  });
});

it('rejects foreign identities, ownership labels, network settings, and members', async () => {
  const context = networkContext();
  await registerNetwork(context);
  await registerContainer(context);
  const valid = networkObservation(context);
  const cases = [
    { ...valid, Id: 'e'.repeat(64) },
    { ...valid, Name: `${context.name}-foreign` },
    {
      ...valid,
      Labels: {
        ...valid.Labels,
        'nina.training-postgres.run': crypto.randomUUID(),
      },
    },
    { ...valid, Labels: { ...valid.Labels, unexpected: 'synthetic' } },
    { ...valid, Driver: 'host' },
    { ...valid, Internal: false },
    { ...valid, Containers: null },
    { ...valid, Containers: [] },
    { ...valid, Containers: 'malformed' },
    { ...valid, Containers: { ['f'.repeat(64)]: endpoint(context.name) } },
    {
      ...valid,
      Containers: { [CONTAINER_ID]: endpoint(`${context.name}-foreign`) },
    },
    { ...valid, Containers: { [CONTAINER_ID]: null } },
    { ...valid, Containers: { [CONTAINER_ID]: { Name: context.name } } },
    {
      ...valid,
      Containers: { [CONTAINER_ID]: endpoint(context.name, { EndpointID: 7 }) },
    },
    {
      ...valid,
      Containers: { [CONTAINER_ID]: endpoint(context.name, { Extra: 'x' }) },
    },
  ];
  for (const value of cases) assertNetworkRejected(context, value);
  assert.throws(() => validateNetwork({}, valid), {
    message: NETWORK_REJECTION,
  });
});

it('rejects malformed, oversized, and lifecycle-ineligible network observations without echoing input', async () => {
  const context = networkContext();
  await registerNetwork(context);
  for (const source of [
    '',
    '{synthetic-network-secret',
    'null',
    '[]',
    ' '.repeat(65537),
  ]) {
    assert.throws(
      () => validateTrainingPostgresNetwork(context, source, 'created'),
      { message: NETWORK_REJECTION },
    );
  }
  assert.throws(
    () => validateNetwork(context, networkObservation(context), 'unknown'),
    {
      message: NETWORK_REJECTION,
    },
  );

  const unregistered = networkContext();
  assertNetworkRejected(unregistered, networkObservation(unregistered));

  const inFlight = networkContext();
  let release;
  const pending = recovery.captureCreation(
    inFlight,
    'network',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assertNetworkRejected(inFlight, networkObservation(inFlight));
  release(NETWORK_ID);
  await pending;
});

it('rejects proof-complete or cleanup-confirmed recovery contexts', async () => {
  const proofComplete = networkContext();
  await registerNetwork(proofComplete);
  await recovery.finalizeRecovery(proofComplete, {
    execute: async () => {
      throw new Error('synthetic cleanup failure');
    },
    proofSucceeded: true,
  });
  assertNetworkRejected(proofComplete, networkObservation(proofComplete));

  const cleanupConfirmed = networkContext();
  await registerNetwork(cleanupConfirmed);
  await recovery.finalizeRecovery(cleanupConfirmed, {
    execute: async (args) => {
      if (args[0] === 'network' && args[1] === 'inspect') {
        const error = new Error('synthetic absence');
        error.status = 1;
        error.stderr = `Error response from daemon: network ${NETWORK_ID} not found`;
        throw error;
      }
      return '';
    },
  });
  assertNetworkRejected(cleanupConfirmed, networkObservation(cleanupConfirmed));
});

it('validates the exact SQL bind and tmpfs mount contract independently', async () => {
  const context = networkContext();
  recovery.writePrivateArtifact(context, 'proof_sql', 'SELECT 1;\n');
  recovery.writePrivateArtifact(
    context,
    'postgres_env',
    'POSTGRES_DB=synthetic\nPOSTGRES_USER=synthetic\nPOSTGRES_PASSWORD=synthetic\n',
  );
  const valid = mountObservation(context);
  const result = validateTrainingPostgresMounts(context, JSON.stringify(valid));
  assert.deepEqual(result, {
    proofMountReadonly: true,
    temporaryFileSystems: 3,
  });
  assert.equal(Object.isFrozen(result), true);

  const cases = [
    {
      ...valid,
      HostConfig: {
        ...valid.HostConfig,
        Tmpfs: { ...valid.HostConfig.Tmpfs, '/tmp': 'rw' },
      },
    },
    {
      ...valid,
      HostConfig: {
        ...valid.HostConfig,
        Mounts: [{ ...valid.HostConfig.Mounts[0], ReadOnly: false }],
      },
    },
    {
      ...valid,
      Mounts: valid.Mounts.map((mount) => ({ ...mount, RW: true })),
    },
    {
      ...valid,
      Mounts: [
        ...valid.Mounts,
        {
          Type: 'volume',
          Name: 'synthetic-volume',
          Source: '/var/lib/docker/volumes/synthetic',
          Destination: '/var/lib/postgresql/data',
          RW: true,
        },
      ],
    },
  ];
  for (const value of cases) {
    assert.throws(
      () => validateTrainingPostgresMounts(context, JSON.stringify(value)),
      { message: 'Training-account PostgreSQL mount observation rejected' },
    );
  }
});
