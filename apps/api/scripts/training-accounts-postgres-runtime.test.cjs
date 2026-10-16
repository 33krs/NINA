const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { it } = require('node:test');

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);
const NETWORK_ID = 'c'.repeat(64);
const RUN_ID = '98cf1a18-1b1b-4ea3-9dc3-9527a7b4d0f1';
const DOCKER_HOST = 'unix:///var/run/docker.sock';
const RUNTIME_SOURCE = path.join(
  __dirname,
  'training-accounts-postgres-runtime.cjs',
);
const actualRequire = createRequire(RUNTIME_SOURCE);
const actualRecovery = actualRequire('./verify-training-accounts-postgres.cjs');
const actualRunner = actualRequire('./verify-odontogram-postgres.cjs');

function observationFixtures() {
  const fixturePath = path.join(
    __dirname,
    'training-accounts-postgres-observations.test.cjs',
  );
  // Reuse validated observation shapes without registering the source test cases.
  const source = fs.readFileSync(fixturePath, 'utf8').split('\nit(')[0];
  const module = { exports: {} };
  vm.runInNewContext(
    `${source}\nmodule.exports = { image, containerObservation, isolationNetwork, networkObservation };`,
    {
      module,
      exports: module.exports,
      require(specifier) {
        if (specifier === 'node:test') return { after() {}, it() {} };
        return actualRequire(specifier);
      },
    },
    { filename: fixturePath, timeout: 1000 },
  );
  return module.exports;
}

function loadRuntime(harness) {
  const module = { exports: {} };
  const dependencies = new Map([
    [
      './verify-odontogram-postgres.cjs',
      { run: harness.run, dockerArgs: harness.dockerArgs },
    ],
    [
      './training-accounts-postgres-fixture.cjs',
      { prepareTrainingAccountFixture: harness.prepareFixture },
    ],
    ['./verify-training-accounts-postgres.cjs', harness.recovery],
    [
      './training-accounts-postgres-plan.cjs',
      { trainingAccountPostgresCommand: harness.plan },
    ],
    ['./training-accounts-postgres-observations.cjs', harness.observations],
    [
      './training-accounts-postgres-receipt.cjs',
      { parseTrainingAccountSqlReceipt: harness.parseReceipt },
    ],
  ]);
  const sandbox = {
    module,
    exports: module.exports,
    process: { platform: harness.platform, arch: harness.arch },
    require(specifier) {
      if (!dependencies.has(specifier))
        throw new Error('Unexpected runtime dependency');
      return dependencies.get(specifier);
    },
  };
  vm.runInNewContext(fs.readFileSync(RUNTIME_SOURCE, 'utf8'), sandbox, {
    filename: RUNTIME_SOURCE,
    timeout: 1000,
  });
  return module.exports;
}

