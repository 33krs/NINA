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
  validateTrainingPostgresIsolation,
} = require('./training-accounts-postgres-observations.cjs');

const NETWORK_ID = 'b'.repeat(64);
const CONTAINER_ID = 'c'.repeat(64);
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const NETWORK_REJECTION =
  'Training-account PostgreSQL network observation rejected';
const ISOLATION_REJECTION =
  'Training-account PostgreSQL isolation observation rejected';
const PROOF_PATH = '/run/nina-proof/proof.sql';
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

async function registerNetwork(context, networkId = NETWORK_ID) {
  await recovery.captureCreation(context, 'network', async () => networkId);
}

async function registerContainer(context, containerId = CONTAINER_ID) {
  recovery.bindImageIdentity(context, IMAGE_ID);
  await recovery.captureCreation(context, 'container', async () => containerId);
}

async function preparedIsolationContext() {
  const context = networkContext();
  recovery.writePrivateArtifact(context, 'proof_sql', 'SELECT 1;\n');
  recovery.writePrivateArtifact(
    context,
    'postgres_env',
    'POSTGRES_DB=synthetic\nPOSTGRES_USER=synthetic\nPOSTGRES_PASSWORD=synthetic\n',
  );
  await registerNetwork(context);
  await registerContainer(context);
  return context;
}

function containerObservation(context, phase = 'running', overrides = {}) {
  const prepared = recovery.validatePreparedArtifacts(context);
  const running = phase === 'running';
  return {
    Id: CONTAINER_ID,
    Image: IMAGE_ID,
    Name: `/${context.name}`,
    Config: {
      Image: IMAGE_ID,
      Labels: {
        'nina.training-postgres.owner': 'nina-suite',
        'nina.training-postgres.run': context.runId,
      },
      User: '0',
      Entrypoint: ['docker-entrypoint.sh'],
      Cmd: ['postgres'],
      ExposedPorts: { '5432/tcp': {} },
      Volumes: { '/var/lib/postgresql/data': {} },
    },
    State: {
      Status: running ? 'running' : 'created',
      Running: running,
      Paused: false,
      Restarting: false,
      Dead: false,
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: null,
      NetworkMode: NETWORK_ID,
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=16m',
        '/run/postgresql': 'rw,noexec,nosuid,size=16m',
        '/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m',
      },
      Mounts: [
        {
          Type: 'bind',
          Source: prepared.proofSql,
          Target: PROOF_PATH,
          ReadOnly: true,
        },
      ],
    },
    Mounts: [
      {
        Type: 'bind',
        Source: prepared.proofSql,
        Destination: PROOF_PATH,
        RW: false,
        Mode: 'ro',
      },
    ],
    NetworkSettings: {
      Networks: {
        [context.name]: {
          NetworkID: NETWORK_ID,
          EndpointID: running ? 'd'.repeat(64) : '',
        },
      },
      Ports: { '5432/tcp': null },
    },
    ...overrides,
  };
}

function isolationNetwork(context, phase = 'running', overrides = {}) {
  const running = phase === 'running';
  return networkObservation(context, {
    Containers: running ? { [CONTAINER_ID]: endpoint(context.name) } : {},
    ...overrides,
  });
}

