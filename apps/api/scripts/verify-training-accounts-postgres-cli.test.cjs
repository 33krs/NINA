'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const cliPath = path.join(
  __dirname,
  'verify-training-accounts-postgres-cli.cjs',
);
const cliSource = fs.readFileSync(cliPath, 'utf8');
const runtimePath = './training-accounts-postgres-runtime.cjs';
const cancellationPath = './verify-odontogram-postgres.cjs';

function makeProcess(argv = ['node', cliPath]) {
  const fake = new EventEmitter();
  fake.argv = argv;
  fake.exitCode = undefined;
  fake.stdout = {
    text: '',
    write(value) {
      this.text += value;
      return true;
    },
  };
  fake.stderr = {
    text: '',
    write(value) {
      this.text += value;
      return true;
    },
  };
  return fake;
}

function loadCli({
  dependencies = {},
  processObject = makeProcess(),
  main = false,
} = {}) {
  const moduleObject = { exports: {} };
  const loads = [];
  const localRequire = (request) => {
    loads.push(request);
    if (Object.hasOwn(dependencies, request)) return dependencies[request];
    return require(request);
  };
  localRequire.main = main ? moduleObject : undefined;
  vm.runInNewContext(
    cliSource,
    {
      module: moduleObject,
      exports: moduleObject.exports,
      require: localRequire,
      process: processObject,
    },
    { filename: cliPath },
  );
  return { api: moduleObject.exports, processObject, loads };
}

function executionDependencies(run) {
  const loads = [];
  const controller = new AbortController();
  let exitCode;
  return {
    loads,
    dependencies: {
      [runtimePath]: {
        runTrainingAccountPostgresProof: run,
      },
      [cancellationPath]: {
        createCancellation() {
          return {
            signal: controller.signal,
            request(signal) {
              if (!exitCode) {
                exitCode = signal === 'SIGINT' ? 130 : 143;
                controller.abort();
              }
            },
            get exitCode() {
              return exitCode;
            },
          };
        },
      },
    },
  };
}

function passingOutcome(overrides = {}) {
  return {
    passed: true,
    proofSucceeded: true,
    cleanupConfirmed: true,
    recoveryRetained: false,
    diagnostics: [],
    ...overrides,
  };
}

test('import is inert and does not load runtime or register signal listeners', () => {
  const before = {
    interrupt: process.listeners('SIGINT'),
    terminate: process.listeners('SIGTERM'),
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    assert.notEqual(request, runtimePath);
    assert.notEqual(request, cancellationPath);
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[cliPath];
    const imported = require(cliPath);
    assert.equal(typeof imported.main, 'function');
  } finally {
    Module._load = originalLoad;
    delete require.cache[cliPath];
  }
  assert.deepEqual(process.listeners('SIGINT'), before.interrupt);
  assert.deepEqual(process.listeners('SIGTERM'), before.terminate);
});

test('no arguments and sole help return fixed help without dependency loading', async () => {
  for (const args of [undefined, ['--help']]) {
    const processObject = makeProcess();
    const { api } = loadCli({ processObject });
    const code = args === undefined ? await api.main() : await api.main(args);
    assert.equal(code, 0);
    assert.match(processObject.stdout.text, /Usage:/);
    assert.equal(processObject.stderr.text, '');
  }
});

test('rejects unsupported, duplicate, mixed, non-string, and hostile arguments before loading dependencies', async () => {
  const throwingArguments = new Proxy(['--help'], {
    get() {
      throw new Error('SENSITIVE_PROXY_VALUE');
    },
  });
  const revokedArguments = Proxy.revocable([], {});
  revokedArguments.revoke();
  const cases = [
    ['--unknown'],
    ['--run-isolated', '--run-isolated'],
    ['--help', '--run-isolated'],
    ['--run-isolated', '--help'],
    [null],
    [new String('--help')],
    ['--help\nSENSITIVE_VALUE'],
    throwingArguments,
    revokedArguments.proxy,
  ];
  for (const args of cases) {
    const processObject = makeProcess();
    const { api, loads } = loadCli({ processObject });
    assert.equal(await api.main(args), 2);
    assert.equal(processObject.stdout.text, '');
    assert.match(processObject.stderr.text, /Usage:/);
    assert.doesNotMatch(processObject.stderr.text, /SENSITIVE_VALUE|--unknown/);
    assert.deepEqual(loads, []);
  }
});

test('only explicit isolated execution lazily loads collaborators and awaits runtime', async () => {
  const processObject = makeProcess();
  const called = [];
  const fixture = executionDependencies(async ({ signal }) => {
    called.push(signal instanceof AbortSignal);
    return passingOutcome();
  });
  const { api } = loadCli({
    dependencies: fixture.dependencies,
    processObject,
  });
  assert.equal(processObject.stdout.text, '');
  assert.deepEqual(called, []);
  assert.equal(await api.main(['--run-isolated']), 0);
  assert.deepEqual(called, [true]);
  assert.equal(
    processObject.stdout.text,
    [
      'TRAINING_POSTGRES_PROOF_STATUS=passed',
      'passed=true',
      'proof_succeeded=true',
      'cleanup_confirmed=true',
      'recovery_retained=false',
      '',
    ].join('\n'),
  );
});