function createHarness(options = {}) {
  const events = [];
  const calls = [];
  const fixtureSignals = [];
  const controller = new AbortController();
  const context = {
    runId: RUN_ID,
    name: `nina-training-postgres-${RUN_ID.replaceAll('-', '').slice(0, 12)}`,
    root: '/tmp/nina-postgres-runtime-test',
  };
  const fixture = Object.freeze({
    database: 'training_98cf1a181b1b4ea3',
    databaseUser: 'training_98cf1a181b1b4ea3',
    username: 'nina_98cf1a181b1b',
    artifacts: Object.freeze({
      proofSql: `${context.root}/proof.sql`,
      postgresEnv: `${context.root}/postgres.env`,
    }),
    assertions: Object.freeze([]),
    expectedRejections: Object.freeze([]),
  });
  const receipt = `NINA_TRAINING_PG_V1|${RUN_ID}|complete|proof_complete|-\n`;
  const rows = {
    network: JSON.stringify({ Id: NETWORK_ID, Name: context.name }),
    container: JSON.stringify({ Id: CONTAINER_ID, State: 'created' }),
    running: JSON.stringify({ Id: CONTAINER_ID, State: 'running' }),
  };
  let started = false;
  let fixtureRelease;
  let delayedRunRelease;

  function actionOf(args) {
    return (
      [
        'inspect_image',
        'create_network',
        'inspect_network',
        'create_container',
        'inspect_container',
        'start_container',
        'wait_ready',
        'server_version',
        'run_assertions',
      ].find((operation) => args.includes(operation)) ?? 'cleanup'
    );
  }

  async function run(command, args, runOptions) {
    const action = actionOf(args);
    calls.push({ command, args: [...args], options: runOptions, action });
    events.push(`run:${action}:start`);
    if (options.failAt === action) {
      events.push(`run:${action}:end`);
      throw Object.assign(new Error('synthetic private password-marker'), {
        status: 7,
        stderr: 'synthetic credential-marker',
      });
    }
    if (options.delayAction === action) {
      await new Promise((resolve) => {
        delayedRunRelease = resolve;
      });
      events.push(`run:${action}:end`);
      if (runOptions.signal?.aborted)
        throw new Error('safe synthetic child settlement');
    }
    events.push(`run:${action}:end`);
    switch (action) {
      case 'inspect_image':
        return (
          options.imageJson ??
          JSON.stringify({
            Id: IMAGE_ID,
            RepoTags: ['postgres:15-alpine'],
            Os: 'linux',
            Architecture: 'amd64',
            Config: {
              Entrypoint: ['docker-entrypoint.sh'],
              Cmd: ['postgres'],
              User: '',
              Env: ['PG_MAJOR=15', 'PG_VERSION=15.8'],
            },
          })
        );
      case 'create_network':
        return `${NETWORK_ID}\n`;
      case 'inspect_network':
        return rows.network;
      case 'create_container':
        return `${CONTAINER_ID}\n`;
      case 'inspect_container':
        return started ? rows.running : rows.container;
      case 'start_container':
        started = true;
        return `${CONTAINER_ID}\n`;
      case 'wait_ready':
        return '';
      case 'server_version':
        return options.serverVersion ?? '150008\n';
      case 'run_assertions':
        return options.stdout ?? receipt;
      case 'cleanup':
        return '["synthetic cleanup observation"]';
      default:
        throw new Error('Unexpected synthetic operation');
    }
  }

  const recovery = {
    createRecoveryContext() {
      events.push('context:create');
      return context;
    },
    bindImageIdentity(_context, imageId) {
      events.push('image:bind');
      assert.equal(imageId, IMAGE_ID);
    },
    captureCreation(_context, kind, create, { signal }) {
      events.push(`capture:${kind}:start`);
      return create({ signal }).then((id) => {
        events.push(`capture:${kind}:end`);
        return id;
      });
    },
    reportFailure(_context, stage, _error) {
      events.push(`failure:${stage}`);
      return Object.freeze({ stage, reason: 'operation_failed' });
    },
    async finalizeRecovery(_context, { execute, proofSucceeded }) {
      events.push('finalize:start');
      const cleanup = await execute(['inspect', CONTAINER_ID], {
        timeout: 5000,
        signal: undefined,
      });
      assert.equal(typeof cleanup, 'string');
      events.push('finalize:end');
      const cleanupConfirmed = options.cleanupConfirmed !== false;
      return Object.freeze({
        passed: proofSucceeded === true && cleanupConfirmed,
        proofSucceeded: proofSucceeded === true,
        cleanupConfirmed,
        recoveryRetained: proofSucceeded !== true || !cleanupConfirmed,
        diagnostics: Object.freeze([]),
      });
    },
  };

  const harness = {
    events,
    calls,
    fixtureSignals,
    controller,
    context,
    fixture,
    receipt,
    get delayedRunRelease() {
      return delayedRunRelease;
    },
    get fixtureRelease() {
      return fixtureRelease;
    },
    arch: options.arch ?? 'x64',
    platform: options.platform ?? 'linux',
    run,
    dockerArgs(args) {
      return ['--host', DOCKER_HOST, ...args];
    },
    async prepareFixture(_context, fixtureOptions) {
      events.push('fixture:start');
      fixtureSignals.push(fixtureOptions.signal);
      if (options.failAt === 'fixture') {
        events.push('fixture:end');
        throw new Error('synthetic fixture secret-marker');
      }
      if (options.delayFixture) {
        await new Promise((resolve) => {
          fixtureRelease = resolve;
        });
      }
      events.push('fixture:end');
      return fixture;
    },
    plan(_context, _fixture, operation) {
      events.push(`plan:${operation}`);
      if (options.failAt === `plan:${operation}`)
        throw new Error('synthetic plan private details');
      return Object.freeze(['--host', DOCKER_HOST, operation]);
    },
    observations: {
      validateTrainingPostgresImage(_json, architecture) {
        events.push('validate:image');
        assert.equal(architecture, 'amd64');
        return Object.freeze({ imageId: IMAGE_ID, architecture: 'amd64' });
      },
      validateTrainingPostgresNetwork(_context, _json, phase) {
        events.push(`validate:network:${phase}`);
        return Object.freeze({ phase });
      },
      validateTrainingPostgresIsolation(_context, _container, _network, phase) {
        events.push(`validate:isolation:${phase}`);
        return Object.freeze({ phase });
      },
    },
    parseReceipt(stdout, runId, exitStatus) {
      events.push('receipt:parse');
      assert.equal(stdout, options.stdout ?? receipt);
      assert.equal(runId, RUN_ID);
      assert.equal(exitStatus, 0);
      if (options.failAt === 'parse')
        throw new Error('synthetic receipt private details');
      if (options.abortDuringParse) controller.abort();
      return Object.freeze({ complete: true });
    },
  };
  harness.recovery = recovery;
  harness.plan = harness.plan.bind(harness);
  return harness;
}

