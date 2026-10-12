const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const {
  run,
  dockerArgs,
  createCancellation,
} = require('./verify-odontogram-postgres.cjs');
const {
  createRedisFixture,
  IMAGE,
  IMAGE_ID,
} = require('./pharmacy-redis-runner-fixture.cjs');
const { validateRedisProof } = require('./verify-pharmacy-redis-runtime.cjs');
const {
  createResourceTracker,
  captureCreation,
  reconcileResources,
} = require('./pharmacy-redis-resources.cjs');
const CHILD_PASS =
  'PHARMACY_REDIS_SCENARIOS_PASSED redis_major=7 lease_ms=10000';
const OUTPUT_CONTRACT_FAILURE = Symbol('scenario output contract failure');
const SAFE_ERROR_CODES = new Set([
  'EACCES',
  'EADDRINUSE',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EPIPE',
  'ENOBUFS',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'ETIMEDOUT',
]);
const SAFE_CHILD_PHASES = new Set([
  'proof_read',
  'container_inspect',
  'network_inspect',
  'proof_validate',
  'adapter_load',
  'client_setup',
  'lease',
  'cleanup',
]);
const SAFE_CHILD_CHECKPOINTS = new Set([
  'proof_input',
  'container_inspect',
  'network_inspect',
  'proof_validation',
  'adapter_resolution',
  'client_setup',
  'lease',
  'client_cleanup',
  'client_connect',
  'command_options',
  'redis_version',
  'owner_tokens',
  'fresh_key',
  'first_acquire',
  'competing_acquire',
  'initial_owner',
  'first_lease_ttl',
  'wrong_owner_release',
  'owner_after_wrong_release',
  'owner_release',
  'key_after_owner_release',
  'natural_acquire',
  'natural_deadline',
  'natural_ttl',
  'natural_owner',
  'natural_expiry_duration',
  'successor_acquire',
  'stale_owner_release',
  'successor_after_stale_release',
  'successor_release',
  'key_after_successor_release',
]);
const SAFE_CHILD_CATEGORIES = new Set([
  'assertion_failed',
  'operation_failed',
  'cleanup_failed',
]);
const SAFE_CHILD_VALUES = new Set([
  'redis7',
  'other_version',
  'missing',
  'occupied',
  'true',
  'false',
  'owner_match',
  'owner_missing',
  'owner_other',
  'owner_match_or_missing',
  'ttl_below_min',
  'ttl_in_range',
  'ttl_expired',
  'ttl_invalid',
  'ttl_over_max',
  'before_deadline',
  'deadline_reached',
  'duration_sufficient',
  'duration_short',
  'unavailable',
  'success',
  'failed',
  'fulfilled',
]);

function parseChildDiagnostic(error) {
  if (typeof error?.stderr !== 'string' || error.stderr.length > 2048)
    return [];
  const lines = error.stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('PHARMACY_REDIS_DIAGNOSTIC '));
  if (lines.length < 1 || lines.length > 2) return [];
  const diagnostics = [];
  for (const line of lines) {
    const match =
      /^PHARMACY_REDIS_DIAGNOSTIC phase=([a-z_]+) checkpoint=([a-z_]+) category=([a-z_]+) actual=([a-z0-9_]+) expected=([a-z0-9_]+)$/.exec(
        line,
      );
    if (!match) return [];
    const [, phase, checkpoint, category, actual, expected] = match;
    if (
      !SAFE_CHILD_PHASES.has(phase) ||
      !SAFE_CHILD_CHECKPOINTS.has(checkpoint) ||
      !SAFE_CHILD_CATEGORIES.has(category) ||
      !SAFE_CHILD_VALUES.has(actual) ||
      !SAFE_CHILD_VALUES.has(expected)
    )
      return [];
    diagnostics.push({ phase, checkpoint, category, actual, expected });
  }
  return diagnostics;
}

function reportStageFailure(stage, error) {
  let reason = 'operation_failed';
  let details = '';
  if (stage === 'scenario_child' && error?.[OUTPUT_CONTRACT_FAILURE]) {
    reason = 'output_contract';
    details =
      ' phase=scenario_child checkpoint=completion_marker category=output_contract actual=unexpected_output expected=success_marker';
  } else if (stage === 'scenario_child') {
    const diagnostics = parseChildDiagnostic(error);
    if (
      Number.isInteger(error?.status) &&
      error.status >= 0 &&
      error.status <= 255
    )
      reason = `child_exit_${error.status}`;
    else if (SAFE_ERROR_CODES.has(error?.code))
      reason = `node_code_${error.code}`;
    if (diagnostics.length) {
      const format = (diagnostic) =>
        ` phase=${diagnostic.phase} checkpoint=${diagnostic.checkpoint} category=${diagnostic.category} actual=${diagnostic.actual} expected=${diagnostic.expected}`;
      details = diagnostics.map(format).join(' secondary:');
    }
  } else if (SAFE_ERROR_CODES.has(error?.code))
    reason = `node_code_${error.code}`;
  console.error(
    `PHARMACY_REDIS_STAGE_FAILED stage=${stage} reason=${reason}${details}`,
  );
}

