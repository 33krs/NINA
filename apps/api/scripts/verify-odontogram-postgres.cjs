const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DOCKER_HOST = 'unix:///var/run/docker.sock';
const OWNER_LABEL = 'nina.odontogram-postgres15.owner';
const RUN_LABEL = 'nina.odontogram-postgres15.run';
const OWNER_VALUE = 'nina-suite';
const IMAGE = 'postgres:15-alpine';
const OPERATION_TIMEOUTS = Object.freeze({
  docker: 15_000,
  prisma: 120_000,
  jest: 180_000,
});

function timeoutFor(operation) {
  const timeout = OPERATION_TIMEOUTS[operation];
  if (!Number.isInteger(timeout) || timeout <= 0)
    throw new Error('Unknown bounded subprocess operation');
  return timeout;
}

function createCancellation() {
  let exitCode;
  return {
    request(signal) {
      exitCode = signal === 'SIGINT' ? 130 : 143;
    },
    get exitCode() {
      return exitCode;
    },
    throwIfCancelled() {
      if (exitCode)
        throw new Error('PostgreSQL verification cancelled by signal');
    },
  };
}

function createPossiblyOwned(state, uncertainKey, create) {
  state[uncertainKey] = true;
  const id = create();
  state[uncertainKey] = false;
  return id;
}

function dockerArgs(args) {
  return ['--host', DOCKER_HOST, ...args];
}

function subprocessEnvironment({
  path: executablePath,
  home,
  databaseUrl,
  runId,
  proofFile,
}) {
  return {
    PATH: executablePath,
    HOME: home,
    TMPDIR: home,
    DATABASE_URL: databaseUrl,
    NINA_ODONTOGRAM_PG15_RUN_ID: runId,
    NINA_ODONTOGRAM_PG15_PROOF_FILE: proofFile,
    NINA_ODONTOGRAM_PG15_TESTS: '1',
  };
}

function ownedContainerId(inspect, expectedId, runId) {
  if (
    inspect.Id !== expectedId ||
    inspect.Config?.Image !== IMAGE ||
    inspect.Config?.Labels?.[OWNER_LABEL] !== OWNER_VALUE ||
    inspect.Config?.Labels?.[RUN_LABEL] !== runId
  ) {
    throw new Error(
      'Refusing cleanup: container identity or ownership labels do not match',
    );
  }
  return expectedId;
}

function validateIsolatedClient({ clientPath, tempRoot, schemaEnvPath }) {
  const root = path.resolve(tempRoot) + path.sep;
  const isolatedClient = path.resolve(clientPath);
  const envPath = path.resolve(schemaEnvPath);
  if (!isolatedClient.startsWith(root) || !envPath.startsWith(root)) {
    throw new Error(
      'Prisma client and schema env path must remain inside runner temporary storage',
    );
  }
  if (envPath.includes(`${path.sep}apps${path.sep}api${path.sep}`)) {
    throw new Error(
      'Prisma client must not resolve repository environment files',
    );
  }
  return true;
}

