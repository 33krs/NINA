const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dockerArgs,
  ownedContainerId,
  reconcileOwnedResources,
  createCancellation,
  createPossiblyOwned,
  timeoutFor,
  validateIsolatedClient,
  subprocessEnvironment,
} = require('./verify-odontogram-postgres.cjs');

test('Docker commands are pinned to the local socket and cannot pull images', () => {
  assert.deepEqual(dockerArgs(['run', '--pull=never']), [
    '--host',
    'unix:///var/run/docker.sock',
    'run',
    '--pull=never',
  ]);
});

test('subprocess environment excludes ambient database and credential values', () => {
  const env = subprocessEnvironment({
    path: '/usr/bin',
    home: '/tmp/nina-suite',
    databaseUrl: 'postgresql://suite@127.0.0.1:49152/suite',
    runId: 'run-123',
    proofFile: '/tmp/nina-suite/proof.json',
    ambient: {
      DATABASE_URL: 'postgresql://production.invalid/clinical',
      PGHOST: 'production.invalid',
      AWS_SECRET_ACCESS_KEY: 'must-not-pass',
    },
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/tmp/nina-suite',
    TMPDIR: '/tmp/nina-suite',
    DATABASE_URL: 'postgresql://suite@127.0.0.1:49152/suite',
    NINA_ODONTOGRAM_PG15_RUN_ID: 'run-123',
    NINA_ODONTOGRAM_PG15_PROOF_FILE: '/tmp/nina-suite/proof.json',
    NINA_ODONTOGRAM_PG15_TESTS: '1',
  });
});

test('cleanup accepts only the exact inspected, correctly labelled owned container', () => {
  const containerId = '1234567890abcdef';
  const inspect = {
    Id: containerId,
    Config: {
      Image: 'postgres:15-alpine',
      Labels: {
        'nina.odontogram-postgres15.owner': 'nina-suite',
        'nina.odontogram-postgres15.run': 'run-123',
      },
    },
  };

  assert.equal(ownedContainerId(inspect, containerId, 'run-123'), containerId);
  assert.throws(() => ownedContainerId(inspect, 'other-container', 'run-123'));
  assert.throws(() => ownedContainerId(inspect, containerId, 'other-run'));
});

test('every subprocess receives an explicit finite timeout', () => {
  assert.ok(Number.isInteger(timeoutFor('docker')) && timeoutFor('docker') > 0);
  assert.ok(Number.isInteger(timeoutFor('prisma')) && timeoutFor('prisma') > 0);
  assert.throws(() => timeoutFor('unknown-operation'));
});

test('a signal cancels the next step so the runner enters its cleanup path', () => {
  const cancellation = createCancellation();
  const state = { containerCreateUncertain: false };
  let created = false;
  let removed = false;
  const runId = 'signal-run';
  const name = 'nina-odontogram-pg15-signal-run';
  const containerId = 'signal-owned-container';
  assert.throws(
    () =>
      createPossiblyOwned(state, 'containerCreateUncertain', () => {
        created = true;
        cancellation.request('SIGTERM');
        cancellation.throwIfCancelled();
        return 'not-captured';
      }),
    /cancelled by signal/,
  );
  assert.equal(cancellation.exitCode, 143);
  assert.equal(state.containerCreateUncertain, true);
  assert.equal(created, true);
  const result = reconcileOwnedResources({
    docker(args) {
      if (
        args[0] === 'inspect' &&
        (args[1] === name || args[1] === containerId) &&
        !removed
      ) {
        return JSON.stringify([
          {
            Id: containerId,
            Name: `/${name}`,
            Config: {
              Image: 'postgres:15-alpine',
              Labels: {
                'nina.odontogram-postgres15.owner': 'nina-suite',
                'nina.odontogram-postgres15.run': runId,
              },
            },
          },
        ]);
      }
      if (args[0] === 'rm') {
        removed = true;
        return '';
      }
      const error = new Error('container absent');
      error.status = 1;
      error.stderr = 'No such object';
      throw error;
    },
    runId,
    name,
    containerId: undefined,
    networkId: undefined,
    containerCreateUncertain: state.containerCreateUncertain,
    networkCreateUncertain: false,
  });
  assert.deepEqual(result, { containerId, networkId: undefined });
  assert.equal(removed, true);
});