async function waitForRedis(config, cancellation) {
  const adapter = path.resolve(
    __dirname,
    '../dist/modules/pharmacy/pharmacy-lock.service.js',
  );
  assert.equal(
    fs.realpathSync(adapter),
    adapter,
    'Canonical compiled adapter required',
  );
  const { createPharmacyRedis } = require(adapter);
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    cancellation.throwIfCancelled();
    const client = createPharmacyRedis(config.redisUrl);
    try {
      await client.connect();
      assert.equal(
        await client.withCommandOptions({ timeout: 1500 }).ping(),
        'PONG',
      );
      cancellation.throwIfCancelled();
      return;
    } catch {
      cancellation.throwIfCancelled();
    } finally {
      if (client.isOpen) client.destroy();
    }
    await pause(100, undefined, { signal: cancellation.signal });
  }
  throw Error('Owned Redis readiness timed out');
}

async function main(args = process.argv.slice(2)) {
  try {
    assert.ok(
      args.length === 1 && args[0] === '--isolated',
      'Explicit isolated Redis opt-in required',
    );
    assert.ok(
      typeof process.getuid === 'function' && process.getuid() > 0,
      'Unprivileged Unix runner required',
    );
  } catch (error) {
    reportStageFailure('preflight', error);
    throw error;
  }
  const fixture = createRedisFixture();
  const { root, runId, redactions, environment } = fixture;
  const cancellation = createCancellation();
  const onInt = () => cancellation.request('SIGINT');
  const onTerm = () => cancellation.request('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timer = setTimeout(onTerm, 600000);
  const docker = (args) =>
    run('/usr/bin/docker', dockerArgs(args), {
      env: environment,
      timeout: 15000,
      signal: cancellation.signal,
      guard: cancellation.throwIfCancelled,
      redactions,
    });
  let tracker;
  let networkId;
  let containerId;
  let failure;
  let stage = 'image_inspect';
  try {
    assert.equal(
      await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]),
      IMAGE_ID,
      'Pinned cached Redis image required; pulls disabled',
    );
    tracker = createResourceTracker({ runId, imageId: IMAGE_ID, root });
    cancellation.throwIfCancelled();
    stage = 'network_create';
    networkId = await captureCreation(tracker, 'network', () =>
      docker(fixture.networkArgs()),
    );
    stage = 'container_create';
    containerId = await captureCreation(tracker, 'container', () =>
      docker(fixture.containerArgs()),
    );
    stage = 'container_start';
    await docker(['start', containerId]);
    stage = 'proof_write';
    const input = fixture.writeProof(containerId, networkId);
    stage = 'proof_validation';
    const inspect = async (args) => {
      const rows = JSON.parse(await docker(args));
      assert.ok(
        Array.isArray(rows) && rows.length === 1,
        'One owned Redis observation required',
      );
      return rows[0];
    };
    const config = validateRedisProof(input, {
      container: await inspect(['inspect', '--type', 'container', containerId]),
      network: await inspect(['network', 'inspect', networkId]),
    });
    stage = 'redis_readiness';
    await waitForRedis(config, cancellation);
    stage = 'scenario_child';
    const output = await run(
      process.execPath,
      [
        path.join(__dirname, 'verify-pharmacy-redis-scenarios.cjs'),
        `--run-id=${runId}`,
        `--proof-file=${input.proofFile}`,
      ],
      {
        env: environment,
        timeout: 60000,
        signal: cancellation.signal,
        guard: cancellation.throwIfCancelled,
        redactions,
      },
    );
    if (output !== CHILD_PASS) {
      const error = Error('Scenario child output contract mismatch');
      error[OUTPUT_CONTRACT_FAILURE] = true;
      throw error;
    }
  } catch (error) {
    reportStageFailure(stage, error);
    failure = Error('Isolated Redis verification failed');
  } finally {
    clearTimeout(timer);
    try {
      // All awaited creation/child processes have settled; cleanup has no aborted signal.
      if (tracker) await reconcileResources(tracker, { timeoutMs: 30000 });
      fixture.dispose();
      console.log(
        `PHARMACY_REDIS_CLEANUP_ASSERTED container_id=${containerId ?? 'none'} network_id=${networkId ?? 'none'}`,
      );
    } catch {
      failure = Error('Owned Redis cleanup failed');
      console.error(
        `PHARMACY_REDIS_RECOVERY_RETAINED run_id=${runId} directory=${root}`,
      );
    }
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (cancellation.exitCode) process.exitCode = cancellation.exitCode;
  }
  if (failure) throw failure;
  cancellation.throwIfCancelled();
  console.log(
    `PHARMACY_REDIS_SUITE_PASSED redis_major=7 lease_ms=10000 image_id=${IMAGE_ID}`,
  );
}

if (require.main === module)
  main().catch(() => {
    console.error('PHARMACY_REDIS_SUITE_FAILED');
    process.exitCode ||= 1;
  });
module.exports = { main };