function loadRuntimeWithRealCollaborators(transport) {
  const module = { exports: {} };
  const recoveryApi = {
    ...actualRecovery,
    createRecoveryContext(...args) {
      transport.contextCreations = (transport.contextCreations ?? 0) + 1;
      try {
        // Instrument the actual factory only to inspect its owned root afterward.
        const context = actualRecovery.createRecoveryContext(...args);
        transport.setContext(context);
        return context;
      } catch (error) {
        transport.recoveryError = error;
        throw error;
      }
    },
  };
  vm.runInNewContext(
    fs.readFileSync(RUNTIME_SOURCE, 'utf8'),
    {
      module,
      exports: module.exports,
      process,
      require(specifier) {
        if (specifier === './verify-odontogram-postgres.cjs')
          return { ...actualRunner, run: transport.run };
        if (specifier === './verify-training-accounts-postgres.cjs')
          return recoveryApi;
        return actualRequire(specifier);
      },
    },
    { filename: RUNTIME_SOURCE, timeout: 1000 },
  );
  return module.exports;
}

function createRealCollaboratorTransport({ malformedReceipt = false } = {}) {
  const { image, containerObservation, isolationNetwork, networkObservation } =
    observationFixtures();
  const calls = [];
  const networkId = 'b'.repeat(64);
  const containerId = 'c'.repeat(64);
  let context;
  let networkCreated = false;
  let containerCreated = false;
  let started = false;
  let failure = null;

  const transport = {
    calls,
    contextCreations: 0,
    get context() {
      return context;
    },
    get resourcesGone() {
      return !networkCreated && !containerCreated;
    },
    setContext(value) {
      context = value;
    },
    get failure() {
      return failure;
    },
    async run(binary, argv, options) {
      try {
        assert.equal(binary, '/usr/bin/docker');
        assert.deepEqual(argv.slice(0, 2), [
          '--host',
          'unix:///var/run/docker.sock',
        ]);
        assert.equal(
          argv.filter((token, index) => token === '--host' && index % 2 === 0)
            .length,
          1,
        );
        assert.deepEqual(JSON.parse(JSON.stringify(options.env)), {
          PATH: '/usr/bin:/bin',
          HOME: options.cwd,
          TMPDIR: options.cwd,
          LC_ALL: 'C',
        });
        assert.equal(options.cwd, context.root);

        const args = argv.slice(2);
        calls.push({ args: [...args], options });
        let stdout;
        if (args[0] === 'image' && args[1] === 'inspect') {
          stdout = JSON.stringify(image());
        } else if (args[0] === 'network' && args[1] === 'create') {
          networkCreated = true;
          stdout = `${networkId}\n`;
        } else if (args[0] === 'create') {
          containerCreated = true;
          stdout = `${containerId}\n`;
        } else if (args[0] === 'start') {
          started = true;
          stdout = `${containerId}\n`;
        } else if (args[0] === 'exec') {
          const script = args.at(-1);
          if (script.includes('server_version_num')) {
            stdout = '150019\n';
          } else if (script.includes('--file=')) {
            const sql = fs.readFileSync(
              path.join(context.root, 'proof.sql'),
              'utf8',
            );
            const records = [
              ...sql.matchAll(
                /SELECT '(NINA_TRAINING_PG_V1\|[^']+)' AS proof_record;/g,
              ),
            ].map((match) => match[1]);
            assert.equal(records.length, 15);
            stdout = `${(malformedReceipt ? records.slice(1) : records).join('\n')}\n`;
          } else {
            assert.ok(script.includes('pg_isready'));
            stdout = '';
          }
        } else if (args[0] === 'inspect' && args.includes('--format')) {
          stdout = JSON.stringify(
            containerObservation(context, started ? 'running' : 'created'),
          );
        } else if (args[0] === 'network' && args[1] === 'inspect') {
          if (!networkCreated)
            throw Object.assign(new Error('Synthetic owned network absent'), {
              status: 1,
              stderr: `Error: No such network: ${args.at(-1)}`,
            });
          const observation = isolationNetwork(
            context,
            started ? 'running' : 'created',
          );
          stdout = args.includes('--format')
            ? JSON.stringify(observation)
            : JSON.stringify([
                {
                  Id: networkId,
                  Name: context.name,
                  Driver: 'bridge',
                  Internal: true,
                  Labels: context.labels,
                  Containers: {},
                },
              ]);
        } else if (args[0] === 'inspect') {
          if (!containerCreated)
            throw Object.assign(new Error('Synthetic owned container absent'), {
              status: 1,
              stderr: `Error: No such object: ${args.at(-1)}`,
            });
          stdout = JSON.stringify([
            {
              Id: containerId,
              Name: `/${context.name}`,
              Image: IMAGE_ID,
              Config: { Labels: context.labels },
            },
          ]);
        } else if (args[0] === 'rm' && args[1] === '-f') {
          assert.equal(args.at(-1), containerId);
          containerCreated = false;
          started = false;
          stdout = '';
        } else if (args[0] === 'network' && args[1] === 'rm') {
          assert.equal(args.at(-1), networkId);
          assert.equal(containerCreated, false);
          networkCreated = false;
          stdout = '';
        } else {
          throw new Error('Unrecognized synthetic Docker command');
        }
        return options.preserveStdout === true ? stdout : stdout.trim();
      } catch (error) {
        const expectedAbsence =
          error?.status === 1 &&
          (error.stderr === `Error: No such object: ${containerId}` ||
            error.stderr === `Error: No such network: ${networkId}`);
        if (!expectedAbsence) failure = error;
        throw error;
      }
    },
  };
  return transport;
}