test('an uncertain create is reconciled only by unique name and exact ownership labels', () => {
  const calls = [];
  const runId = 'run-123';
  const containerId = 'owned-container-id';
  const networkId = 'owned-network-id';
  let containerRemoved = false;
  let networkRemoved = false;
  const docker = (args) => {
    calls.push(args);
    if (args[0] === 'inspect' && args[1] === 'nina-odontogram-pg15-run-123')
      return JSON.stringify([
        {
          Id: containerId,
          Name: '/nina-odontogram-pg15-run-123',
          Config: {
            Image: 'postgres:15-alpine',
            Labels: {
              'nina.odontogram-postgres15.owner': 'nina-suite',
              'nina.odontogram-postgres15.run': runId,
            },
          },
        },
      ]);
    if (args[0] === 'inspect' && args[1] === containerId && !containerRemoved)
      return JSON.stringify([
        {
          Id: containerId,
          Name: '/nina-odontogram-pg15-run-123',
          Config: {
            Image: 'postgres:15-alpine',
            Labels: {
              'nina.odontogram-postgres15.owner': 'nina-suite',
              'nina.odontogram-postgres15.run': runId,
            },
          },
        },
      ]);
    if (args[0] === 'inspect' && args[1] === containerId && containerRemoved) {
      const error = new Error('not found');
      error.status = 1;
      error.stderr = 'No such object';
      throw error;
    }
    if (
      args[0] === 'network' &&
      args[1] === 'inspect' &&
      args[2] === 'nina-odontogram-pg15-run-123'
    )
      return JSON.stringify([
        {
          Id: networkId,
          Name: 'nina-odontogram-pg15-run-123',
          Labels: {
            'nina.odontogram-postgres15.owner': 'nina-suite',
            'nina.odontogram-postgres15.run': runId,
          },
        },
      ]);
    if (
      args[0] === 'network' &&
      args[1] === 'inspect' &&
      args[2] === networkId &&
      !networkRemoved
    )
      return JSON.stringify([
        {
          Id: networkId,
          Name: 'nina-odontogram-pg15-run-123',
          Labels: {
            'nina.odontogram-postgres15.owner': 'nina-suite',
            'nina.odontogram-postgres15.run': runId,
          },
        },
      ]);
    if (
      args[0] === 'network' &&
      args[1] === 'inspect' &&
      args[2] === networkId &&
      networkRemoved
    ) {
      const error = new Error('not found');
      error.status = 1;
      error.stderr = 'not found';
      throw error;
    }
    if (args[0] === 'rm') containerRemoved = true;
    if (args[0] === 'network' && args[1] === 'rm') networkRemoved = true;
    return '';
  };

  const result = reconcileOwnedResources({
    docker,
    runId,
    name: 'nina-odontogram-pg15-run-123',
    containerId: undefined,
    networkId: undefined,
    containerCreateUncertain: true,
    networkCreateUncertain: true,
  });

  assert.deepEqual(result, { containerId, networkId });
  assert.deepEqual(calls, [
    ['inspect', 'nina-odontogram-pg15-run-123'],
    ['inspect', containerId],
    ['rm', '--force', containerId],
    ['inspect', containerId],
    ['network', 'inspect', 'nina-odontogram-pg15-run-123'],
    ['network', 'inspect', networkId],
    ['network', 'rm', networkId],
    ['network', 'inspect', networkId],
  ]);
  assert.equal(containerRemoved, true);
  assert.equal(networkRemoved, true);
});

test('uncertain create reconciliation refuses a same-name resource with foreign labels', () => {
  const docker = () =>
    JSON.stringify([
      {
        Id: 'foreign-container',
        Config: {
          Image: 'postgres:15-alpine',
          Labels: {
            'nina.odontogram-postgres15.owner': 'someone-else',
            'nina.odontogram-postgres15.run': 'run-123',
          },
        },
      },
    ]);
  assert.throws(
    () =>
      reconcileOwnedResources({
        docker,
        runId: 'run-123',
        name: 'nina-odontogram-pg15-run-123',
        containerCreateUncertain: true,
        networkCreateUncertain: false,
      }),
    /Refusing cleanup/,
  );
});

test('isolated Prisma client paths stay in runner temp storage and never resolve to repo env', () => {
  assert.equal(
    validateIsolatedClient({
      clientPath: '/tmp/nina-odontogram-pg15-run/client/index.js',
      tempRoot: '/tmp/nina-odontogram-pg15-run',
      schemaEnvPath: '/tmp/nina-odontogram-pg15-run/prisma/.env',
    }),
    true,
  );
  assert.throws(() =>
    validateIsolatedClient({
      clientPath: '/repo/apps/api/node_modules/@prisma/client/default.js',
      tempRoot: '/tmp/nina-odontogram-pg15-run',
      schemaEnvPath: '/repo/apps/api/.env',
    }),
  );
});
