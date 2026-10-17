const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  dockerArgs,
  parseSuite,
  writePostgresEnvironment,
  copyMigrationStage,
  ownedContainerId,
  reconcileOwnedResources,
  createCancellation,
  createPossiblyOwned,
  timeoutFor,
  run,
  validateIsolatedClient,
  subprocessEnvironment,
} = require('./verify-odontogram-postgres.cjs');

function fakeDockerSource(root, blockedPhase, options = {}) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = ${JSON.stringify(root)};
const options = ${JSON.stringify(options)};
const args = process.argv.slice(4);
const file = (name) => path.join(root, name);
fs.appendFileSync(file('calls'), JSON.stringify(process.argv.slice(2)) + '\\n');
const labels = () => Object.fromEntries(args.flatMap((arg, i) =>
  arg === '--label' ? [args[i + 1].split('=')] : []));
const block = () => {
  process.on('SIGTERM', () => {});
  const ready = (descendantPid) => fs.writeFileSync(file('active'), JSON.stringify({
    pid: process.pid, home: process.env.HOME, descendantPid
  }));
  if (options.descendant) {
    // Inherit the owned command's process group; do not detach the descendant.
    const descendant = spawn(process.execPath, ['-e',
      'setInterval(() => {}, 1000); process.send("ready");'
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    fs.writeFileSync(file('command-started'), JSON.stringify({
      pid: process.pid, home: process.env.HOME, descendantPid: descendant.pid
    }));
    descendant.once('message', () => ready(descendant.pid));
    descendant.once('exit', (code, signal) =>
      fs.writeFileSync(file('descendant-exit'), JSON.stringify({ code, signal })));
  } else ready();
  setTimeout(() => {
    fs.writeFileSync(file('continued'), 'unexpected later phase');
    process.exit(0);
  }, 10000);
};
if (args[0] === 'image') console.log('sha256:local-test-image');
else if (args[0] === 'network' && args[1] === 'create') {
  fs.writeFileSync(file('network'), JSON.stringify({
    Id: 'owned-network', Name: args.at(-1), Labels: labels()
  }));
  console.log('owned-network');
} else if (args[0] === 'create') {
  if (options.suite) {
    const envFile = args[args.indexOf('--env-file') + 1];
    if (!envFile || (fs.statSync(envFile).mode & 0o777) !== 0o600) throw new Error('credentials are not private');
    const env = fs.readFileSync(envFile, 'utf8');
    const secret = env.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
    if (!secret || args.some(arg => arg.includes(secret) || arg.includes('trust')) ||
      !env.includes('POSTGRES_HOST_AUTH_METHOD=scram-sha-256')) throw new Error('unsafe credential delivery');
    if (process.env.DATABASE_URL || process.env.PGHOST || process.env.SSH_AUTH_SOCK) throw new Error('ambient credentials escaped allowlist');
  }
  fs.writeFileSync(file('container'), JSON.stringify({
    Id: 'owned-container', Name: '/' + args[args.indexOf('--name') + 1],
    Config: { Image: 'postgres:15-alpine', Labels: labels() }
  }));
  if (${JSON.stringify(blockedPhase)} === 'create') block();
  else console.log('owned-container');
} else if (args[0] === 'start') {
  if (options.cleanup) {
    console.error('expected start failure');
    process.exitCode = 7;
  } else block();
}
else if (args[0] === 'inspect' || (args[0] === 'network' && args[1] === 'inspect')) {
  const kind = args[0] === 'inspect' ? 'container' : 'network';
  const target = args.at(-1);
  if (!fs.existsSync(file(kind))) {
    console.error('No such object');
    process.exitCode = 1;
  } else {
    const resource = JSON.parse(fs.readFileSync(file(kind), 'utf8'));
    if (target !== resource.Id && target !== resource.Name.replace(/^\\//, '')) {
      throw new Error('unexpected inspection target');
    }
    console.log(JSON.stringify([resource]));
  }
} else if (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')) {
  const kind = args[0] === 'rm' ? 'container' : 'network';
  const resource = JSON.parse(fs.readFileSync(file(kind), 'utf8'));
  if (args.at(-1) !== resource.Id) throw new Error('unexpected removal target');
  if (kind === 'container' && options.cleanup) {
    fs.writeFileSync(file('cleanup-active'), JSON.stringify({ pid: process.pid, home: process.env.HOME }));
    const timer = setInterval(() => {
      if (!fs.existsSync(file('release-cleanup'))) return;
      clearInterval(timer);
      fs.unlinkSync(file(kind));
    }, 10);
  } else fs.unlinkSync(file(kind));
} else throw new Error('unexpected later phase: ' + args.join(' '));
`;
}

async function waitUntil(predicate, message, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const [signal, phase, exitCode, options = {}] of [
  ['SIGINT', 'start', 130],
  ['SIGTERM', 'create', 143],
  ['SIGINT', 'start', 130, { descendant: true }],
  ['SIGTERM', 'start', 143, { descendant: true }],
  ['SIGINT', 'start', 130, { cleanup: true }],
  ['SIGTERM', 'start', 143, { cleanup: true }],
  ['SIGINT', 'create', 130, { suite: 'pharmacy-ledger' }],
  ['SIGTERM', 'start', 143, { suite: 'pharmacy-ledger' }],
]) {
  const scenario = options.cleanup
    ? 'during cleanup preserves resource removal'
    : options.descendant
      ? 'terminates an owned command and its descendant'
      : `interrupts an active ${phase} child`;
  test(`real ${signal} ${scenario} and cleans only owned resources`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-signal-test-'));
    const fakeDocker = path.join(root, 'docker');
    fs.writeFileSync(fakeDocker, fakeDockerSource(root, phase, options), {
      mode: 0o700,
    });
    fs.writeFileSync(path.join(root, 'foreign-container'), 'untouched');
    fs.writeFileSync(path.join(root, 'foreign-network'), 'untouched');
    const observer = path.join(root, 'signal-observer.cjs');
    if (options.cleanup) {
      // Observe delivery after all signal listeners ran; never drive cancellation.
      fs.writeFileSync(
        observer,
        `process.once(${JSON.stringify(signal)}, () => setImmediate(() => {
          require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'signal-received'))}, 'received');
        }));`,
      );
    }
    const child = spawn(
      process.execPath,
      [
        ...(options.cleanup ? ['--require', observer] : []),
        path.join(__dirname, 'verify-odontogram-postgres.cjs'),
        ...(options.suite ? [`--suite=${options.suite}`] : []),
      ],
      {
        env: {
          PATH: root,
          HOME: root,
          DATABASE_URL: 'postgresql://ambient.invalid/database',
          PGHOST: 'ambient.invalid',
          SSH_AUTH_SOCK: '/ambient/socket',
        },
      },
    );
    let result;
    let launchError;
    let output = '';
    child.on('error', (error) => {
      launchError = error;
    });
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const closed = new Promise((resolve) =>
      child.once('close', (code, receivedSignal) => {
        result = { code, signal: receivedSignal };
        resolve();
      }),
    );
    let active;
    const activeFile = path.join(
      root,
      options.cleanup ? 'cleanup-active' : 'active',
    );
    try {
      await waitUntil(() => {
        if (launchError) throw launchError;
        assert.equal(
          result,
          undefined,
          `runner exited before active child: ${output}`,
        );
        return fs.existsSync(activeFile);
      }, 'child command did not become active');
      active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      if (options.descendant) {
        assert.ok(Number.isInteger(active.descendantPid));
        process.kill(active.descendantPid, 0);
      }
      const requestedAt = Date.now();
      assert.equal(child.kill(signal), true);
      if (options.cleanup) {
        await waitUntil(() => {
          assert.equal(result, undefined, `runner aborted cleanup: ${output}`);
          return fs.existsSync(path.join(root, 'signal-received'));
        }, 'runner did not receive the signal during blocked cleanup');
        process.kill(active.pid, 0);
        assert.equal(fs.existsSync(path.join(root, 'container')), true);
        assert.equal(fs.existsSync(path.join(root, 'network')), true);
        fs.writeFileSync(path.join(root, 'release-cleanup'), 'release');
      }
      await waitUntil(
        () => result,
        'runner did not promptly cancel the active child',
      );
      assert.ok(Date.now() - requestedAt < 2500);
      assert.deepEqual(result, { code: exitCode, signal: null });
      assert.throws(() => process.kill(active.pid, 0), { code: 'ESRCH' });
      if (options.descendant) {
        await waitUntil(() => {
          try {
            process.kill(active.descendantPid, 0);
            return false;
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            return true;
          }
        }, 'owned command descendant survived cancellation');
        assert.deepEqual(
          JSON.parse(
            fs.readFileSync(path.join(root, 'descendant-exit'), 'utf8'),
          ),
          { code: null, signal: 'SIGTERM' },
        );
      }
      assert.match(
        output,
        options.cleanup
          ? /PG15_SUITE_FAILED docker exited 7: expected start failure/
          : /PG15_SUITE_FAILED PostgreSQL verification cancelled by signal/,
      );
      assert.doesNotMatch(output, /CLEANUP_FAILED|PG15_SUITE_PASSED/);
      assert.match(
        output,
        /CLEANUP_ASSERTED container_id=owned-container .*network_id=owned-network/,
      );
      for (const name of ['container', 'network', 'continued']) {
        assert.equal(fs.existsSync(path.join(root, name)), false, name);
      }
      assert.equal(
        fs.existsSync(active.home),
        false,
        'runner temporary storage must be removed',
      );
      for (const name of ['foreign-container', 'foreign-network']) {
        assert.equal(
          fs.readFileSync(path.join(root, name), 'utf8'),
          'untouched',
        );
      }
      const calls = fs
        .readFileSync(path.join(root, 'calls'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(
        calls.every(
          (args) =>
            args[0] === '--host' && args[1] === 'unix:///var/run/docker.sock',
        ),
      );
      const commands = calls.map((args) => args.slice(2));
      const activeIndex = commands.findIndex((args) => args[0] === phase);
      assert.ok(activeIndex >= 0, 'expected active phase must have run');
      assert.ok(
        commands
          .slice(activeIndex + 1)
          .every(
            (args) =>
              args[0] === 'inspect' ||
              args[0] === 'rm' ||
              (args[0] === 'network' && ['inspect', 'rm'].includes(args[1])),
          ),
      );
      assert.deepEqual(
        commands.filter((args) => args[0] === 'rm' || args[1] === 'rm'),
        [
          ['rm', '--force', 'owned-container'],
          ['network', 'rm', 'owned-network'],
        ],
      );
      for (const [inspection, removal] of [
        [
          ['inspect', 'owned-container'],
          ['rm', '--force', 'owned-container'],
        ],
        [
          ['network', 'inspect', 'owned-network'],
          ['network', 'rm', 'owned-network'],
        ],
      ]) {
        const removalIndex = commands.findIndex(
          (args) => JSON.stringify(args) === JSON.stringify(removal),
        );
        assert.deepEqual(commands[removalIndex - 1], inspection);
        assert.deepEqual(commands[removalIndex + 1], inspection);
      }
    } finally {
      try {
        for (const candidate of [
          activeFile,
          path.join(root, 'command-started'),
        ]) {
          if (!active && fs.existsSync(candidate)) {
            active = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          }
        }
        if (!result) child.kill('SIGKILL');
        for (const pid of active
          ? [-active.pid, active.descendantPid].filter(Number.isInteger)
          : []) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        await waitUntil(
          () => result,
          'fixture runner did not close after teardown',
        );
        await closed;
      } finally {
        if (active) fs.rmSync(active.home, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test('async subprocesses retain stdout and nonzero status with stderr', async () => {
  assert.equal(
    await run(process.execPath, ['-e', 'console.log(" complete ")']),
    'complete',
  );
  await assert.rejects(
    run(process.execPath, [
      '-e',
      'console.error("expected failure"); process.exit(7)',
    ]),
    (error) => error.status === 7 && error.stderr.trim() === 'expected failure',
  );
});

test('async subprocesses preserve spawn errors', async () => {
  await assert.rejects(run('/nonexistent/nina-signal-test-command', []), {
    code: 'ENOENT',
  });
});

test('async subprocess timeout force-kills an uncooperative owned child', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    run(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { timeout: 500 },
    ),
    { code: 'ETIMEDOUT', killed: true },
  );
  assert.ok(Date.now() - startedAt < 2500);
});

test('async subprocess output remains bounded', async () => {
  await assert.rejects(
    run(process.execPath, [
      '-e',
      'process.stdout.write(Buffer.alloc(9 * 1024 * 1024)); setInterval(() => {}, 1000)',
    ]),
    { code: 'ENOBUFS', killed: true },
  );
});

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

test('a signal cancels the next step so the runner enters its cleanup path', async () => {
  const cancellation = createCancellation();
  const state = { containerCreateUncertain: false };
  let created = false;
  let removed = false;
  const runId = 'signal-run';
  const name = 'nina-odontogram-pg15-signal-run';
  const containerId = 'signal-owned-container';
  await assert.rejects(
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
  const result = await reconcileOwnedResources({
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

test('an uncertain create is reconciled only by unique name and exact ownership labels', async () => {
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

  const result = await reconcileOwnedResources({
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

test('uncertain create reconciliation refuses a same-name resource with foreign labels', async () => {
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
  await assert.rejects(
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

test('suite selection rejects unknown or additional arguments before resources', async () => {
  assert.equal(parseSuite([]), 'odontogram');
  assert.equal(parseSuite(['--suite=pharmacy-ledger']), 'pharmacy-ledger');
  for (const args of [
    ['--suite=other'],
    ['--suite=odontogram'],
    ['--suite=pharmacy-ledger', 'extra'],
  ]) {
    assert.throws(() => parseSuite(args), /Unsupported/);
  }
  await assert.rejects(
    run(
      process.execPath,
      [path.join(__dirname, 'verify-odontogram-postgres.cjs'), '--suite=other'],
      { env: { PATH: '/nonexistent' } },
    ),
    /Unsupported/,
  );
});

test('pharmacy credentials use a private exclusive file without password argv', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-auth-test-'));
  try {
    const file = writePostgresEnvironment(
      root,
      'db_random',
      'user_random',
      'random_secret',
    );
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      'POSTGRES_DB=db_random\nPOSTGRES_USER=user_random\nPOSTGRES_PASSWORD=random_secret\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\nPGPASSWORD=random_secret\n',
    );
    assert.throws(
      () => writePostgresEnvironment(root, 'db', 'user', 'secret'),
      { code: 'EEXIST' },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pharmacy migration stage omits only ledger then adds it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-stage-test-'));
  const apiRoot = path.resolve(__dirname, '..');
  const ledger = '20261010140000_add_prescription_dispensing';
  try {
    copyMigrationStage(apiRoot, root, false, 'pharmacy-ledger');
    const names = fs
      .readdirSync(path.join(root, 'prisma', 'migrations'))
      .sort();
    assert.deepEqual(
      names,
      fs
        .readdirSync(path.join(apiRoot, 'prisma', 'migrations'))
        .filter((name) => name !== ledger)
        .sort(),
    );
    assert.equal(fs.existsSync(path.join(root, 'prisma', '.env')), false);
    copyMigrationStage(apiRoot, root, true, 'pharmacy-ledger');
    assert.ok(
      fs.existsSync(
        path.join(root, 'prisma', 'migrations', ledger, 'migration.sql'),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all subprocess error fields redact fresh passwords and datasource URLs', async () => {
  const secret = 'fresh_secret';
  const url = `postgresql://user:${secret}@127.0.0.1:5432/random`;
  const redactions = [secret, url];
  await assert.rejects(
    run(
      process.execPath,
      [
        '-e',
        `console.error(${JSON.stringify(url + ' ' + secret)}); process.exit(7)`,
      ],
      { redactions },
    ),
    (error) => {
      assert.equal(error.status, 7);
      assert.doesNotMatch(
        error.message + error.stderr + error.stack,
        /fresh_secret|postgresql:/,
      );
      assert.match(error.stderr, /REDACTED/);
      return true;
    },
  );
  await assert.rejects(
    run(`/nonexistent/${secret}`, [], { redactions }),
    (error) => {
      assert.equal(error.code, 'ENOENT');
      assert.doesNotMatch(
        error.message + error.stderr + error.stack,
        /fresh_secret/,
      );
      return true;
    },
  );
});