function removeSyntheticRecoveryRoot(context) {
  if (!context || !fs.existsSync(context.root)) return;
  const rootStat = fs.lstatSync(context.root);
  assert.equal(rootStat.isSymbolicLink(), false);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.mode & 0o777, 0o700);
  assert.equal(path.dirname(context.root), os.tmpdir());
  assert.ok(path.basename(context.root).startsWith('nina-training-postgres-'));
  fs.rmSync(context.root, { recursive: true, force: true });
}

it('exports an import-inert runner with no public execution injection', () => {
  const harness = createHarness();
  const runtime = loadRuntime(harness);
  assert.equal(typeof runtime.runTrainingAccountPostgresProof, 'function');
  assert.deepEqual(harness.events, []);
  assert.equal(runtime.runTrainingAccountPostgresProof.length, 0);
});

it('owns the fixed proof sequence, sanitized environment, and finalizer outcome', async () => {
  const harness = createHarness();
  const runtime = loadRuntime(harness);
  const result = await runtime.runTrainingAccountPostgresProof({
    signal: harness.controller.signal,
  });

  assert.equal(result.passed, true);
  assert.equal(result.proofSucceeded, true);
  assert.equal(Object.isFrozen(result), true);
  const firstCreatePlan = harness.events.indexOf('plan:create_network');
  const firstCapture = harness.events.indexOf('capture:network:start');
  assert.ok(firstCreatePlan < firstCapture);
  assert.ok(
    harness.events.indexOf('fixture:end') <
      harness.events.indexOf('plan:create_network'),
  );
  assert.ok(
    harness.events.indexOf('run:run_assertions:end') <
      harness.events.indexOf('finalize:start'),
  );
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith('validate:isolation:')),
    ['validate:isolation:created', 'validate:isolation:running'],
  );
  const assertion = harness.calls.find(
    (call) => call.action === 'run_assertions',
  );
  assert.equal(assertion.options.preserveStdout, true);
  assert.equal(assertion.options.timeout, 35_000);
  const cleanup = harness.calls.find((call) => call.action === 'cleanup');
  assert.equal(cleanup.command, '/usr/bin/docker');
  assert.deepEqual(cleanup.args.slice(0, 2), ['--host', DOCKER_HOST]);
  assert.equal(cleanup.options.timeout, 5000);
  assert.equal(cleanup.options.signal, undefined);
  for (const call of harness.calls) {
    assert.equal(call.command, '/usr/bin/docker');
    assert.deepEqual(JSON.parse(JSON.stringify(call.options.env)), {
      PATH: '/usr/bin:/bin',
      HOME: harness.context.root,
      TMPDIR: harness.context.root,
      LC_ALL: 'C',
    });
    assert.equal(Object.hasOwn(call.options.env, 'DOCKER_HOST'), false);
  }
  assert.doesNotMatch(
    JSON.stringify(harness.events),
    /credential-marker|password-marker/,
  );
});