function reconcileOwnedResources({
  docker,
  runId,
  name,
  containerId,
  networkId,
  containerCreateUncertain,
  networkCreateUncertain,
}) {
  let safeContainerId = containerId;
  let safeNetworkId = networkId;
  if (containerCreateUncertain && !safeContainerId) {
    const inspected = inspectOptional(() => docker(['inspect', name]));
    if (inspected) {
      if (inspected.Name?.replace(/^\//, '') !== name) {
        throw new Error(
          'Refusing cleanup: container name does not match this run',
        );
      }
      safeContainerId = ownedContainerId(inspected, inspected.Id, runId);
    }
  }
  if (safeContainerId) {
    const inspected = JSON.parse(docker(['inspect', safeContainerId]))[0];
    ownedContainerId(inspected, safeContainerId, runId);
    docker(['rm', '--force', safeContainerId]);
    assertMissing(
      () => docker(['inspect', safeContainerId]),
      'owned container must be removed',
    );
  }

  if (networkCreateUncertain && !safeNetworkId) {
    const inspected = inspectOptional(() =>
      docker(['network', 'inspect', name]),
    );
    if (inspected) {
      if (
        inspected.Name !== name ||
        inspected.Labels?.[OWNER_LABEL] !== OWNER_VALUE ||
        inspected.Labels?.[RUN_LABEL] !== runId
      ) {
        throw new Error(
          'Refusing cleanup: network identity or ownership labels do not match',
        );
      }
      safeNetworkId = inspected.Id;
    }
  }
  if (safeNetworkId) {
    const inspected = JSON.parse(
      docker(['network', 'inspect', safeNetworkId]),
    )[0];
    if (
      inspected.Id !== safeNetworkId ||
      inspected.Name !== name ||
      inspected.Labels?.[OWNER_LABEL] !== OWNER_VALUE ||
      inspected.Labels?.[RUN_LABEL] !== runId
    ) {
      throw new Error(
        'Refusing cleanup: network identity or ownership labels do not match',
      );
    }
    docker(['network', 'rm', safeNetworkId]);
    assertMissing(
      () => docker(['network', 'inspect', safeNetworkId]),
      'owned network must be removed',
    );
  }
  return { containerId: safeContainerId, networkId: safeNetworkId };
}

function inspectOptional(inspect) {
  try {
    return JSON.parse(inspect())[0];
  } catch (error) {
    if (
      error.status === 1 &&
      /No such object|not found/i.test(error.stderr || '')
    )
      return undefined;
    throw error;
  }
}

function assertMissing(inspect, message) {
  assert.equal(inspectOptional(inspect), undefined, message);
}

function run(command, args, options = {}) {
  options.guard?.();
  const timeout =
    options.timeout ??
    timeoutFor(path.basename(command) === 'docker' ? 'docker' : 'prisma');
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    result.error.status = result.status;
    result.error.stderr = result.stderr || '';
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(
      `${path.basename(command)} exited ${result.status}: ${(result.stderr || '').trim()}`,
    );
    error.status = result.status;
    error.stderr = result.stderr || '';
    throw error;
  }
  options.guard?.();
  return (result.stdout || '').trim();
}

function docker(args, options = {}) {
  return run('docker', dockerArgs(args), {
    ...options,
    env: { PATH: process.env.PATH, HOME: options.home ?? os.tmpdir() },
  });
}

