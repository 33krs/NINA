const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  const controller = new AbortController();
  return {
    request(signal) {
      if (exitCode) return;
      exitCode = signal === 'SIGINT' ? 130 : 143;
      controller.abort();
    },
    signal: controller.signal,
    get exitCode() {
      return exitCode;
    },
    throwIfCancelled() {
      if (exitCode)
        throw new Error('PostgreSQL verification cancelled by signal');
    },
  };
}

async function createPossiblyOwned(state, uncertainKey, create) {
  state[uncertainKey] = true;
  const id = await create();
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
    PRISMA_GENERATE_SKIP_AUTOINSTALL: '1',
    CHECKPOINT_DISABLE: '1',
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

async function reconcileOwnedResources({
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
    const inspected = await inspectOptional(() => docker(['inspect', name]));
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
    const inspected = JSON.parse(await docker(['inspect', safeContainerId]))[0];
    ownedContainerId(inspected, safeContainerId, runId);
    await docker(['rm', '--force', safeContainerId]);
    await assertMissing(
      () => docker(['inspect', safeContainerId]),
      'owned container must be removed',
    );
  }

  if (networkCreateUncertain && !safeNetworkId) {
    const inspected = await inspectOptional(() =>
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
      await docker(['network', 'inspect', safeNetworkId]),
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
    await docker(['network', 'rm', safeNetworkId]);
    await assertMissing(
      () => docker(['network', 'inspect', safeNetworkId]),
      'owned network must be removed',
    );
  }
  return { containerId: safeContainerId, networkId: safeNetworkId };
}

async function inspectOptional(inspect) {
  try {
    return JSON.parse(await inspect())[0];
  } catch (error) {
    if (
      error.status === 1 &&
      /No such object|not found/i.test(error.stderr || '')
    )
      return undefined;
    throw error;
  }
}

async function assertMissing(inspect, message) {
  assert.equal(await inspectOptional(inspect), undefined, message);
}

function parseSuite(args) {
  if (args.length === 0) return 'odontogram';
  if (args.length === 1 && args[0] === '--suite=pharmacy-ledger')
    return 'pharmacy-ledger';
  if (args.length === 1 && args[0] === '--suite=pharmacy-dispensing')
    return 'pharmacy-dispensing';
  throw new Error(
    'Unsupported arguments: use no arguments, --suite=pharmacy-ledger or --suite=pharmacy-dispensing',
  );
}

function writePostgresEnvironment(root, database, user, password) {
  const file = path.join(root, 'postgres.env');
  fs.writeFileSync(
    file,
    [
      `POSTGRES_DB=${database}`,
      `POSTGRES_USER=${user}`,
      `POSTGRES_PASSWORD=${password}`,
      'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
      'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      `PGPASSWORD=${password}`,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  return file;
}

function redact(value, secrets = []) {
  return secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce(
      (text, secret) => text.split(secret).join('[REDACTED]'),
      String(value),
    );
}

async function run(command, args, options = {}) {
  const stage = options.stage;
  if (
    stage !== undefined &&
    !['prisma-generate', 'migrate-predecessors', 'migrate-history'].includes(
      stage,
    )
  )
    throw new Error('Unknown diagnostic stage');
  options.guard?.();
  options.signal?.throwIfAborted();
  const timeout =
    options.timeout ??
    timeoutFor(path.basename(command) === 'docker' ? 'docker' : 'prisma');
  assert.ok(
    Number.isInteger(timeout) && timeout > 0,
    'subprocess timeout must be finite and positive',
  );
  if (stage) console.log(`PG15_STAGE_STARTED ${stage}`);
  const result = await new Promise((resolve) => {
    // A dedicated process group lets cancellation stop only this command's descendants.
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure;
    let killTimer;
    const kill = (signal) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== 'ESRCH') failure ??= error;
      }
    };
    const stop = (error) => {
      if (killTimer) return;
      failure ??= error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
    };
    const abort = () =>
      stop(new Error('PostgreSQL verification cancelled by signal'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          Object.assign(
            new Error(`${path.basename(command)} timed out after ${timeout}ms`),
            { code: 'ETIMEDOUT', killed: true },
          ),
        ),
      timeout,
    );
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        sizes[stream] += chunk.length;
        if (sizes[stream] > 8 * 1024 * 1024) {
          stop(
            Object.assign(
              new Error(`${stream} exceeded subprocess maxBuffer`),
              {
                code: 'ENOBUFS',
                killed: true,
              },
            ),
          );
        } else output[stream].push(chunk);
      });
    }
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (killTimer) kill('SIGKILL');
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        status,
        signal,
        error: failure,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'),
      });
    });
    if (options.signal?.aborted) abort();
  });
  options.guard?.();
  result.stderr = redact(result.stderr || '', options.redactions);
  if (result.error || result.status !== 0) {
    // Never forward raw spawn errors: their message/path/spawnargs may contain secrets.
    const error = new Error(
      redact(
        result.error?.message ??
          `${path.basename(command)} exited ${result.status}: ${result.stderr.trim()}`,
        options.redactions,
      ),
    );
    error.code = result.error?.code;
    error.killed = result.error?.killed;
    error.status = result.status;
    error.stderr = result.stderr;
    if (stage) {
      error.stage = stage;
      console.log(`PG15_STAGE_FAILED ${stage}`);
    }
    throw error;
  }
  options.guard?.();
  if (stage) console.log(`PG15_STAGE_PASSED ${stage}`);
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