it('composes the real fixture, planner, validators, receipt parser, and recovery with only Docker transport doubled', async (t) => {
  const transport = createRealCollaboratorTransport();
  t.after(() => removeSyntheticRecoveryRoot(transport.context));
  const runtime = loadRuntimeWithRealCollaborators(transport);
  const result = await runtime.runTrainingAccountPostgresProof();

  assert.equal(transport.failure, null);
  assert.equal(
    result.passed,
    true,
    JSON.stringify({
      result,
      recoveryError: transport.recoveryError?.message,
      contextCreations: transport.contextCreations,
      calls: transport.calls.length,
      contextRoot: transport.context?.root,
      transportFailure: transport.failure?.message,
    }),
  );
  assert.equal(result.proofSucceeded, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.recoveryRetained, false);
  assert.equal(transport.resourcesGone, true);
  assert.equal(transport.calls.length, 18);
  const commandOrder = transport.calls.map(({ args }) => {
    if (args[0] === 'exec') {
      const script = args.at(-1);
      if (script.includes('pg_isready')) return 'wait_ready';
      if (script.includes('server_version_num')) return 'server_version';
      return 'run_assertions';
    }
    if (args[0] === 'network' && args[1] === 'inspect')
      return args.includes('--format')
        ? 'inspect_network_proof'
        : 'inspect_network_cleanup';
    if (args[0] === 'inspect')
      return args.includes('--format')
        ? 'inspect_container_proof'
        : 'inspect_container_cleanup';
    if (args[0] === 'network' && args[1] === 'create') return 'create_network';
    if (args[0] === 'network' && args[1] === 'rm') return 'remove_network';
    if (args[0] === 'image') return 'inspect_image';
    if (args[0] === 'create') return 'create_container';
    if (args[0] === 'start') return 'start_container';
    if (args[0] === 'rm') return 'remove_container';
    throw new Error('Unexpected command in real-collaborator integration');
  });
  assert.deepEqual(commandOrder, [
    'inspect_image',
    'create_network',
    'inspect_network_proof',
    'create_container',
    'inspect_container_proof',
    'inspect_network_proof',
    'start_container',
    'inspect_container_proof',
    'inspect_network_proof',
    'wait_ready',
    'server_version',
    'run_assertions',
    'inspect_container_cleanup',
    'remove_container',
    'inspect_container_cleanup',
    'inspect_network_cleanup',
    'remove_network',
    'inspect_network_cleanup',
  ]);
  assert.ok(
    transport.calls.every(({ options }) => Number.isInteger(options.timeout)),
  );
  assert.equal(fs.existsSync(transport.context.root), false);
  assert.doesNotMatch(
    JSON.stringify(transport.calls),
    /password-marker|credential-marker/,
  );
  const malformedTransport = createRealCollaboratorTransport({
    malformedReceipt: true,
  });
  t.after(() => removeSyntheticRecoveryRoot(malformedTransport.context));
  const malformedRuntime = loadRuntimeWithRealCollaborators(malformedTransport);
  const malformedResult =
    await malformedRuntime.runTrainingAccountPostgresProof();
  const root = malformedTransport.context.root;

  assert.equal(malformedTransport.failure, null);
  assert.equal(malformedResult.passed, false);
  assert.equal(malformedResult.proofSucceeded, false);
  assert.equal(malformedResult.cleanupConfirmed, true);
  assert.equal(malformedResult.recoveryRetained, true);
  assert.equal(malformedTransport.resourcesGone, true);
  assert.ok(
    malformedResult.diagnostics.some(
      (diagnostic) => diagnostic.stage === 'proof_validation',
    ),
  );
  assert.deepEqual(fs.readdirSync(root).sort(), [
    'postgres.env',
    'proof.sql',
    'recovery.json',
  ]);
});

