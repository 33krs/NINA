const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  dockerArgs,
  ownedContainerId,
  reconcileOwnedResources,
  createCancellation,
  createPossiblyOwned,
  timeoutFor,
  run,
  validateIsolatedClient,
  subprocessEnvironment,
} = require('./verify-odontogram-postgres.cjs');

function fakeDockerSource(root, blockedPhase) {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(4);
const file = (name) => path.join(root, name);
fs.appendFileSync(file('calls'), JSON.stringify(process.argv.slice(2)) + '\\n');
const labels = () => Object.fromEntries(args.flatMap((arg, i) =>
  arg === '--label' ? [args[i + 1].split('=')] : []));
const block = () => {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(file('active'), JSON.stringify({ pid: process.pid, home: process.env.HOME }));
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
  fs.writeFileSync(file('container'), JSON.stringify({
    Id: 'owned-container', Name: '/' + args[args.indexOf('--name') + 1],
    Config: { Image: 'postgres:15-alpine', Labels: labels() }
  }));
  if (${JSON.stringify(blockedPhase)} === 'create') block();
  else console.log('owned-container');
} else if (args[0] === 'start') block();
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
  fs.unlinkSync(file(kind));
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

for (const [signal, phase, exitCode] of [
  ['SIGINT', 'start', 130],
  ['SIGTERM', 'create', 143],
]) {
  test(`real ${signal} interrupts an active ${phase} child and cleans only owned resources`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-signal-test-'));
    const fakeDocker = path.join(root, 'docker');
    fs.writeFileSync(fakeDocker, fakeDockerSource(root, phase), {
      mode: 0o700,
    });
    fs.writeFileSync(path.join(root, 'foreign-container'), 'untouched');
    fs.writeFileSync(path.join(root, 'foreign-network'), 'untouched');
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'verify-odontogram-postgres.cjs')],
      {
        env: { PATH: root, HOME: root },
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
    try {
      await waitUntil(() => {
        if (launchError) throw launchError;
        assert.equal(
          result,
          undefined,
          `runner exited before active child: ${output}`,
        );
        return fs.existsSync(path.join(root, 'active'));
      }, 'child command did not become active');
      active = JSON.parse(fs.readFileSync(path.join(root, 'active'), 'utf8'));
      const requestedAt = Date.now();
      assert.equal(child.kill(signal), true);
      await waitUntil(
        () => result,
        'runner did not promptly cancel the active child',
      );
      assert.ok(Date.now() - requestedAt < 2500);
      assert.deepEqual(result, { code: exitCode, signal: null });
      assert.throws(() => process.kill(active.pid, 0), { code: 'ESRCH' });
      assert.match(
        output,
        /PG15_SUITE_FAILED PostgreSQL verification cancelled by signal/,
      );
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
      assert.ok(
        commands
          .slice(activeIndex + 1)
          .every(
            (args) =>
              args[0] === 'inspect' ||
              args[0] === 'rm' ||
              args[0] === 'network',
          ),
      );
      assert.deepEqual(
        commands.filter((args) => args[0] === 'rm' || args[1] === 'rm'),
        [
          ['rm', '--force', 'owned-container'],
          ['network', 'rm', 'owned-network'],
        ],
      );
    } finally {
      if (!result) child.kill('SIGKILL');
      if (active && !result) {
        try {
          process.kill(active.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await closed;
      if (active) fs.rmSync(active.home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
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