function validateIsolation(context, container, network, phase = 'running') {
  return validateTrainingPostgresIsolation(
    context,
    JSON.stringify(container),
    JSON.stringify(network),
    phase,
  );
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

it('accepts registered container isolation only for created and running phases', async () => {
  const context = await preparedIsolationContext();
  const created = validateIsolation(
    context,
    containerObservation(context, 'created'),
    isolationNetwork(context, 'created'),
    'created',
  );
  assert.equal(created.phase, 'created');
  assert.equal(created.containerId, CONTAINER_ID);
  assert.equal(created.networkId, NETWORK_ID);
  assert.equal(created.imageId, IMAGE_ID);
  assert.equal(created.networkMemberCount, 0);
  assert.equal(created.readonlyRootfs, true);
  assert.equal(Object.isFrozen(created), true);

  const running = validateIsolation(
    context,
    containerObservation(context),
    isolationNetwork(context),
  );
  assert.equal(running.phase, 'running');
  assert.equal(running.networkMemberCount, 1);
  assert.equal(Object.isFrozen(running), true);
  assert.equal(Object.hasOwn(running, 'artifacts'), false);

  const withObservedTmpfs = containerObservation(context);
  withObservedTmpfs.Mounts.push(
    ...Object.entries({
      '/tmp': 'rw,noexec,nosuid,size=16m',
      '/run/postgresql': 'rw,noexec,nosuid,size=16m',
      '/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m',
    }).map(([Destination, Mode]) => ({
      Type: 'tmpfs',
      Source: 'tmpfs',
      Destination,
      RW: true,
      Mode,
    })),
  );
  assert.equal(
    validateIsolation(context, withObservedTmpfs, isolationNetwork(context))
      .proofMountReadonly,
    true,
  );
});

it('validates the exact SQL bind and tmpfs mount contract independently', async () => {
  const context = networkContext();
  recovery.writePrivateArtifact(context, 'proof_sql', 'SELECT 1;\n');
  recovery.writePrivateArtifact(
    context,
    'postgres_env',
    'POSTGRES_DB=synthetic\nPOSTGRES_USER=synthetic\nPOSTGRES_PASSWORD=synthetic\n',
  );
  const valid = containerObservation(context);
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

it('rejects identity, runtime-state, isolation, publishing, and ownership drift', async () => {
  const context = await preparedIsolationContext();
  const valid = containerObservation(context);
  const cases = [
    { ...valid, Id: 'e'.repeat(64) },
    { ...valid, Image: `sha256:${'f'.repeat(64)}` },
    (() => {
      const { Image, ...withoutImage } = valid;
      return withoutImage;
    })(),
    { ...valid, Name: `/${context.name}-foreign` },
    {
      ...valid,
      Config: { ...valid.Config, Image: `sha256:${'f'.repeat(64)}` },
    },
    { ...valid, Config: { ...valid.Config, User: 'postgres' } },
    {
      ...valid,
      Config: { ...valid.Config, Entrypoint: ['sh'] },
    },
    { ...valid, Config: { ...valid.Config, Cmd: ['bash'] } },
    { ...valid, State: { ...valid.State, Paused: true } },
    { ...valid, State: { ...valid.State, Restarting: true } },
    { ...valid, State: { ...valid.State, Dead: true } },
    { ...valid, State: { ...valid.State, Running: false } },
    { ...valid, HostConfig: { ...valid.HostConfig, ReadonlyRootfs: false } },
    { ...valid, HostConfig: { ...valid.HostConfig, Privileged: true } },
    { ...valid, HostConfig: { ...valid.HostConfig, PublishAllPorts: true } },
    {
      ...valid,
      HostConfig: { ...valid.HostConfig, PortBindings: { '5432/tcp': [{}] } },
    },
    {
      ...valid,
      HostConfig: {
        ...valid.HostConfig,
        NetworkMode: 'foreign-network',
      },
    },
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
        Mounts: [
          ...valid.HostConfig.Mounts,
          {
            Type: 'bind',
            Source: '/synthetic/foreign',
            Target: '/foreign',
            ReadOnly: true,
          },
        ],
      },
    },
    {
      ...valid,
      HostConfig: {
        ...valid.HostConfig,
        Mounts: [
          {
            ...valid.HostConfig.Mounts[0],
            ReadOnly: false,
          },
        ],
      },
    },
    {
      ...valid,
      Mounts: [...valid.Mounts, { ...valid.Mounts[0] }],
    },
    {
      ...valid,
      Mounts: [
        ...valid.Mounts,
        {
          Type: 'tmpfs',
          Destination: '/tmp',
          RW: true,
          Mode: 'rw',
        },
      ],
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
    {
      ...valid,
      Mounts: valid.Mounts.map((mount) => ({ ...mount, RW: true })),
    },
    {
      ...valid,
      NetworkSettings: {
        ...valid.NetworkSettings,
        Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] },
      },
    },
    {
      ...valid,
      NetworkSettings: {
        Networks: {
          'foreign-network': { NetworkID: NETWORK_ID },
        },
        Ports: { '5432/tcp': null },
      },
    },
    {
      ...valid,
      NetworkSettings: {
        ...valid.NetworkSettings,
        Networks: {
          ...valid.NetworkSettings.Networks,
          'foreign-network': { NetworkID: 'f'.repeat(64) },
        },
      },
    },
    {
      ...valid,
      NetworkSettings: {
        ...valid.NetworkSettings,
        Networks: {
          [context.name]: {
            ...valid.NetworkSettings.Networks[context.name],
            EndpointID: '',
          },
        },
      },
    },
  ];
  for (const value of cases) {
    assert.throws(
      () => validateIsolation(context, value, isolationNetwork(context)),
      { message: ISOLATION_REJECTION },
    );
  }

  for (const [key, value] of [
    ['Paused', undefined],
    ['Restarting', undefined],
    ['Dead', undefined],
  ]) {
    const state = { ...valid.State };
    delete state[key];
    assert.throws(
      () =>
        validateIsolation(
          context,
          { ...valid, State: state },
          isolationNetwork(context),
        ),
      { message: ISOLATION_REJECTION },
    );
  }

  const createdWrong = containerObservation(context, 'created');
  createdWrong.State = { ...createdWrong.State, Running: true };
  assert.throws(
    () =>
      validateIsolation(
        context,
        createdWrong,
        isolationNetwork(context, 'created'),
        'created',
      ),
    { message: ISOLATION_REJECTION },
  );
});

it('rejects malformed observations and unprepared or changed private artifacts without echoing content', async () => {
  const context = await preparedIsolationContext();
  const valid = containerObservation(context);
  for (const source of [
    '',
    '{synthetic-isolation-secret',
    'null',
    '[]',
    '1',
    ' '.repeat(262145),
  ]) {
    assert.throws(
      () =>
        validateTrainingPostgresIsolation(
          context,
          source,
          JSON.stringify(isolationNetwork(context)),
          'running',
        ),
      { message: ISOLATION_REJECTION },
    );
  }
  assert.throws(() => validateIsolation({}, valid, isolationNetwork(context)), {
    message: ISOLATION_REJECTION,
  });
  assert.throws(
    () =>
      validateIsolation(context, valid, isolationNetwork(context), 'unknown'),
    { message: ISOLATION_REJECTION },
  );

  const unprepared = networkContext();
  assert.throws(
    () =>
      validateIsolation(
        unprepared,
        containerObservation(context),
        isolationNetwork(context),
      ),
    { message: ISOLATION_REJECTION },
  );

  const prepared = recovery.validatePreparedArtifacts(context);
  fs.unlinkSync(prepared.proofSql);
  fs.writeFileSync(prepared.proofSql, 'synthetic replacement');
  fs.chmodSync(prepared.proofSql, 0o600);
  assert.throws(
    () => validateIsolation(context, valid, isolationNetwork(context)),
    { message: ISOLATION_REJECTION },
  );
});