function waitForPostgres(port, timeoutMs = 30_000, guard) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      try {
        guard?.();
      } catch (error) {
        reject(error);
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline)
          reject(new Error('PostgreSQL did not accept a loopback connection'));
        else setTimeout(attempt, 200);
      });
      socket.once('timeout', () => {
        socket.destroy();
        if (Date.now() >= deadline)
          reject(new Error('PostgreSQL readiness timed out'));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function waitForServerInsideContainer(
  containerId,
  user,
  database,
  home,
  timeoutMs = 30_000,
  guard,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    guard?.();
    try {
      run(
        'docker',
        dockerArgs([
          'exec',
          containerId,
          'pg_isready',
          '-q',
          '-h',
          '127.0.0.1',
          '-p',
          '5432',
          '-U',
          user,
          '-d',
          database,
        ]),
        { env: { PATH: process.env.PATH, HOME: home }, timeout: 5_000, guard },
      );
      return;
    } catch (error) {
      if (
        error.message.includes('cancelled') ||
        error.code === 'ETIMEDOUT' ||
        error.killed
      )
        throw error;
    }
    const details = JSON.parse(docker(['inspect', containerId], { home }))[0];
    if (details.State?.Status !== 'running') {
      throw new Error(
        `PostgreSQL container is ${details.State?.Status}: ${details.State?.Error || ''}`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error('PostgreSQL did not become ready inside the owned container');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForPublishedPort(
  containerId,
  home,
  timeoutMs = 30_000,
  guard,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    guard?.();
    const details = JSON.parse(
      docker(['inspect', containerId], { home, guard }),
    )[0];
    const binding = details.NetworkSettings?.Ports?.['5432/tcp']?.[0];
    if (binding?.HostIp === '127.0.0.1' && /^\d+$/.test(binding.HostPort)) {
      return Number(binding.HostPort);
    }
    if (details.State?.Status !== 'running') {
      throw new Error(
        `PostgreSQL container is ${details.State?.Status}: ${details.State?.Error || ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    'Docker did not publish the requested loopback PostgreSQL port',
  );
}

function prepareIsolatedClient(schemaPath, tempRoot) {
  let schema = fs.readFileSync(schemaPath, 'utf8');
  let found = false;
  schema = schema.replace(
    /generator\s+client\s*\{([\s\S]*?)\}/,
    (_block, body) => {
      found = true;
      if (/^\s*output\s*=/m.test(body))
        throw new Error('Unexpected Prisma generator output in copied schema');
      return `generator client {${body}\n  output = "../isolated-client"\n}`;
    },
  );
  if (!found)
    throw new Error('Prisma client generator was not found in copied schema');
  fs.writeFileSync(schemaPath, schema);
  const clientPath = path.join(tempRoot, 'isolated-client', 'index.js');
  validateIsolatedClient({
    clientPath,
    tempRoot,
    schemaEnvPath: path.join(tempRoot, 'prisma', '.env'),
  });
  return clientPath;
}

function copyMigrationStage(apiRoot, tempRoot, includeHistory) {
  const source = path.join(apiRoot, 'prisma');
  const target = path.join(tempRoot, 'prisma');
  fs.mkdirSync(path.join(target, 'migrations'), { recursive: true });
  fs.copyFileSync(
    path.join(source, 'schema.prisma'),
    path.join(target, 'schema.prisma'),
  );
  fs.copyFileSync(
    path.join(source, 'migrations', 'migration_lock.toml'),
    path.join(target, 'migrations', 'migration_lock.toml'),
  );
  for (const name of fs.readdirSync(path.join(source, 'migrations')).sort()) {
    if (name === 'migration_lock.toml') continue;
    if (!includeHistory && name.includes('add_odontogram_history')) continue;
    fs.cpSync(
      path.join(source, 'migrations', name),
      path.join(target, 'migrations', name),
      { recursive: true },
    );
  }
  return path.join(target, 'schema.prisma');
}

function assertProof(proof) {
  assert.equal(proof.owner, OWNER_VALUE);
  assert.equal(proof.image, IMAGE);
  assert.equal(proof.networkIsolated, true);
  assert.equal(proof.networkMembers, 1);
  assert.equal(proof.publishedHost, '127.0.0.1');
  assert.equal(proof.auth, 'isolated-trust');
}

async function main() {
  const apiRoot = path.resolve(__dirname, '..');
  const runId = crypto.randomUUID();
  const name = `nina-odontogram-pg15-${runId.slice(0, 12)}`;
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nina-odontogram-pg15-'),
  );
  const proofFile = path.join(tempRoot, 'container-proof.json');
  const database = `nina_${runId.replaceAll('-', '').slice(0, 16)}`;
  const user = `nina_${runId.replaceAll('-', '').slice(16, 28)}`;
  const url = `postgresql://${user}@127.0.0.1:`;
  let networkId;
  let containerId;
  let imageId;
  let serverVersion;
  let port;
  let cleanupFailure;
  const creationState = {
    networkCreateUncertain: false,
    containerCreateUncertain: false,
  };
  const cancellation = createCancellation();
  const guard = cancellation.throwIfCancelled;
  let passed = false;

  const cleanup = () => {
    let outcome = { containerId, networkId };
    try {
      outcome = reconcileOwnedResources({
        docker: (args) => docker(args, { home: tempRoot }),
        runId,
        name,
        containerId,
        networkId,
        containerCreateUncertain: creationState.containerCreateUncertain,
        networkCreateUncertain: creationState.networkCreateUncertain,
      });
      containerId = outcome.containerId;
      networkId = outcome.networkId;
    } catch (error) {
      cleanupFailure = error;
      console.error(`CLEANUP_FAILED ${error.message}`);
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    const complete = !cleanupFailure;
    console.log(
      `CLEANUP_ASSERTED container_id=${outcome.containerId ?? 'none'} container=${complete ? 'removed-owned-id-or-not-created' : 'FAILED'} network_id=${outcome.networkId ?? 'none'} network=${complete ? 'removed-owned-id-or-not-created' : 'FAILED'}`,
    );
    if (cleanupFailure) throw cleanupFailure;
  };
  const signalHandler = (signal) => {
    cancellation.request(signal);
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  try {
    imageId = docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE], {
      home: tempRoot,
      guard,
    });
    assert.ok(
      imageId,
      'required PostgreSQL image must already exist; pulls are disabled',
    );
    guard();
    port = await freePort();
    guard();
    networkId = createPossiblyOwned(
      creationState,
      'networkCreateUncertain',
      () =>
        docker(
          [
            'network',
            'create',
            '--label',
            `${OWNER_LABEL}=${OWNER_VALUE}`,
            '--label',
            `${RUN_LABEL}=${runId}`,
            name,
          ],
          { home: tempRoot, guard },
        ),
    );
    containerId = createPossiblyOwned(
      creationState,
      'containerCreateUncertain',
      () =>
        docker(
          [
            'create',
            '--pull=never',
            '--name',
            name,
            '--network',
            name,
            '--tmpfs',
            '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
            '--publish',
            `127.0.0.1:${port}:5432`,
            '--env',
            `POSTGRES_DB=${database}`,
            '--env',
            `POSTGRES_USER=${user}`,
            '--env',
            'POSTGRES_HOST_AUTH_METHOD=trust',
            '--label',
            `${OWNER_LABEL}=${OWNER_VALUE}`,
            '--label',
            `${RUN_LABEL}=${runId}`,
            IMAGE,
          ],
          { home: tempRoot, guard },
        ),
    );
    docker(['start', containerId], { home: tempRoot, guard });

    const details = JSON.parse(
      docker(['inspect', containerId], { home: tempRoot, guard }),
    )[0];
    assert.equal(details.Id, containerId);
    assert.equal(details.Config.Image, IMAGE);
    assert.equal(details.Config.Labels?.[OWNER_LABEL], OWNER_VALUE);
    assert.equal(details.Config.Labels?.[RUN_LABEL], runId);
    assert.equal(details.NetworkSettings.Networks[name]?.NetworkID, networkId);
    assert.equal(details.HostConfig.NetworkMode, name);
    const mounts = details.Mounts ?? [];
    assert.ok(
      mounts.every(
        (mount) =>
          mount.Type === 'tmpfs' &&
          mount.Destination === '/var/lib/postgresql/data',
      ),
    );
    assert.ok(
      mounts.length <= 1,
      'the container must have no bind mounts or persistent volumes',
    );
    assert.ok(details.HostConfig.Tmpfs?.['/var/lib/postgresql/data']);
    assert.equal(
      details.HostConfig.PortBindings['5432/tcp'][0].HostIp,
      '127.0.0.1',
    );
    assert.equal(
      details.HostConfig.PortBindings['5432/tcp'][0].HostPort,
      String(port),
    );
    const publishedPort = await waitForPublishedPort(
      containerId,
      tempRoot,
      30_000,
      guard,
    );
    assert.equal(
      publishedPort,
      port,
      'published PostgreSQL port must match the reserved loopback port',
    );
    assert.ok(Number.isInteger(port) && port > 0);
    const network = JSON.parse(
      docker(['network', 'inspect', name], { home: tempRoot, guard }),
    )[0];
    assert.equal(network.Id, networkId);
    assert.equal(
      network.Internal,
      false,
      'each run uses its own dedicated Docker network',
    );
    assert.equal(network.Labels?.[OWNER_LABEL], OWNER_VALUE);
    assert.equal(network.Labels?.[RUN_LABEL], runId);
    assert.deepEqual(Object.keys(network.Containers ?? {}), [containerId]);
    const proof = {
      owner: OWNER_VALUE,
      runId,
      containerId,
      networkId,
      networkName: name,
      image: IMAGE,
      imageId,
      networkIsolated: true,
      networkMembers: 1,
      publishedHost: '127.0.0.1',
      publishedPort: port,
      database,
      user,
      auth: 'isolated-trust',
      baselinePatient: crypto.randomUUID(),
      baselineOdontogram: crypto.randomUUID(),
      baselineTime: '2026-01-02T03:04:05.678Z',
      baselineJson: JSON.stringify({
        synthetic: ['baseline', null, 7],
        intact: true,
      }),
    };
    assertProof(proof);
    fs.writeFileSync(proofFile, JSON.stringify(proof), {
      mode: 0o600,
      flag: 'wx',
    });
    waitForServerInsideContainer(
      containerId,
      user,
      database,
      tempRoot,
      30_000,
      guard,
    );
    await waitForPostgres(port, 30_000, guard);
    serverVersion = docker(
      [
        'exec',
        containerId,
        'psql',
        '-At',
        '-U',
        user,
        '-d',
        database,
        '-c',
        'SHOW server_version',
      ],
      { home: tempRoot, guard },
    );
    assert.match(
      serverVersion,
      /^15\./,
      'the actual server major version must be PostgreSQL 15',
    );

    const isolatedEnv = subprocessEnvironment({
      path: process.env.PATH,
      home: tempRoot,
      databaseUrl: `${url}${port}/${database}?schema=public`,
      runId,
      proofFile,
    });
    const schema = copyMigrationStage(apiRoot, tempRoot, false);
    const isolatedClientPath = prepareIsolatedClient(schema, tempRoot);
    isolatedEnv.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT = isolatedClientPath;
    const prismaCli = path.join(
      apiRoot,
      'node_modules',
      'prisma',
      'build',
      'index.js',
    );
    const migrate = () =>
      run(
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--schema', schema],
        { cwd: tempRoot, env: isolatedEnv, guard },
      );
    run(process.execPath, [prismaCli, 'generate', '--schema', schema], {
      cwd: tempRoot,
      env: isolatedEnv,
      timeout: timeoutFor('prisma'),
      guard,
    });
    migrate();
    const psql = (sql) =>
      docker(
        [
          'exec',
          containerId,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          user,
          '-d',
          database,
          '-c',
          sql,
        ],
        { home: tempRoot, guard },
      );
    psql(
      `INSERT INTO "Patient" ("id","rut","firstName","lastName","dateOfBirth","updatedAt") VALUES ('${proof.baselinePatient}','synthetic-${proof.baselinePatient}','Synthetic','Verification','1990-01-01 00:00:00','2026-01-02 03:04:05.678')`,
    );
    psql(
      `INSERT INTO "Odontogram" ("id","patientId","teethStates","updatedAt") VALUES ('${proof.baselineOdontogram}','${proof.baselinePatient}','${proof.baselineJson}'::jsonb,'2026-01-02 03:04:05.678')`,
    );
    copyMigrationStage(apiRoot, tempRoot, true);
    migrate();

    const jestPackage = path.dirname(
      path.dirname(require.resolve('jest', { paths: [apiRoot] })),
    );
    const jestCli = path.join(jestPackage, 'bin', 'jest.js');
    const jestReport = path.join(tempRoot, 'jest-results.json');
    run(
      process.execPath,
      [
        jestCli,
        '--runInBand',
        '--runTestsByPath',
        'src/modules/odontogram/odontogram.live.spec.ts',
        '--json',
        '--outputFile',
        jestReport,
      ],
      { cwd: apiRoot, env: isolatedEnv, timeout: timeoutFor('jest'), guard },
    );
    const testSummary = JSON.parse(fs.readFileSync(jestReport, 'utf8'));
    assert.equal(
      testSummary.numPassedTests,
      4,
      'all four PostgreSQL regression scenarios must pass',
    );
    assert.equal(testSummary.numFailedTests, 0);
    assert.equal(testSummary.numPendingTests, 0);
    console.log(
      `JEST_TESTS passed=${testSummary.numPassedTests} failed=${testSummary.numFailedTests} pending=${testSummary.numPendingTests}`,
    );
    passed = true;
  } catch (error) {
    console.error(`PG15_SUITE_FAILED ${error.message}`);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = error;
      console.error(`CLEANUP_FAILED ${error.message}`);
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (cancellation.exitCode) process.exitCode = cancellation.exitCode;
    if (cleanupFailure) process.exitCode = 1;
    if (passed && !cleanupFailure && !cancellation.exitCode) {
      console.log(
        `PG15_SUITE_PASSED server=${serverVersion} image=${IMAGE} image_id=${imageId} container_id=${containerId} network_id=${networkId} port=127.0.0.1:${port} auth=isolated-trust network=dedicated storage=tmpfs`,
      );
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`PG15_SUITE_FAILED ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createCancellation,
  createPossiblyOwned,
  dockerArgs,
  ownedContainerId,
  reconcileOwnedResources,
  subprocessEnvironment,
  timeoutFor,
  validateIsolatedClient,
};
