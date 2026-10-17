'use strict';

const { run, dockerArgs } = require('./verify-odontogram-postgres.cjs');
const {
  prepareTrainingAccountFixture,
} = require('./training-accounts-postgres-fixture.cjs');
const {
  createRecoveryContext,
  captureCreation,
  bindImageIdentity,
  reportFailure,
  finalizeRecovery,
} = require('./verify-training-accounts-postgres.cjs');
const {
  trainingAccountPostgresCommand,
} = require('./training-accounts-postgres-plan.cjs');
const {
  validateTrainingPostgresImage,
  validateTrainingPostgresNetwork,
  validateTrainingPostgresIsolation,
} = require('./training-accounts-postgres-observations.cjs');
const {
  parseTrainingAccountSqlReceipt,
} = require('./training-accounts-postgres-receipt.cjs');

const DOCKER = '/usr/bin/docker';
const TIMEOUT_MS = Object.freeze({
  ordinary: 15_000,
  readiness: 35_000,
  assertions: 35_000,
});

function safeResult(value) {
  if (value && typeof value === 'object') {
    return Object.freeze({
      passed: value.passed === true,
      proofSucceeded: value.proofSucceeded === true,
      cleanupConfirmed: value.cleanupConfirmed === true,
      recoveryRetained: value.recoveryRetained !== false,
      diagnostics: Object.freeze(
        Array.isArray(value.diagnostics) ? value.diagnostics : [],
      ),
    });
  }
  return Object.freeze({
    passed: false,
    proofSucceeded: false,
    cleanupConfirmed: false,
    recoveryRetained: true,
    diagnostics: Object.freeze([]),
  });
}

function cancelled(signal) {
  if (signal?.aborted) throw new Error('Training PostgreSQL proof cancelled');
}

function architecture() {
  if (process.platform !== 'linux')
    throw new Error('Unsupported host platform');
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error('Unsupported host architecture');
}

function serverVersion(stdout) {
  if (typeof stdout !== 'string' || !/^\d{6}\n?$/.test(stdout))
    throw new Error('Invalid PostgreSQL server version response');
  const value = Number(stdout.trim());
  if (!Number.isSafeInteger(value) || value < 150000 || value >= 160000)
    throw new Error('Unsupported PostgreSQL server version');
}

async function runTrainingAccountPostgresProof({ signal } = {}) {
  let context;
  try {
    context = createRecoveryContext();
  } catch {
    return safeResult();
  }
  const pending = new Set();
  const env = Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: context.root,
    TMPDIR: context.root,
    LC_ALL: 'C',
  });
  const execute = (args, options = {}) =>
    run(DOCKER, args, {
      cwd: context.root,
      env,
      timeout: options.timeout ?? TIMEOUT_MS.ordinary,
      signal: options.signal,
      preserveStdout: options.preserveStdout === true,
    });
  const track = (operation) => {
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const command = (fixture, operation, options = {}) => {
    cancelled(signal);
    const argv = trainingAccountPostgresCommand(context, fixture, operation);
    return track(() => execute(argv, { ...options, signal }));
  };
  let fixture;
  let stage = 'image_inspect';
  let proofSucceeded = false;
  try {
    cancelled(signal);
    const expectedArchitecture = architecture();
    stage = 'fixture_hash';
    fixture = await track(() =>
      prepareTrainingAccountFixture(context, { signal }),
    );
    cancelled(signal);

    stage = 'image_inspect';
    const imageJson = await command(fixture, 'inspect_image');
    cancelled(signal);
    const image = validateTrainingPostgresImage(
      imageJson,
      expectedArchitecture,
    );
    bindImageIdentity(context, image.imageId);

    stage = 'network_create';
    const networkArgs = trainingAccountPostgresCommand(
      context,
      fixture,
      'create_network',
    );
    await track(() =>
      captureCreation(
        context,
        'network',
        () => execute(networkArgs, { signal }),
        { signal },
      ),
    );
    cancelled(signal);

    stage = 'resource_inspect';
    const networkJson = await command(fixture, 'inspect_network');
    validateTrainingPostgresNetwork(context, networkJson, 'created');

    stage = 'container_create';
    const containerArgs = trainingAccountPostgresCommand(
      context,
      fixture,
      'create_container',
    );
    await track(() =>
      captureCreation(
        context,
        'container',
        () => execute(containerArgs, { signal }),
        { signal },
      ),
    );
    cancelled(signal);

    stage = 'resource_inspect';
    let containerJson = await command(fixture, 'inspect_container');
    let currentNetworkJson = await command(fixture, 'inspect_network');
    validateTrainingPostgresIsolation(
      context,
      containerJson,
      currentNetworkJson,
      'created',
    );

    stage = 'container_start';
    await command(fixture, 'start_container');
    cancelled(signal);

    stage = 'resource_inspect';
    containerJson = await command(fixture, 'inspect_container');
    currentNetworkJson = await command(fixture, 'inspect_network');
    validateTrainingPostgresIsolation(
      context,
      containerJson,
      currentNetworkJson,
      'running',
    );

    stage = 'readiness';
    await command(fixture, 'wait_ready', { timeout: TIMEOUT_MS.readiness });
    cancelled(signal);

    stage = 'server_version';
    const version = await command(fixture, 'server_version');
    serverVersion(version);
    cancelled(signal);

    stage = 'sql_assertion';
    const stdout = await command(fixture, 'run_assertions', {
      timeout: TIMEOUT_MS.assertions,
      preserveStdout: true,
    });
    cancelled(signal);

    stage = 'proof_validation';
    parseTrainingAccountSqlReceipt(stdout, context.runId, 0);
    cancelled(signal);
    proofSucceeded = true;
  } catch (error) {
    try {
      await reportFailure(context, stage, error);
    } catch {
      // Diagnostics are best-effort and must not replace the fixed safe result.
    }
  }

  await Promise.allSettled([...pending]);
  let finalized;
  try {
    finalized = await finalizeRecovery(context, {
      execute: (args, options = {}) =>
        track(() =>
          execute(dockerArgs(args), {
            timeout: options.timeout ?? 5_000,
            signal: undefined,
          }),
        ),
      proofSucceeded: proofSucceeded && !signal?.aborted,
    });
  } catch {
    return safeResult();
  }
  return safeResult(finalized);
}

module.exports = { runTrainingAccountPostgresProof };