test('only the strictly consistent proof and cleanup state returns success', async () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const booleans = {
      passed: Boolean(mask & 1),
      proofSucceeded: Boolean(mask & 2),
      cleanupConfirmed: Boolean(mask & 4),
      recoveryRetained: Boolean(mask & 8),
    };
    const processObject = makeProcess();
    const fixture = executionDependencies(async () => passingOutcome(booleans));
    const { api } = loadCli({
      dependencies: fixture.dependencies,
      processObject,
    });
    const code = await api.main(['--run-isolated']);
    const shouldPass = mask === 7;
    assert.equal(code, shouldPass ? 0 : 1, JSON.stringify(booleans));
    assert.match(
      processObject.stdout.text,
      new RegExp(`STATUS=${shouldPass ? 'passed' : 'failed'}`),
    );
  }
});

test('malformed results and throwing getters produce a fixed failure without leaking data', async () => {
  const hostile = 'SENSITIVE_PATH_AND_PASSWORD';
  const outcomes = [
    null,
    'raw diagnostic ' + hostile,
    { ...passingOutcome(), passed: 'yes' },
    ...['passed', 'proofSucceeded', 'cleanupConfirmed', 'recoveryRetained'].map(
      (field) =>
        Object.defineProperty({}, field, {
          get() {
            throw new Error(hostile);
          },
        }),
    ),
  ];
  for (const outcome of outcomes) {
    const processObject = makeProcess();
    const fixture = executionDependencies(async () => outcome);
    const { api } = loadCli({
      dependencies: fixture.dependencies,
      processObject,
    });
    assert.equal(await api.main(['--run-isolated']), 1);
    assert.match(
      processObject.stdout.text,
      /^TRAINING_POSTGRES_PROOF_FAILED\n$/,
    );
    assert.doesNotMatch(
      processObject.stdout.text + processObject.stderr.text,
      /SENSITIVE_PATH_AND_PASSWORD|raw diagnostic/,
    );
  }
});

test('runtime load failures and rejections remain generic unknown outcomes', async () => {
  const processObject = makeProcess();
  const { api } = loadCli({
    processObject,
    dependencies: {
      [cancellationPath]: {
        createCancellation: () => ({
          signal: new AbortController().signal,
          request() {},
        }),
      },
      [runtimePath]: {
        get runTrainingAccountPostgresProof() {
          throw new Error('SECRET');
        },
      },
    },
  });
  assert.equal(await api.main(['--run-isolated']), 1);
  assert.equal(processObject.stdout.text, 'TRAINING_POSTGRES_PROOF_FAILED\n');
  assert.doesNotMatch(processObject.stdout.text, /SECRET/);

  const rejectedProcess = makeProcess();
  const fixture = executionDependencies(async () => {
    throw new Error('SECRET_REJECTION');
  });
  const rejected = loadCli({
    dependencies: fixture.dependencies,
    processObject: rejectedProcess,
  });
  assert.equal(await rejected.api.main(['--run-isolated']), 1);
  assert.equal(rejectedProcess.stdout.text, 'TRAINING_POSTGRES_PROOF_FAILED\n');
  assert.doesNotMatch(rejectedProcess.stdout.text, /SECRET_REJECTION/);
});

test('diagnostics are not serialized or exposed', async () => {
  const secret = 'NO_DIAGNOSTIC_SECRET';
  const processObject = makeProcess();
  const fixture = executionDependencies(async () =>
    passingOutcome({
      diagnostics: [{ path: secret, error: new Error(secret) }],
    }),
  );
  const { api } = loadCli({
    dependencies: fixture.dependencies,
    processObject,
  });
  assert.equal(await api.main(['--run-isolated']), 0);
  assert.doesNotMatch(
    processObject.stdout.text + processObject.stderr.text,
    /NO_DIAGNOSTIC_SECRET/,
  );
});

test('signals preserve first exit code, wait for runtime cleanup, and restore existing listeners', async () => {
  for (const [firstSignal, secondSignal, expectedCode] of [
    ['SIGINT', 'SIGTERM', 130],
    ['SIGTERM', 'SIGINT', 143],
  ]) {
    const processObject = makeProcess();
    const existingInt = () => {};
    const existingTerm = () => {};
    processObject.on('SIGINT', existingInt);
    processObject.on('SIGTERM', existingTerm);
    const beforeInt = processObject.listeners('SIGINT');
    const beforeTerm = processObject.listeners('SIGTERM');
    let resolveRuntime;
    let returned = false;
    const fixture = executionDependencies(
      () =>
        new Promise((resolve) => {
          resolveRuntime = resolve;
        }),
    );
    const { api } = loadCli({
      dependencies: fixture.dependencies,
      processObject,
    });
    const result = api.main(['--run-isolated']).then((value) => {
      returned = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    processObject.emit(firstSignal);
    processObject.emit(secondSignal);
    assert.equal(returned, false);
    resolveRuntime(passingOutcome());
    assert.equal(await result, expectedCode);
    assert.deepEqual(processObject.listeners('SIGINT'), beforeInt);
    assert.deepEqual(processObject.listeners('SIGTERM'), beforeTerm);
    assert.match(
      processObject.stdout.text,
      /^TRAINING_POSTGRES_PROOF_STATUS=cancelled\n/,
    );
    assert.doesNotMatch(processObject.stdout.text, /STATUS=passed/);
    assert.match(processObject.stdout.text, /cleanup_confirmed=true/);
  }
});

test('entrypoint wrapper assigns the awaited code without calling process.exit', async () => {
  const processObject = makeProcess(['node', cliPath, '--help']);
  const moduleObject = { exports: {} };
  const localRequire = (request) => require(request);
  localRequire.main = moduleObject;
  vm.runInNewContext(
    cliSource,
    {
      module: moduleObject,
      exports: moduleObject.exports,
      require: localRequire,
      process: processObject,
    },
    { filename: cliPath },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processObject.exitCode, 0);
  assert.match(processObject.stdout.text, /Usage:/);
});