it('rejects unsupported platforms and server versions without claiming proof', async () => {
  for (const [configuration, expectedStage] of [
    [{ platform: 'darwin' }, 'image_inspect'],
    [{ arch: 'arm' }, 'image_inspect'],
    [{ serverVersion: '150008\n150009\n' }, 'server_version'],
    [{ serverVersion: '160000\n' }, 'server_version'],
    [{ stdout: 'invalid receipt', failAt: 'parse' }, 'proof_validation'],
  ]) {
    const harness = createHarness(configuration);
    const runtime = loadRuntime(harness);
    const result = await runtime.runTrainingAccountPostgresProof({
      signal: harness.controller.signal,
    });
    assert.equal(result.passed, false);
    assert.equal(result.proofSucceeded, false);
    assert.ok(harness.events.includes(`failure:${expectedStage}`));
  }
});

it('waits for every failed proof stage before finalizing without claiming proof', async () => {
  for (const [action, stage] of [
    ['inspect_image', 'image_inspect'],
    ['create_network', 'network_create'],
    ['inspect_network', 'resource_inspect'],
    ['create_container', 'container_create'],
    ['inspect_container', 'resource_inspect'],
    ['start_container', 'container_start'],
    ['wait_ready', 'readiness'],
    ['server_version', 'server_version'],
    ['run_assertions', 'sql_assertion'],
  ]) {
    const harness = createHarness({ failAt: action });
    const runtime = loadRuntime(harness);
    const result = await runtime.runTrainingAccountPostgresProof();
    assert.equal(result.passed, false, action);
    assert.equal(result.proofSucceeded, false, action);
    assert.ok(harness.events.includes(`failure:${stage}`), action);
    assert.ok(
      harness.events.lastIndexOf(`run:${action}:end`) <
        harness.events.indexOf('finalize:start'),
      action,
    );
  }
});

it('settles fixture preparation before cancellation cleanup and never creates resources', async () => {
  const harness = createHarness({ delayFixture: true });
  const runtime = loadRuntime(harness);
  const proof = runtime.runTrainingAccountPostgresProof({
    signal: harness.controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.controller.abort();
  harness.fixtureRelease();
  const result = await proof;
  assert.equal(result.passed, false);
  assert.ok(
    harness.events.indexOf('fixture:end') <
      harness.events.indexOf('finalize:start'),
  );
  assert.equal(
    harness.events.some((event) => event.startsWith('capture:')),
    false,
  );
});

it('waits for a cancelled child to settle before independent cleanup', async () => {
  const harness = createHarness({ delayAction: 'server_version' });
  const runtime = loadRuntime(harness);
  const proof = runtime.runTrainingAccountPostgresProof({
    signal: harness.controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  while (!harness.delayedRunRelease)
    await new Promise((resolve) => setImmediate(resolve));
  harness.controller.abort();
  harness.delayedRunRelease();
  const result = await proof;
  assert.equal(result.passed, false);
  assert.ok(
    harness.events.indexOf('run:server_version:end') <
      harness.events.indexOf('finalize:start'),
  );
  const cleanup = harness.calls.find((call) => call.action === 'cleanup');
  assert.equal(cleanup.options.signal, undefined);
  assert.equal(cleanup.options.timeout, 5000);
});

it('rechecks cancellation after receipt parsing and preserves cleanup failure outcome', async () => {
  const cancelled = createHarness({ abortDuringParse: true });
  const cancelRuntime = loadRuntime(cancelled);
  const cancelledResult = await cancelRuntime.runTrainingAccountPostgresProof({
    signal: cancelled.controller.signal,
  });
  assert.equal(cancelledResult.passed, false);
  assert.equal(cancelledResult.proofSucceeded, false);

  const cleanupFailure = createHarness({ cleanupConfirmed: false });
  const cleanupRuntime = loadRuntime(cleanupFailure);
  const result = await cleanupRuntime.runTrainingAccountPostgresProof();
  assert.equal(result.passed, false);
  assert.equal(result.proofSucceeded, true);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.recoveryRetained, true);
});