async function waitForServerInsideContainer(
  containerId,
  user,
  database,
  home,
  timeoutMs = 30_000,
  guard,
  signal,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    guard?.();
    try {
      await run(
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
        {
          env: { PATH: process.env.PATH, HOME: home },
          timeout: 5_000,
          guard,
          signal,
        },
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
    const details = JSON.parse(
      await docker(['inspect', containerId], { home, guard, signal }),
    )[0];
    if (details.State?.Status !== 'running') {
      throw new Error(
        `PostgreSQL container is ${details.State?.Status}: ${details.State?.Error || ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
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
  signal,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    guard?.();
    const details = JSON.parse(
      await docker(['inspect', containerId], { home, guard, signal }),
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
  const root = fs.realpathSync(tempRoot);
  const stats = fs.lstatSync(tempRoot);
  if (
    !stats.isDirectory() ||
    (stats.mode & 0o077) !== 0 ||
    !fs.realpathSync(schemaPath).startsWith(root + path.sep)
  )
    throw new Error('Prisma generation requires private temporary storage');
  const apiRoot = path.resolve(__dirname, '..');
  const packageFile = require.resolve('@prisma/client/package.json', {
    paths: [apiRoot],
  });
  const installed = fs.realpathSync(path.dirname(packageFile));
  const localRoots = [
    path.join(apiRoot, 'node_modules'),
    path.resolve(apiRoot, '../../node_modules'),
  ];
  if (
    !localRoots.some(
      (local) =>
        path.dirname(packageFile).startsWith(local + path.sep) &&
        installed.startsWith(local + path.sep),
    ) ||
    JSON.parse(fs.readFileSync(packageFile, 'utf8')).name !== '@prisma/client'
  )
    throw new Error(
      'Prisma client must resolve from installed local dependencies',
    );
  // The copied schema cannot resolve project packages from its temporary ancestry.
  // Link only this installed package; never let generation auto-install dependencies.
  const modules = path.join(root, 'node_modules');
  fs.mkdirSync(modules, { mode: 0o700 });
  fs.mkdirSync(path.join(modules, '@prisma'), { mode: 0o700 });
  fs.symlinkSync(installed, path.join(modules, '@prisma', 'client'), 'dir');
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

function copyMigrationStage(
  apiRoot,
  tempRoot,
  includeHistory,
  suite = 'odontogram',
) {
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
    const omitted =
      suite !== 'odontogram'
        ? '20261010140000_add_prescription_dispensing'
        : '20261010130000_add_odontogram_history';
    if (!includeHistory && name === omitted) continue;
    fs.cpSync(
      path.join(source, 'migrations', name),
      path.join(target, 'migrations', name),
      { recursive: true },
    );
  }
  return path.join(target, 'schema.prisma');
}

function proofAuth(suite) {
  return suite !== 'odontogram' ? 'isolated-scram' : 'isolated-trust';
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
  const suite = parseSuite(process.argv.slice(2));
  const dispensing = suite === 'pharmacy-dispensing';
  const pharmacy = suite !== 'odontogram';
  const apiRoot = path.resolve(__dirname, '..');
  const runId = crypto.randomUUID();
  const name = `nina-odontogram-pg15-${runId.slice(0, 12)}`;
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nina-odontogram-pg15-'),
  );
  const proofFile = path.join(tempRoot, 'container-proof.json');
  const database = `nina_${runId.replaceAll('-', '').slice(0, 16)}`;
  const user = `nina_${runId.replaceAll('-', '').slice(16, 28)}`;
  const password = pharmacy ? crypto.randomBytes(32).toString('hex') : '';
  const redactions = [password];
  const url = `postgresql://${user}${pharmacy ? ':' + password : ''}@127.0.0.1:`;
  const authArgs = pharmacy
    ? ['--env-file', path.join(tempRoot, 'postgres.env')]
    : [
        '--env',
        `POSTGRES_DB=${database}`,
        '--env',
        `POSTGRES_USER=${user}`,
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
      ];
  const psqlAuth = pharmacy ? ['-h', '127.0.0.1'] : [];
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
  const commandOptions = {
    home: tempRoot,
    guard,
    signal: cancellation.signal,
    redactions,
  };
  let passed = false;

  const cleanup = async () => {
    let outcome = { containerId, networkId };
    try {
      outcome = await reconcileOwnedResources({
        docker: (args) => docker(args, { home: tempRoot, redactions }),
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
      console.error(`CLEANUP_FAILED ${redact(error.message, redactions)}`);
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
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  try {
    if (pharmacy) writePostgresEnvironment(tempRoot, database, user, password);
    imageId = await docker(
      ['image', 'inspect', '--format', '{{.Id}}', IMAGE],
      commandOptions,
    );
    assert.ok(
      imageId,
      'required PostgreSQL image must already exist; pulls are disabled',
    );
    guard();
    port = await freePort();
    guard();
    networkId = await createPossiblyOwned(
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
          commandOptions,
        ),
    );
    containerId = await createPossiblyOwned(
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
            ...authArgs,
            '--label',
            `${OWNER_LABEL}=${OWNER_VALUE}`,
            '--label',
            `${RUN_LABEL}=${runId}`,
            IMAGE,
          ],
          commandOptions,
        ),
    );
    await docker(['start', containerId], commandOptions);

    const details = JSON.parse(
      await docker(['inspect', containerId], commandOptions),
    )[0];
    assert.equal(details.Id, containerId);
    if (pharmacy) {
      for (const entry of [
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
        `POSTGRES_PASSWORD=${password}`,
      ]) {
        if (!details.Config.Env?.includes(entry))
          throw new Error('Owned SCRAM authentication configuration mismatch');
      }
    }
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
      cancellation.signal,
    );
    assert.equal(
      publishedPort,
      port,
      'published PostgreSQL port must match the reserved loopback port',
    );
    assert.ok(Number.isInteger(port) && port > 0);
    const network = JSON.parse(
      await docker(['network', 'inspect', name], commandOptions),
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
      suite,
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
      auth: pharmacy ? 'isolated-scram' : 'isolated-trust',
      baselinePatient: crypto.randomUUID(),
      baselineOdontogram: crypto.randomUUID(),
      baselineTime: '2026-01-02T03:04:05.678Z',
      baselineJson: JSON.stringify({
        synthetic: ['baseline', null, 7],
        intact: true,
      }),
    };
    if (!pharmacy) assertProof(proof);
    fs.writeFileSync(proofFile, JSON.stringify(proof), {
      mode: 0o600,
      flag: 'wx',
    });
    await waitForServerInsideContainer(
      containerId,
      user,
      database,
      tempRoot,
      30_000,
      guard,
      cancellation.signal,
    );
    await waitForPostgres(port, 30_000, guard);
    serverVersion = await docker(
      [
        'exec',
        containerId,
        'psql',
        ...psqlAuth,
        '-At',
        '-U',
        user,
        '-d',
        database,
        '-c',
        'SHOW server_version',
      ],
      commandOptions,
    );
    assert.match(
      serverVersion,
      /^15\./,
      'the actual server major version must be PostgreSQL 15',
    );

    const databaseUrl = `${url}${port}/${database}?schema=public`;
    redactions.push(databaseUrl);
    const isolatedEnv = subprocessEnvironment({
      path: process.env.PATH,
      home: tempRoot,
      databaseUrl,
      runId,
      proofFile,
    });
    const schema = copyMigrationStage(apiRoot, tempRoot, false, suite);
    if (!pharmacy || dispensing)
      isolatedEnv.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT = prepareIsolatedClient(
        schema,
        tempRoot,
      );
    const prismaCli = path.join(
      apiRoot,
      'node_modules',
      'prisma',
      'build',
      'index.js',
    );
    const migrate = (stage) =>
      run(
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--schema', schema],
        {
          cwd: tempRoot,
          env: isolatedEnv,
          guard,
          signal: cancellation.signal,
          redactions,
          stage,
        },
      );
    if (!pharmacy || dispensing)
      await run(process.execPath, [prismaCli, 'generate', '--schema', schema], {
        cwd: tempRoot,
        env: isolatedEnv,
        timeout: timeoutFor('prisma'),
        stage: 'prisma-generate',
        guard,
        signal: cancellation.signal,
        redactions,
      });
    await migrate('migrate-predecessors');
    const psql = (sql) =>
      docker(
        [
          'exec',
          containerId,
          'psql',
          ...psqlAuth,
          '-At',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          user,
          '-d',
          database,
          '-c',
          sql,
        ],
        commandOptions,
      );
    if (pharmacy) {
      assert.equal(
        await psql(
          "SELECT bool_and(auth_method = 'scram-sha-256') FROM pg_hba_file_rules WHERE type = 'host'",
        ),
        't',
        'all host authentication rules must use SCRAM',
      );
      if (dispensing) {
        copyMigrationStage(apiRoot, tempRoot, true, suite);
        await migrate('migrate-history');
        const output = await run(
          process.execPath,
          [path.join(__dirname, 'verify-pharmacy-dispensing.cjs')],
          {
            ...commandOptions,
            cwd: tempRoot,
            env: { ...isolatedEnv, NINA_PHARMACY_DISPENSING_PG15: '1' },
            timeout: timeoutFor('jest'),
          },
        );
        assert.equal(
          output,
          'PHARMACY_SERVICE_BASELINE_PASSED deliveries=3 expiry_rejections=1',
        );
        console.log(output);
        passed = true;
        return;
      }
      const {
        seedLegacy,
        verifyLedger,
      } = require('./verify-pharmacy-ledger.cjs');
      const snapshot = await seedLegacy(psql);
      copyMigrationStage(apiRoot, tempRoot, true, suite);
      await migrate();
      await verifyLedger(psql, snapshot);
      passed = true;
      return;
    }
    await psql(
      `INSERT INTO "Patient" ("id","rut","firstName","lastName","dateOfBirth","updatedAt") VALUES ('${proof.baselinePatient}','synthetic-${proof.baselinePatient}','Synthetic','Verification','1990-01-01 00:00:00','2026-01-02 03:04:05.678')`,
    );
    await psql(
      `INSERT INTO "Odontogram" ("id","patientId","teethStates","updatedAt") VALUES ('${proof.baselineOdontogram}','${proof.baselinePatient}','${proof.baselineJson}'::jsonb,'2026-01-02 03:04:05.678')`,
    );
    copyMigrationStage(apiRoot, tempRoot, true);
    await migrate('migrate-history');

    const jestPackage = path.dirname(
      path.dirname(require.resolve('jest', { paths: [apiRoot] })),
    );
    const jestCli = path.join(jestPackage, 'bin', 'jest.js');
    const jestReport = path.join(tempRoot, 'jest-results.json');
    await run(
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
      {
        cwd: apiRoot,
        env: isolatedEnv,
        timeout: timeoutFor('jest'),
        guard,
        signal: cancellation.signal,
      },
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
    console.error(`PG15_SUITE_FAILED ${redact(error.message, redactions)}`);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = error;
      console.error(`CLEANUP_FAILED ${redact(error.message, redactions)}`);
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (cancellation.exitCode) process.exitCode = cancellation.exitCode;
    if (cleanupFailure) process.exitCode = 1;
    if (passed && !cleanupFailure && !cancellation.exitCode) {
      console.log(
        `PG15_SUITE_PASSED server=${serverVersion} image=${IMAGE} image_id=${imageId} container_id=${containerId} network_id=${networkId} port=127.0.0.1:${port} auth=${proofAuth(suite)} network=dedicated storage=tmpfs`,
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
  prepareIsolatedClient,
  parseSuite,
  writePostgresEnvironment,
  copyMigrationStage,
  createCancellation,
  createPossiblyOwned,
  dockerArgs,
  ownedContainerId,
  reconcileOwnedResources,
  run,
  subprocessEnvironment,
  timeoutFor,
  validateIsolatedClient,
};
